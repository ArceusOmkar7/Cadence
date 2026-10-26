# Glove

ESP8266 sensor glove: five flex sensors, a palm pressure sensor and a back-of-hand MPU (WHO_AM_I 0x70: an MPU6500), streamed to a 3D viewer
and (in progress) a data recorder for stroke classification.

## Setup
1. Copy `include/secrets.example.h` to `include/secrets.h` and put your WiFi in it (git-ignored).
2. `pio run -t upload`, then open the IP or `http://glove.local/` (3D viewer) or `/bench` (sensor bench).
3. Calibrate in the viewer: flat, fingers up, fist (and Identify fingers once).

## Layout
- `src/main.cpp` firmware; `lib/GloveMath` (pure math, host-testable); `lib/GloveCal` (saved calibration).
- `web/viewer.html` is embedded into the firmware at build time by `tools/embed_web.py` (`include/viewer_page.h` is generated).
- `test/host/` math tests: `g++ -std=c++17 -I lib/GloveMath test/host/test_glovemath.cpp -o t && ./t`.

## Backups
Git only holds code. Recorded sessions (`recordings/`) and `include/secrets.h` are git-ignored on purpose, so back
them up separately: copy `recordings/` to a second drive or cloud folder after every session (for example
`robocopy recordings D:\glove-backup\recordings /E` on Windows). Calibration lives on the glove itself and is
also saved into every session folder.

## Record stream (Stage 1)
A binary WebSocket stream for offline training data. Off by default; a client on port 81 sends the text `rec:start`
(and `rec:stop`). Layout: `lib/GloveRec/GloveRec.h`, parser: `tools/glove_rec.py`.
- IMU records at 200 Hz: raw counts, plus orientation, gravity-removed hand-frame acceleration, hand-frame rate, curl and
  pressure computed on the ESP from that same sample. ADC records per conversion. Times are the ESP's `micros()`.
- `GET /api/calibration` returns the full calibration, ranges, rates and finger map; `GET /api/diag` the counters
  (gaps, overflows, peaks, heap); `POST /api/diag/reset`.
- MPU6500 (the chip on this glove; the code also accepts a 6050): +/-16 g, +/-2000 dps, 200 Hz, read through its FIFO so each
  sample is read exactly once. The 6500's FIFO holds 512 bytes = 42 samples = about 210 ms. I2C 400 kHz (0 errors in 5 min).
- ADC at 860 SPS (chosen from the measured noise table): about 100 Hz per channel on 0x48 while streaming, 200 Hz on 0x49.
- Transport: records go out as UDP datagrams (`rec:start:<port>` on the WebSocket control channel; the glove sends to the
  controller's address). Sends are paced like usual ESP8266 UDP advice: one ~1000 byte datagram per loop pass (about 25 a second),
  never a burst, and one retry after 10 ms if the stack refuses a send. Measured over 5 min on a phone hotspot: 0.2% of IMU and
  ADC records lost, longest gap 140 ms. Earlier versions of the same test: WebSocket records lost 6-7% with 1-3 s TCP stalls;
  60 small datagrams a second with an immediate retry lost 2.2% (the loss then equalled the send failures exactly, i.e. the glove's
  own send queue, not the air). A browser cannot receive UDP, so the recorder app uses a local relay (see recorder/README.md).
- Rates while streaming (device-side): IMU 199.9 Hz, ADC about 98 Hz per channel on 0x48 and 196 Hz on 0x49. The ADC loses
  a little against idle because the main loop slows while streaming (the IMU FIFO is immune); with paced sends it is ~104 Hz.

## Recorder (Stage 2-3)
`recorder/` is the data-collection app (TypeScript, Vite): see `recorder/README.md`. `tools/check_session.py` checks an exported session.
