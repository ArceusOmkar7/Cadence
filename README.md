# Glove

ESP8266 sensor glove: five flex sensors, a palm pressure sensor and a back-of-hand MPU6050, streamed to a 3D viewer
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
