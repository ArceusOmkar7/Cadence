// Per-set quality checks. A set with any red flag is never saved silently as good: the app asks the user to keep or discard.
import type { AdcRec, ImuRec, PacketHeader } from './protocol';
import type { Flag, SetKind } from './types';

export const QUALITY = {
  /** a gap this long between IMU samples is an amber flag (the stream normally ticks every 5 ms) */
  gapAmberMs: 50,
  gapRedMs: 500,
  lossAmberPct: 0.5,
  lossRedPct: 5,
  /** counts at or beyond this are full scale on a signed 16-bit ADC or MPU */
  fullScale: 32700,
  /** more than this many full-scale samples in a set is a clipping flag */
  clipSamples: 2,
  /** a flex channel whose raw counts vary less than this (measured resting noise is 5-10 counts) is stuck or loose */
  flatSdCounts: 2,
  minImuSamples: 50,
};

export interface QualityInput {
  kind: SetKind;
  imu: ImuRec[];
  adc: AdcRec[];
  headers: PacketHeader[];
  /** finger name for hardware channels 0..4 (from finger_to_channel), for readable flags */
  channelNames: string[];
}

const span = (a: number[]): number => {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo + 1;
};

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

export function assessSet(inp: QualityInput): Flag[] {
  const Q = QUALITY;
  const flags: Flag[] = [];
  const add = (code: string, severity: 'amber' | 'red', detail: string) => flags.push({ code, severity, detail });
  const { imu, adc, headers } = inp;

  if (imu.length < Q.minImuSamples) {
    add('no_data', 'red', `only ${imu.length} motion samples arrived`);
    return flags;
  }
  // reboot: boot id changed, or a sequence counter went backwards
  const boots = new Set(headers.map((h) => h.bootId));
  let backwards = 0;
  for (let i = 1; i < imu.length; i++) if (imu[i].seq < imu[i - 1].seq) backwards++;
  if (boots.size > 1 || backwards > 0) add('reboot', 'red', 'the glove restarted during this set');

  // loss and gaps, from the glove's own sequence numbers and clock
  const seqs = imu.map((r) => r.seq);
  const expected = span(seqs);
  const lostPct = (100 * (expected - imu.length)) / expected;
  let maxGapMs = 0;
  for (let i = 1; i < imu.length; i++) maxGapMs = Math.max(maxGapMs, (imu[i].tUs - imu[i - 1].tUs) / 1000);
  if (lostPct > Q.lossRedPct) add('loss', 'red', `${lostPct.toFixed(1)}% of motion samples lost`);
  else if (lostPct > Q.lossAmberPct) add('loss', 'amber', `${lostPct.toFixed(1)}% of motion samples lost`);
  if (maxGapMs > Q.gapRedMs) add('gap', 'red', `longest gap ${Math.round(maxGapMs)} ms`);
  else if (maxGapMs > Q.gapAmberMs) add('gap', 'amber', `longest gap ${Math.round(maxGapMs)} ms`);
  if (adc.length > 20) {
    const a = adc.map((r) => r.seq);
    const adcLost = (100 * (span(a) - adc.length)) / span(a);
    if (adcLost > Q.lossRedPct) add('adc_loss', 'red', `${adcLost.toFixed(1)}% of flex/palm samples lost`);
    else if (adcLost > Q.lossAmberPct) add('adc_loss', 'amber', `${adcLost.toFixed(1)}% of flex/palm samples lost`);
  }
  if (headers.length > 1 && headers[headers.length - 1].dropped > headers[0].dropped)
    add('device_drop', 'amber', `the glove discarded ${headers[headers.length - 1].dropped - headers[0].dropped} records (buffer full)`);

  // clipping and saturation
  const clipped = imu.filter((r) => r.raw.some((v) => Math.abs(v) >= Q.fullScale)).length;
  if (clipped > Q.clipSamples) add('clipping', 'red', `${clipped} motion samples at full scale (the swing exceeded the sensor range)`);
  const sat = adc.filter((r) => Math.abs(r.raw) >= Q.fullScale).length;
  if (sat > Q.clipSamples) add('adc_saturation', 'red', `${sat} flex/palm samples at the ADC limit`);

  // a flex channel that never moves: loose wire or dead sensor (a resting hand still shows 5-10 counts of noise)
  for (let ch = 0; ch < 5; ch++) {
    const v = adc.filter((r) => r.channel === ch).map((r) => r.raw);
    if (v.length >= 100 && sd(v) < Q.flatSdCounts)
      add('flat_channel', inp.kind === 'idle' ? 'amber' : 'red', `${inp.channelNames[ch] ?? 'channel ' + ch} sensor reads a constant value (loose wire?)`);
  }
  return flags;
}

export const isRed = (flags: Flag[]): boolean => flags.some((f) => f.severity === 'red');
