// Replays recorded sets through the live pipeline (detector -> window cut -> features -> XGBoost) and checks what the app would have said.
// Skipped when the dataset folder is not on this machine (it is git-ignored).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import detectorJson from '../config/detector.json';
import type { DetectorConfig } from '../src/detector';
import { LiveClassifier, type LiveResult, type Mode } from '../src/ml/liveClassifier';
import type { CompactModel } from '../src/ml/xgb';
import type { ImuRec } from '../src/protocol';

const root = new URL('../../dataset/20261025-172341/', import.meta.url);
const have = existsSync(new URL('derived.csv', root));
const model = (n: number) => JSON.parse(readFileSync(new URL(`../public/models/stroke_live${n}.json`, import.meta.url), 'utf8')) as CompactModel;

function rowsOf(setId: string): { rec: ImuRec; boot: number }[] {
  const lines = readFileSync(new URL('derived.csv', root), 'utf8').split('\n');
  const h = lines[0].split(','), ix = (n: string) => h.indexOf(n);
  const out: { rec: ImuRec; boot: number }[] = [];
  for (const l of lines.slice(1)) {
    if (!l.includes(setId)) continue;
    const c = l.split(',');
    if (c[ix('set_id')] !== setId) continue;
    const n = (k: string) => Number(c[ix(k)]);
    out.push({ boot: n('boot_id'), rec: { tUs: n('t_us'), seq: n('seq'), raw: [], q: [n('qw'), n('qx'), n('qy'), n('qz')], accH: [n('acc_x_g'), n('acc_y_g'), n('acc_z_g')], gyroH: [n('gyro_x_dps'), n('gyro_y_dps'), n('gyro_z_dps')], curl: [], pressure: 0 } });
  }
  return out;
}

function replay(setId: string, mode: Mode): LiveResult[] {
  const lc = new LiveClassifier({ fast: model(160), accurate: model(320) }, detectorJson as DetectorConfig);
  lc.mode = mode;
  const res: LiveResult[] = [];
  lc.onResult = (r) => res.push(r);
  for (const { rec, boot } of rowsOf(setId)) lc.push(rec, boot, 0);
  return res;
}
const count = (rs: LiveResult[]) => rs.reduce<Record<string, number>>((m, r) => { const k = r.status === 'ok' ? r.label! : r.status; m[k] = (m[k] ?? 0) + 1; return m; }, {});

describe.skipIf(!have)('live replay of recorded sets', () => {
  for (const mode of ['fast', 'accurate'] as Mode[]) {
    it(`${mode}: a with-ball backhand set is mostly backhand`, () => {
      const c = count(replay('20261025-172341-s7', mode)); console.log(mode, 's7 backhand', c);
      expect((c.backhand_drive ?? 0)).toBeGreaterThanOrEqual(8);
    });
    it(`${mode}: a with-ball push set is mostly push`, () => {
      const c = count(replay('20261025-172341-s16', mode)); console.log(mode, 's16 push', c);
      expect((c.push ?? 0)).toBeGreaterThanOrEqual(10);
    });
    it(`${mode}: an idle set gives few strokes`, () => {
      const rs = replay('20261025-172341-s17', mode); const c = count(rs); console.log(mode, 's17 idle', c);
      expect(rs.length).toBeLessThan(15);
    });
  }
});
