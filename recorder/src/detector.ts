// Stroke event detector. Shared by the recorder (live) and later by inference: no DOM, no I/O, causal.
// "Causal" means every decision uses only samples already seen, so replaying a recording through it gives
// exactly the events the live run produced (see test/detector.test.ts and test/golden/).
//
// Input: gravity-removed hand-frame acceleration (g) and bias-corrected hand-frame rate (deg/s), as streamed by the
// glove, with the glove's own timestamps. Energy = smoothed sqrt((|gyro|/gyroScale)^2 + (|acc|/accelScale)^2).
// Logic: start tracking when energy passes highThreshold, follow the running maximum, emit when energy falls to
// endFraction of that maximum or maxAfterPeakMs after the peak, whichever comes first. The event time is the time of
// the maximum. After an event, new ones are ignored for refractoryMs (measured from the peak).
// Recovery rule: bringing the hand back to the ready position makes a second bump 0.4-0.7 s after the stroke. It swings the
// OPPOSITE way (measured on real strokes: gyro cosine -0.35 to -0.98 against the stroke, even when the bump is 60% of the stroke
// or bigger than a soft push) and it is usually smaller. A candidate within recoveryMs of the previous event is therefore dropped
// if its peak is below recoveryRatio times the previous peak, OR its swing direction (smoothed gyro at the peak) points against
// the previous event's by more than recoveryCos. A genuine second stroke in the same direction still counts.

export interface DetectorConfig {
  version: number;
  smoothingMs: number;
  gyroScaleDps: number;
  accelScaleG: number;
  highThreshold: number;
  endFraction: number;
  maxAfterPeakMs: number;
  refractoryMs: number;
  /** a candidate this soon after the previous event ... */
  recoveryMs: number;
  /** ... is dropped if its peak is below this fraction of the previous event's peak */
  recoveryRatio: number;
  /** ... or if the cosine between its swing direction and the previous event's is below this (e.g. -0.3: more than ~107 degrees apart) */
  recoveryCos: number;
  /** A gap longer than this is treated as this long when smoothing, so a data hole cannot swallow an event. */
  maxDtMs: number;
  windowPreMs: number;
  windowPostMs: number;
}

export interface DetectedEvent {
  /** glove time of the energy maximum, microseconds */
  tPeakUs: number;
  peakEnergy: number;
  /** glove time at which the event was emitted (>= tPeakUs): the earliest a live system could act */
  tDetectUs: number;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const na = Math.hypot(a[0], a[1], a[2]), nb = Math.hypot(b[0], b[1], b[2]);
  return na < 1e-6 || nb < 1e-6 ? 1 : (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb); // no direction known: do not drop
}

export function energyOf(cfg: DetectorConfig, gyro: ArrayLike<number>, acc: ArrayLike<number>): number {
  const g = Math.hypot(gyro[0], gyro[1], gyro[2]) / cfg.gyroScaleDps;
  const a = Math.hypot(acc[0], acc[1], acc[2]) / cfg.accelScaleG;
  return Math.hypot(g, a);
}

export class EventDetector {
  /** Smoothed energy after the latest sample. */
  energy = 0;
  private state: 'idle' | 'tracking' = 'idle';
  private tPrev = NaN;
  private maxE = 0;
  private tMax = 0;
  private lastPeakUs = -Infinity;
  private lastEventUs = -Infinity;
  private lastEventE = 0;
  private lastEventG: [number, number, number] = [0, 0, 0];
  private sg: [number, number, number] = [0, 0, 0]; // gyro smoothed like the energy
  private peakG: [number, number, number] = [0, 0, 0];

  constructor(readonly cfg: DetectorConfig) {}

  reset(): void {
    this.energy = 0;
    this.state = 'idle';
    this.tPrev = NaN;
    this.maxE = 0;
    this.tMax = 0;
    this.lastPeakUs = -Infinity;
    this.lastEventUs = -Infinity;
    this.lastEventE = 0;
    this.lastEventG = [0, 0, 0]; this.sg = [0, 0, 0]; this.peakG = [0, 0, 0];
  }

