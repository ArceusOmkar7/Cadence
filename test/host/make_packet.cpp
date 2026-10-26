// Writes one packet built with the real firmware structs, for tools/glove_rec.py to parse (cross-language layout check).
//   g++ -std=c++17 -I lib/GloveRec test/host/make_packet.cpp -o make_packet && ./make_packet packet.bin
#include <cstdio>
#include "GloveRec.h"

int main(int argc, char **argv) {
  using namespace rec;
  ByteRing<2048> ring;
  const uint64_t base = 0x100000100ull; // just after a 32-bit micros() wrap
  ImuRecord i = {}; i.type = REC_IMU; i.tUs = 0xFFFFFF00u; i.seq = 123456; // a record from just before the wrap
  int16_t raw[6] = {-2048, 100, 32767, -32768, 7, 1640};
  for (int k = 0; k < 6; k++) i.raw[k] = raw[k];
  for (int k = 0; k < 4; k++) i.q[k] = 0.25f * (k + 1);
  for (int k = 0; k < 3; k++) { i.accH[k] = -1.5f * (k + 1); i.gyroH[k] = 100.0f * (k + 1); }
  for (int k = 0; k < 5; k++) i.curl[k] = 0.1f * k;
  i.pressure = 42.5f;
  AdcRecord a = {}; a.type = REC_ADC; a.tUs = 0x00000050u; a.seq = 99; a.channel = 5; a.raw = -1234;
  ring.push(&i, sizeof i); ring.push(&a, sizeof a);
  uint8_t buf[1100];
  size_t n = buildPacket(ring, buf, sizeof buf, 77, 0xCAFEF00Du, 5, base);
  FILE *f = fopen(argc > 1 ? argv[1] : "packet.bin", "wb");
  fwrite(buf, 1, n, f); fclose(f);
  printf("wrote %zu bytes\n", n);
  return n == sizeof(PacketHeader) + sizeof i + sizeof a ? 0 : 1;
}
