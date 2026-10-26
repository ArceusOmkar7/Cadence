import { buildPacket } from '../server/wire.mjs';
import type { AdcRec, ImuRec } from '../src/protocol';

/** A synthetic IMU stream: noise floor plus stroke bursts (gyro/accel pulses) at the given times. */
export function makeImuStream(opts: {
  seconds: number; hz?: number; strokesAtS?: number[]; strokeGyroDps?: number; strokeAccG?: number; noiseDps?: number; t0Us?: number; seed?: number;
}): ImuRec[] {
  const hz = opts.hz ?? 200, t0 = opts.t0Us ?? 1_000_000;
  let s = opts.seed ?? 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const out: ImuRec[] = [];
  for (let i = 0; i < opts.seconds * hz; i++) {
    const t = i / hz;
    let burst = 0;
    for (const c of opts.strokesAtS ?? []) burst += Math.exp(-(((t - c) / 0.04) ** 2)); // ~100 ms wide pulse
    const n = opts.noiseDps ?? 3;
    const g = (opts.strokeGyroDps ?? 900) * burst, a = (opts.strokeAccG ?? 4) * burst;
    out.push({
      tUs: t0 + Math.round(t * 1e6), seq: i, raw: [0, 0, 2048, 0, 0, 0], q: [1, 0, 0, 0],
      accH: [a + 0.01 * rnd(), 0.01 * rnd(), 0.01 * rnd()], gyroH: [g + n * rnd(), n * rnd(), n * rnd()],
      curl: [0, 0, 0, 0, 0], pressure: 0,
    });
  }
  return out;
}

export function packetOf(imu: ImuRec[], adc: AdcRec[], packetSeq = 0, bootId = 7, dropped = 0): ArrayBuffer {
  const b = buildPacket({ packetSeq, bootId, dropped, tBaseUs: (imu[0]?.tUs ?? adc[0]?.tUs ?? 0), imu, adc });
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
