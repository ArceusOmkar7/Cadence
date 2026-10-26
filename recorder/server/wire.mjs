// Builds glove record packets (the format of lib/GloveRec/GloveRec.h). Used by the simulated glove and by the tests.
const HEADER = 28, IMU = 85, ADC = 12;

/** @param {{packetSeq:number, bootId:number, dropped:number, tBaseUs:number, imu:any[], adc:any[]}} p */
export function buildPacket(p) {
  const buf = Buffer.alloc(HEADER + p.imu.length * IMU + p.adc.length * ADC);
  buf.writeUInt8(0xa5, 0); buf.writeUInt8(1, 1); buf.writeUInt8(1, 2); buf.writeUInt8(0, 3);
  buf.writeUInt32LE(p.packetSeq >>> 0, 4); buf.writeUInt32LE(p.bootId >>> 0, 8); buf.writeUInt32LE(p.dropped >>> 0, 12);
  buf.writeBigUInt64LE(BigInt(Math.round(p.tBaseUs)), 16);
  buf.writeUInt16LE(p.imu.length + p.adc.length, 24); buf.writeUInt16LE(buf.length - HEADER, 26);
  let o = HEADER;
  for (const r of p.imu) {
    buf.writeUInt8(1, o); buf.writeUInt32LE(Math.round(r.tUs) % 2 ** 32, o + 1); buf.writeUInt32LE(r.seq >>> 0, o + 5);
    r.raw.forEach((v, k) => buf.writeInt16LE(v, o + 9 + 2 * k));
    [...r.q, ...r.accH, ...r.gyroH, ...r.curl, r.pressure].forEach((v, k) => buf.writeFloatLE(v, o + 21 + 4 * k));
    o += IMU;
  }
  for (const r of p.adc) {
    buf.writeUInt8(2, o); buf.writeUInt32LE(Math.round(r.tUs) % 2 ** 32, o + 1); buf.writeUInt32LE(r.seq >>> 0, o + 5);
    buf.writeUInt8(r.channel, o + 9); buf.writeInt16LE(r.raw, o + 10);
    o += ADC;
  }
  return buf;
}
