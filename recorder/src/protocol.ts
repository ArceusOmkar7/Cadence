// Parser for the glove's binary record packets. Mirrors lib/GloveRec/GloveRec.h and tools/glove_rec.py.
// Little-endian. One packet = 28 byte header + concatenated fixed-size records (type byte first).

export const HEADER_BYTES = 28;
export const IMU_BYTES = 85;
export const ADC_BYTES = 12;
export const MAGIC = 0xa5;
export const VERSION = 1;

export interface PacketHeader {
  packetSeq: number;
  bootId: number;
  /** Records the glove discarded since boot because its ring buffer was full. */
  dropped: number;
  /** Unwrapped glove micros() when the packet was built. */
  tBaseUs: number;
  n: number;
}

/** One MPU sample (200 Hz). Derived values were computed on the glove from this same sample. */
export interface ImuRec {
  tUs: number;
  seq: number;
  /** ax ay az gx gy gz, raw counts */
  raw: number[];
  /** hand orientation w,x,y,z (includes the heading offset: never use yaw as a feature) */
  q: number[];
  /** gravity-removed acceleration in the hand frame, g */
  accH: number[];
  /** bias-corrected rate in the hand frame, deg/s */
  gyroH: number[];
  /** thumb..little, 0..1 */
  curl: number[];
  /** palm sensor, percent of calibrated full scale */
  pressure: number;
}

/** One ADS1115 conversion. channel is the hardware sensor index 0..5 (see the calibration's finger_to_channel). */
export interface AdcRec {
  tUs: number;
  seq: number;
  channel: number;
  raw: number;
}

export interface ParsedPacket {
  header: PacketHeader;
  imu: ImuRec[];
  adc: AdcRec[];
}

/** Full-width time of a 32-bit record time relative to the packet's 64-bit base (exact within +-35 minutes). */
export function unwrapUs(tBaseUs: number, t32: number): number {
  const M = 2 ** 32;
  const base32 = tBaseUs % M;
  const d = ((((t32 - base32 + M / 2) % M) + M) % M) - M / 2;
  return tBaseUs + d;
}

export function parsePacket(buf: ArrayBuffer): ParsedPacket {
  if (buf.byteLength < HEADER_BYTES) throw new Error('short packet');
  const v = new DataView(buf);
  if (v.getUint8(0) !== MAGIC || v.getUint8(1) !== VERSION) throw new Error('bad magic or version');
  const header: PacketHeader = {
    packetSeq: v.getUint32(4, true),
    bootId: v.getUint32(8, true),
    dropped: v.getUint32(12, true),
    tBaseUs: Number(v.getBigUint64(16, true)),
    n: v.getUint16(24, true),
  };
  const payload = v.getUint16(26, true);
  if (payload !== buf.byteLength - HEADER_BYTES) throw new Error(`payload length ${payload} != ${buf.byteLength - HEADER_BYTES}`);
  const imu: ImuRec[] = [];
  const adc: AdcRec[] = [];
  let off = HEADER_BYTES;
  while (off < buf.byteLength) {
    const type = v.getUint8(off);
    if (type === 1) {
      if (off + IMU_BYTES > buf.byteLength) throw new Error('truncated IMU record');
      const f = (o: number) => v.getFloat32(off + o, true);
      imu.push({
        tUs: unwrapUs(header.tBaseUs, v.getUint32(off + 1, true)),
        seq: v.getUint32(off + 5, true),
        raw: [0, 1, 2, 3, 4, 5].map((k) => v.getInt16(off + 9 + 2 * k, true)),
        q: [f(21), f(25), f(29), f(33)],
        accH: [f(37), f(41), f(45)],
        gyroH: [f(49), f(53), f(57)],
        curl: [f(61), f(65), f(69), f(73), f(77)],
        pressure: f(81),
      });
      off += IMU_BYTES;
    } else if (type === 2) {
      if (off + ADC_BYTES > buf.byteLength) throw new Error('truncated ADC record');
      adc.push({
        tUs: unwrapUs(header.tBaseUs, v.getUint32(off + 1, true)),
        seq: v.getUint32(off + 5, true),
        channel: v.getUint8(off + 9),
        raw: v.getInt16(off + 10, true),
      });
      off += ADC_BYTES;
    } else {
      throw new Error(`unknown record type ${type} at ${off}`);
    }
  }
  if (imu.length + adc.length !== header.n) throw new Error('record count does not match header');
  return { header, imu, adc };
}

/** Roll and pitch (radians) from a hand quaternion, ZYX convention. Yaw is deliberately not provided:
 *  heading drifts and resets at power-up. Positive pitch = fingers pointing down. */
export function rollPitch(q: number[]): [number, number] {
  const [w, x, y, z] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  return [roll, pitch];
}
