// Parity of the browser's feature code and XGBoost evaluation with the Python that trained the model (fixtures from ml/export_compact.py).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CH, featsLive, sm } from '../src/ml/featuresLive';
import { predictProba, vectorFor, type CompactModel } from '../src/ml/xgb';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('smoothing', () => {
  it('matches the padded box filter of the Python (edge replicated, n>>1 left)', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const out = sm(x, 10);
    // python: np.convolve(np.pad(x,(5,4),'edge'), ones(10)/10, 'valid')
    const pad = [1, 1, 1, 1, 1, ...x, 12, 12, 12, 12];
    for (let i = 0; i < x.length; i++) expect(out[i]).toBeCloseTo(pad.slice(i, i + 10).reduce((a, b) => a + b, 0) / 10, 9);
  });
});

for (const post of [160, 320]) {
  describe(`model ${post} ms`, () => {
    const model = read(`../public/models/stroke_live${post}.json`) as CompactModel;
    const fx = read(`./fixtures/parity_${post}.json`);
    const n: number = fx.windows.length;

    it('XGBoost evaluation reproduces the Python probabilities from the Python features', () => {
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const x = Float64Array.from(model.features, (name) => fx.features[name][i]);
        const p = predictProba(model, x);
        fx.proba[i].forEach((v: number, k: number) => { worst = Math.max(worst, Math.abs(v - p[k])); });
      }
      expect(worst).toBeLessThan(1e-4);
    });

    it('the TypeScript features match the Python features', () => {
      let bad: string[] = [];
      for (let i = 0; i < n; i++) {
        const w = Float32Array.from((fx.windows[i] as number[][]).flatMap((r) => r.slice(0, CH)));
        const f = featsLive(w, fx.windows[i].length, post);
        for (const name of model.features) {
          const want = fx.features[name][i], got = f[name];
          if (!(Math.abs(got - want) <= 2e-3 * Math.max(1, Math.abs(want)))) bad.push(`${name}[${i}] ts=${got} py=${want}`);
        }
      }
      expect(bad.slice(0, 8)).toEqual([]);
    });

    it('end to end: probabilities from raw windows agree with Python', () => {
      let worst = 0, same = 0;
      for (let i = 0; i < n; i++) {
        const w = Float32Array.from((fx.windows[i] as number[][]).flatMap((r) => r.slice(0, CH)));
        const p = predictProba(model, vectorFor(model, featsLive(w, fx.windows[i].length, post)));
        const want: number[] = fx.proba[i];
        worst = Math.max(worst, ...want.map((v, k) => Math.abs(v - p[k])));
        if (p.indexOf(Math.max(...p)) === want.indexOf(Math.max(...want))) same++;
      }
      expect(same).toBe(n);
      expect(worst).toBeLessThan(0.05);
    });
  });
}

it('window rows have CH channels in the fixtures', () => {
  const fx = read('./fixtures/parity_160.json');
  expect(fx.windows[0][0].length).toBeGreaterThanOrEqual(CH);
});

// ---- the live window cut: warm-up, data holes, a clean stroke ----
import detectorJson from '../config/detector.json';
import type { DetectorConfig } from '../src/detector';
import { LiveClassifier, type LiveResult } from '../src/ml/liveClassifier';
import type { ImuRec } from '../src/protocol';

function stream(strokeAtS: number, holeFromS?: number, holeToS?: number): LiveResult[] {
  const model = (n: number) => read(`../public/models/stroke_live${n}.json`) as CompactModel;
  const lc = new LiveClassifier({ fast: model(160), accurate: model(320) }, detectorJson as DetectorConfig);
  const out: LiveResult[] = []; lc.onResult = (r) => out.push(r);
  for (let i = 0; i < 6 * 200; i++) {
    const t = i / 200;
    if (holeFromS !== undefined && t >= holeFromS && t < holeToS!) continue;
    const g = 700 * Math.exp(-(((t - strokeAtS) / 0.05) ** 2));
    const rec: ImuRec = { tUs: Math.round(t * 1e6) + 5_000_000, seq: i, raw: [], q: [1, 0, 0, 0], accH: [0, 0, 0.2 * g / 100], gyroH: [0, g, 0], curl: [], pressure: 0 };
    lc.push(rec, 1, 0);
  }
  return out;
}

describe('live window cut', () => {
  it('classifies a clean swing once, after the detector fires', () => {
    const r = stream(2.0);
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('ok');
    expect(r[0].probs!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
  it('skips a swing that comes before the window has 480 ms of history', () => {
    const r = stream(0.3);
    expect(r.map((x) => x.status)).toEqual(['warmup']);
  });
  it('rejects a window with a data hole near the peak', () => {
    const r = stream(2.0, 2.0, 2.06);
    expect(r.map((x) => x.status)).toEqual(['gap']);
  });
  it('tolerates a short hole far from the peak', () => {
    const r = stream(2.0, 1.65, 1.69);
    expect(r.map((x) => x.status)).toEqual(['ok']);
  });
});
