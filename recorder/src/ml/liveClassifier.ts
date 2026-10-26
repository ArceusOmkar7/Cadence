// Live stroke classification: the recorder's causal detector fires on a stroke candidate, then the window around the detector's
// peak is cut (peak at sample 96, 200 Hz, ending postMs later), turned into features and classified. Mirrors how the training
// windows were made (ml/segment2.py, "causal" rows): same detector rules, same hole rules, same features (featuresLive.ts).
import { EventDetector, type DetectedEvent, type DetectorConfig } from '../detector';
import { rollPitch, type ImuRec } from '../protocol';
import { CH, FS, PK, featsLive } from './featuresLive';
import { predictProba, vectorFor, type CompactModel } from './xgb';

export type Mode = 'fast' | 'accurate';
export type Status = 'ok' | 'gap' | 'warmup';

export interface LiveResult {
  id: number;
  tPeakUs: number;
  tDetectUs: number;
  /** glove time of the last sample used */
  tClassUs: number;
  /** wall clock when the result was produced */
  wallMs: number;
  /** the detector's smoothed energy at the peak (the stroke's intensity) */
  peakEnergy: number;
  status: Status;
  /** class probabilities in model.classes order (null unless status is ok) */
  probs: number[] | null;
  label: string | null;
  confidence: number;
  mode: Mode;
}

const MAX_BUF = 900;          // samples kept (4.5 s)
const HOLE_ANYWHERE_MS = 45;  // as in the training cut
const HOLE_CORE_MS = 12;      // a hole this long within +-150 ms of the peak spoils the window
const CORE = 30;

export class LiveClassifier {
  /** Smoothed detector energy after the latest sample (for a live meter). */
  get energy(): number { return this.detector.energy; }
  mode: Mode = 'fast';
  onResult: (r: LiveResult) => void = () => {};
  private detector: EventDetector;
  private t: number[] = []; private v: number[][] = [];  // v[i] = gx gy gz ax ay az roll pitch
  private pending: { id: number; ev: DetectedEvent }[] = [];
  private bootId = -1; private nextId = 1; private lastT = -Infinity;

  constructor(private readonly models: Record<Mode, CompactModel>, cfg: DetectorConfig) { this.detector = new EventDetector(cfg); }

  setDetector(cfg: DetectorConfig): void { this.detector = new EventDetector(cfg); this.pending = []; }
  reset(): void { this.t = []; this.v = []; this.pending = []; this.detector.reset(); this.lastT = -Infinity; }

  push(rec: ImuRec, bootId: number, wallMs: number = Date.now()): void {
    if (bootId !== this.bootId || rec.tUs <= this.lastT || rec.tUs - this.lastT > 2_000_000) { this.reset(); this.bootId = bootId; }
    this.lastT = rec.tUs;
    const [roll, pitch] = rollPitch(rec.q);
    this.t.push(rec.tUs);
    this.v.push([rec.gyroH[0], rec.gyroH[1], rec.gyroH[2], rec.accH[0], rec.accH[1], rec.accH[2], (roll * 180) / Math.PI, (pitch * 180) / Math.PI]);
    if (this.t.length > MAX_BUF + 100) { this.t.splice(0, 100); this.v.splice(0, 100); }
    const ev = this.detector.push(rec.tUs, rec.gyroH, rec.accH);
    if (ev) this.pending.push({ id: this.nextId++, ev });
    const post = this.models[this.mode].post_ms;
    while (this.pending.length && rec.tUs >= this.pending[0].ev.tPeakUs + post * 1000) {
      const p = this.pending.shift()!;
      this.onResult(this.classify(p.id, p.ev, rec.tUs, wallMs));
    }
  }

  private classify(id: number, ev: DetectedEvent, tNow: number, wallMs: number): LiveResult {
    const model = this.models[this.mode];
    const base: LiveResult = { id, tPeakUs: ev.tPeakUs, tDetectUs: ev.tDetectUs, tClassUs: tNow, wallMs, peakEnergy: ev.peakEnergy, status: 'ok', probs: null, label: null, confidence: 0, mode: this.mode };
    const rows = Math.min(PK + 1 + Math.trunc((model.post_ms * FS) / 1000), 160);
    const t0 = ev.tPeakUs - PK * 5000, t = this.t, v = this.v;
    if (t.length < 2 || t[0] > t0 || t[t.length - 1] < t0 + (rows - 1) * 5000) return { ...base, status: 'warmup' };
    const w = new Float64Array(rows * CH);
    let j = 0; // bracketing sample: t[j] <= grid time < t[j+1]
    while (j < t.length - 2 && t[j + 1] <= t0) j++;
    for (let k = 0; k < rows; k++) {
      const tk = t0 + k * 5000;
      while (j < t.length - 2 && t[j + 1] <= tk) j++;
      const holeMs = (t[j + 1] - t[j]) / 1000;
      if (holeMs > HOLE_ANYWHERE_MS || (Math.abs(k - PK) <= CORE && holeMs > HOLE_CORE_MS)) return { ...base, status: 'gap' };
      const a = (tk - t[j]) / (t[j + 1] - t[j]);
      for (let c = 0; c < CH; c++) w[k * CH + c] = v[j][c] + a * (v[j + 1][c] - v[j][c]);
    }
    const probs = predictProba(model, vectorFor(model, featsLive(w, rows, model.post_ms)));
    let best = 0; probs.forEach((p, i) => { if (p > probs[best]) best = i; });
    return { ...base, probs, label: model.classes[best], confidence: probs[best] };
  }
}
