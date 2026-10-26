export function buildPacket(p: {
  packetSeq: number; bootId: number; dropped: number; tBaseUs: number;
  imu: { tUs: number; seq: number; raw: number[]; q: number[]; accH: number[]; gyroH: number[]; curl: number[]; pressure: number }[];
  adc: { tUs: number; seq: number; channel: number; raw: number }[];
}): Buffer;