  /** Feed one sample; returns an event if this sample completed one. */
  push(tUs: number, gyro: ArrayLike<number>, acc: ArrayLike<number>): DetectedEvent | null {
    const c = this.cfg;
    const e = energyOf(c, gyro, acc);
    if (Number.isNaN(this.tPrev)) { this.energy = e; this.sg = [gyro[0], gyro[1], gyro[2]]; }
    else {
      const dtMs = Math.min(Math.max(0, (tUs - this.tPrev) / 1000), c.maxDtMs), k = 1 - Math.exp(-dtMs / c.smoothingMs);
      this.energy += k * (e - this.energy);
      for (let i = 0; i < 3; i++) this.sg[i] += k * (gyro[i] - this.sg[i]);
    }
    this.tPrev = tUs;
    const s = this.energy;
    if (this.state === 'idle') {
      if (s > c.highThreshold && tUs - this.lastPeakUs >= c.refractoryMs * 1000) {
        this.state = 'tracking';
        this.maxE = s;
        this.tMax = tUs;
        this.peakG = [...this.sg];
      }
      return null;
    }
    if (s > this.maxE) {
      this.maxE = s;
      this.tMax = tUs;
      this.peakG = [...this.sg];
    }
    if (s <= c.endFraction * this.maxE || tUs - this.tMax >= c.maxAfterPeakMs * 1000) {
      this.state = 'idle';
      this.lastPeakUs = this.tMax; // the refractory period counts from this peak whether or not it is kept
      if (this.tMax - this.lastEventUs < c.recoveryMs * 1000 && (this.maxE < c.recoveryRatio * this.lastEventE || cosine(this.peakG, this.lastEventG) < c.recoveryCos)) return null; // the hand returning, not a stroke
      this.lastEventUs = this.tMax; this.lastEventE = this.maxE; this.lastEventG = [...this.peakG];
      return { tPeakUs: this.tMax, peakEnergy: this.maxE, tDetectUs: tUs };
    }
    return null;
  }
}

/** Runs the detector over a finished recording (same code path as live). */
export function detectAll(
  cfg: DetectorConfig,
  samples: { tUs: number; gyroH: ArrayLike<number>; accH: ArrayLike<number> }[],
): DetectedEvent[] {
  const d = new EventDetector(cfg);
  const out: DetectedEvent[] = [];
  for (const s of samples) {
    const ev = d.push(s.tUs, s.gyroH, s.accH);
    if (ev) out.push(ev);
  }
  return out;
}

/** The window to cut around an event: windowPreMs before the peak, windowPostMs after (peak at 60% of 0.8 s). */
export function windowAround(cfg: DetectorConfig, tPeakUs: number): { startUs: number; endUs: number } {
  return { startUs: tPeakUs - cfg.windowPreMs * 1000, endUs: tPeakUs + cfg.windowPostMs * 1000 };
}

/** Samples of `all` (sorted by tUs) inside the window around tPeakUs. */
export function cutWindow<T extends { tUs: number }>(cfg: DetectorConfig, all: T[], tPeakUs: number): T[] {
  const w = windowAround(cfg, tPeakUs);
  return all.filter((s) => s.tUs >= w.startUs && s.tUs <= w.endUs);
}

/** Smoothed-energy trace of a recording, for plotting and for threshold suggestions. */
export function energyTrace(
  cfg: DetectorConfig,
  samples: { tUs: number; gyroH: ArrayLike<number>; accH: ArrayLike<number> }[],
): { tUs: number; e: number }[] {
  const d = new EventDetector({ ...cfg, highThreshold: Infinity });
  return samples.map((s) => {
    d.push(s.tUs, s.gyroH, s.accH);
    return { tUs: s.tUs, e: d.energy };
  });
}

/** Suggests a start threshold from energies recorded while idle (everything that is not a stroke): clearly above
 *  the 99.5th percentile of what idle movement produces, so walking and adjusting the grip do not trigger. */
export function suggestThreshold(idleEnergies: number[]): { p99: number; p995: number; max: number; suggested: number } | null {
  if (idleEnergies.length < 200) return null;
  const s = [...idleEnergies].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const p99 = at(0.99);
  const p995 = at(0.995);
  const suggested = Math.max(0.15, Math.round(p995 * 1.25 * 100) / 100);
  return { p99, p995, max: s[s.length - 1], suggested };
}
