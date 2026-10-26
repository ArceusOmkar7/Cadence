#pragma once
// Binary record stream: wire format and ring buffer. No Arduino dependencies, so it is unit-tested on the host and
// mirrored by tools/glove_rec.py. All integers and floats are little-endian (the ESP8266's native order).
//
// One WebSocket binary message = PacketHeader + `payloadBytes` of concatenated records. Each record starts with a
// type byte and has a fixed size, so a reader needs no length field.
//   Times: records carry the low 32 bits of the ESP's micros() clock; the header carries the full 64-bit time at the
//   moment the packet was built (unwrapped, so it survives the 71.6 minute wrap). Unwrap a record with
//   t = tBaseUs + int32(rec.tUs - uint32(tBaseUs)), which is exact for records within +-35 minutes of the base.
//   Sequence: `seq` counts samples of that stream since boot. A jump means lost samples; a drop back to a small value,
//   or a different bootId, means the ESP rebooted.
#include <stdint.h>
#include <string.h>

namespace rec {

const uint8_t MAGIC = 0xA5, VERSION = 1;
enum : uint8_t { PKT_DATA = 1 };
enum : uint8_t { REC_IMU = 1, REC_ADC = 2 };

#pragma pack(push, 1)
struct PacketHeader {
  uint8_t magic, version, type, flags;
  uint32_t packetSeq;     // counts packets sent since boot
  uint32_t bootId;        // random per boot
  uint32_t dropped;       // records discarded since boot because the ring buffer was full
  uint64_t tBaseUs;       // unwrapped micros() when the packet was built
  uint16_t nRecords, payloadBytes;
};
// One MPU sample (200 Hz). raw: counts as read from the chip, order ax ay az gx gy gz.
// Derived values are computed on the ESP from that same sample, so training and live inference see identical numbers:
//   q: hand orientation w,x,y,z (includes the heading offset; do not use yaw as a feature)
//   accH: acceleration in the hand frame with gravity removed, in g; gyroH: bias-corrected rate in the hand frame, deg/s
//   curl: thumb..little, 0..1 (finger order, after the finger map); pressure: palm sensor, percent of calibrated full scale
struct ImuRecord {
  uint8_t type;           // REC_IMU
  uint32_t tUs, seq;
  int16_t raw[6];
  float q[4], accH[3], gyroH[3], curl[5], pressure;
};
// One ADS1115 conversion. channel is the hardware sensor index 0..5 (0x48 A0-A3, 0x49 A0-A1); the finger map in the
// calibration says which finger each carries. tUs is the middle of the conversion window.
struct AdcRecord {
  uint8_t type;           // REC_ADC
  uint32_t tUs, seq;
  uint8_t channel;
  int16_t raw;
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 28, "PacketHeader layout");
static_assert(sizeof(ImuRecord) == 85, "ImuRecord layout");
static_assert(sizeof(AdcRecord) == 12, "AdcRecord layout");

inline size_t recordSize(uint8_t type) {
  return type == REC_IMU ? sizeof(ImuRecord) : type == REC_ADC ? sizeof(AdcRecord) : 0;
}

// Fixed-capacity byte ring. push() refuses (returns false) when the record does not fit, so the oldest data is
// kept intact and the caller counts the drop.
template <size_t N>
struct ByteRing {
  uint8_t buf[N];
  size_t head = 0, used = 0, peak = 0;
  void clear() { head = used = 0; }
  bool push(const void *data, size_t n) {
    if (used + n > N) return false;
    size_t tail = (head + used) % N, first = N - tail < n ? N - tail : n;
    memcpy(buf + tail, data, first);
    if (first < n) memcpy(buf, static_cast<const uint8_t*>(data) + first, n - first);
    used += n; if (used > peak) peak = used;
    return true;
  }
  uint8_t peekByte(size_t offset = 0) const { return buf[(head + offset) % N]; }
  void peek(size_t offset, void *out, size_t n) const {
    size_t start = (head + offset) % N, first = N - start < n ? N - start : n;
    memcpy(out, buf + start, first);
    if (first < n) memcpy(static_cast<uint8_t*>(out) + first, buf, n - first);
  }
  void drop(size_t n) { if (n > used) n = used; head = (head + n) % N; used -= n; }
};

// Push that never refuses: when full, whole oldest records are discarded to make room (and counted). Used for the
// UDP stream, where sampling must never wait on the network and the newest data matters most.
template <size_t N>
void pushDropOldest(ByteRing<N> &ring, const void *data, size_t n, uint32_t &dropped) {
  while (ring.used + n > N) {
    size_t sz = recordSize(ring.peekByte());
    if (!sz) { ring.clear(); dropped++; break; }
    ring.drop(sz); dropped++;
  }
  ring.push(data, n);
}

// Moves whole records from the ring into out[sizeof(PacketHeader)...], up to maxBytes in total, and fills the header.
// Returns the packet length, or 0 if nothing was available. An unknown type byte means the ring is corrupt: it is
// cleared and the caller sees 0.
template <size_t N>
size_t buildPacket(ByteRing<N> &ring, uint8_t *out, size_t maxBytes, uint32_t packetSeq, uint32_t bootId,
                   uint32_t dropped, uint64_t tBaseUs) {
  size_t len = sizeof(PacketHeader), consumed = 0; uint16_t n = 0;
  while (consumed < ring.used) {
    size_t sz = recordSize(ring.peekByte(consumed));
    if (!sz) { ring.clear(); return 0; }
    if (consumed + sz > ring.used) break;
    if (len + sz > maxBytes) break;
    ring.peek(consumed, out + len, sz); len += sz; consumed += sz; n++;
  }
  if (!n) return 0;
  ring.drop(consumed);
  PacketHeader h = {MAGIC, VERSION, PKT_DATA, 0, packetSeq, bootId, dropped, tBaseUs, n, uint16_t(len - sizeof(PacketHeader))};
  memcpy(out, &h, sizeof h);
  return len;
}

}  // namespace rec
