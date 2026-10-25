#pragma once
// Calibration that survives a power cycle, kept in the ESP8266's emulated EEPROM (one flash sector).
// Written only when a calibration step completes. A bad magic, version or CRC loads defaults.
// Layout: CalData at offset 0, then MapData. They are separate records so adding one never discards the other.
#include <Arduino.h>
#include <EEPROM.h>

enum : uint16_t { CAL_GYRO = 1, CAL_ACCEL = 2, CAL_MOUNT = 4, CAL_OPEN = 8, CAL_FIST = 16, CAL_FORCE = 32 };

struct CalData {
  uint32_t magic = 0x474C4F56; // "GLOV"
  uint16_t version = 2, flags = 0;
  float gyroBias[3] = {};               // deg/s, raw sensor frame
  float accOff[3] = {}, accScale[3] = {1,1,1}; // g; corrected = (raw - off) * scale
  float mount[4] = {1,0,0,0};           // q_SH as w,x,y,z
  float openR[6] = {}, fistR[6] = {};   // ohms at open hand / fist, ADC channels 0-4 (flex)
  float forceRest = 0;                  // V, palm sensor with no load
  float forceFull = 0;                  // V above rest that counts as 100% pressure (firm press)
  uint32_t crc = 0;
};
// Which ADC channel carries which finger: ch[finger] with finger 0 = thumb ... 4 = little. A permutation of 0-4.
struct MapData {
  uint32_t magic = 0x4D415046; // "MAPF"
  uint8_t ch[5] = {0,1,2,3,4}, pad[3] = {};
  uint32_t crc = 0;
};

inline uint32_t crc32Of(const void *data, size_t n) {
  const uint8_t *p = static_cast<const uint8_t*>(data);
  uint32_t crc = 0xFFFFFFFF;
  for (size_t i = 0; i < n; i++) {
    crc ^= p[i];
    for (uint8_t b = 0; b < 8; b++) crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc;
}
inline uint32_t calCrc(const CalData &c) { return crc32Of(&c, sizeof(CalData) - sizeof(uint32_t)); }
inline bool loadCal(CalData &out) {
  CalData tmp; EEPROM.get(0, tmp);
  if (tmp.magic != CalData().magic || tmp.version != CalData().version || tmp.crc != calCrc(tmp)) return false;
  out = tmp; return true;
}
inline bool saveCal(CalData &c) {
  c.crc = calCrc(c); EEPROM.put(0, c);
  return EEPROM.commit();
}
inline bool validMap(const uint8_t *ch) {
  bool used[5] = {};
  for (uint8_t f = 0; f < 5; f++) { if (ch[f] > 4 || used[ch[f]]) return false; used[ch[f]] = true; }
  return true;
}
inline bool loadMap(MapData &out) {
  MapData tmp; EEPROM.get(sizeof(CalData), tmp);
  if (tmp.magic != MapData().magic || tmp.crc != crc32Of(&tmp, sizeof(MapData) - sizeof(uint32_t)) || !validMap(tmp.ch)) return false;
  out = tmp; return true;
}
inline bool saveMap(MapData &m) {
  m.crc = crc32Of(&m, sizeof(MapData) - sizeof(uint32_t)); EEPROM.put(sizeof(CalData), m);
  return EEPROM.commit();
}
