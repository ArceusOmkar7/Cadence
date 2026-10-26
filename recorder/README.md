# Glove recorder

Records table tennis strokes from the glove for offline training. Nothing here runs ML. The app stores the **raw sensor
streams with the glove's own microsecond timestamps**, the glove's derived signals from the same samples, the detected
stroke events, and the calibration snapshot, and exports one folder per session.

## Run it

```
cd recorder
npm install
npm start            # builds the app, then serves it at http://localhost:8787
```

1. Open http://localhost:8787, **Session** tab, type the glove's address (`glove.local` or its IP), **Connect**.
2. Do the three calibration steps there (flat hand, fingers up, fist). Recording is blocked until they are done.
   If the fist says some fingers changed too little, use **One finger at a time** (Open, then Flexed, per finger). The fist step
   saves the fingers that pass and only asks you to redo the others. A flexed value is accepted when it differs from the open one
   by 2% of the resistance and by 8 times the sensor's own noise, so a small swing is fine if the sensor is quiet.
3. Fill the session form (hand, ball, grip, holdout) and **Start session**.
4. **Record** tab: pick a class (keys `1`-`4`, `0` = idle), reps, tempo, press **Space**. A 3 s countdown, then you play.
   Space ends the set (it also ends by itself once the expected count is reached and your hand has been still for 2 s).
   Backspace discards. A set with a data problem, or whose count does not match, waits for you: Keep, Discard or Review.
5. **Review** shows the energy trace with the detected strokes, lets you delete, mark ambiguous, add a missed one by clicking,
   and replay a stroke on the 3D hand. **Dashboard** shows progress to 150 per class and 15 min of idle.
6. **Session tab → Export**: a folder (Chrome/Edge) or a zip. Then **copy it to a second drive**; recordings are not in git.
7. Check it: `python tools/check_session.py <folder-or-zip> --plot s1`.

**Windows firewall.** Inbound UDP to `node.exe` may be blocked (on this PC an old prompt left a Block rule on the nvm copy of Node,
and your network profile `vo kaun` is Public). The relay therefore receives the glove's UDP in a small Python helper
(`server/udp_in.py`) and passes it to itself over loopback: Python is already allowed, and no firewall setting is changed.
`npm run glove-check -- <glove ip>` proves the whole path in 10 s (it should print `imuLost: 0`). If you would rather let Node
receive UDP directly, allow `node.exe` in the firewall and start the relay with `RELAY_UDP=node`.

To start with the glove preselected: in PowerShell `$env:GLOVE_HOST="10.23.174.16"; npm start`; in cmd.exe `set GLOVE_HOST=10.23.174.16&& npm start`
(PowerShell's `set` does not create an environment variable). Or just type the address on the Session tab; it is remembered. `glove.local` did not resolve from this
laptop, so use the IP (it is printed on the glove's serial output at boot, as `3D viewer: http://<ip>`).

## Without a glove

`npm run fake-glove` starts a simulated glove (same protocol) and the host `localhost:9100` works in the app. Steer it with
`curl -X POST "localhost:9100/fake/config?strokes=20&interval=0.9&loss=0.01&burst=1&reboot=1"`.
`npm test` runs the unit tests; `npm run build && node server/e2e.mjs` drives the real page in headless Edge/Chrome
(17 checks: connect, calibration gate, a stroke set, an idle set, review, replay, dashboard, export).

## Game (third tab)

A 3D table-tennis rally against a robot, first to 7 points, four opponents (Rookie to Champion). Open it with the **Game** tab, hold the
paddle up facing the opponent and **swing any stroke to start** (keyboard fallback: Space). The arena is a Blender model
(`public/models/arena.glb`, built through the Blender MCP; a plain stand-in is used if it cannot load).

- The incoming ball is marked on the table with the stroke to play (FH, BH, SM, PU). Swing as it reaches your paddle: the ball waits at the
  paddle (a "hit-stop") until the glove's classifier has read the swing, about 0.2 s (Fast) after the peak.
- The right stroke, on time, scores most and sends back a clean ball; a wrong or unreadable stroke still returns, but weaker, and the
  opponent punishes it. Swing intensity sets the ball speed. Placement is random (the glove's heading is not reliable, so it is not used).
- The hand and paddle on screen follow the glove's orientation, relative to the pose you were in at Start (press **C** to recentre).
- No glove (testing only): keys 1 to 4 play Forehand, Backhand, Smash, Push; M mutes.
- Physics (`src/game/physics.ts`): gravity, air drag, Magnus force from spin, a table bounce that depends on spin, the net. Rules and
  scoring: `src/game/engine.ts`. Shot generation: `src/game/shots.ts` (every ball is checked against the physics, so it is playable).
- `npm test` covers physics, shots and whole simulated matches. `test/gameDataset.test.ts` replays the recorded strokes in `dataset/`
  through the live classifier and plays simulated matches with them (writes `test/out/game-sim.txt`). Caveats: the shipped models were trained
  on those recordings, so that player sees in-sample answers; a "held-out-like" player uses the measured leave-one-set-out recall instead;
  human timing in the simulation is an assumption. It checks balance, not feel. `node server/e2e-game.mjs` drives the real page.

## How the pieces fit

```
glove --UDP datagrams (one packet each)--> relay (server/relay.mjs) --WebSocket--> page (this app)
glove <--WebSocket control: rec:start:<port>, keepalive-- relay <--JSON commands-- page
```
A browser cannot receive UDP, so the small relay does. UDP was chosen because over TCP/WebSocket one lost WiFi packet
stalled the stream for 1-3 s (measured: 6-7% of records lost per 5 min). Over UDP with paced ~1000 byte datagrams and one
delayed retry the glove lost 0.2% of records in 5 minutes (longest gap 140 ms, one radio burst).
The relay also proxies the glove's HTTP API (calibration, diagnostics) so the page needs no CORS, and sends a 1-byte
keepalive every 100 ms.

| Module | Role |
|---|---|
| `src/detector.ts` | The stroke detector. No DOM, causal, shared by live recording, review and later inference. |
| `src/recorder.ts` | Session and set flow (countdown, auto-end, quality, keep/discard, mixed cues). Fully unit-tested with a fake glove. |
| `src/quality.ts` | Per-set checks: sequence gaps, gaps over 50 ms, reboot, clipping, ADC saturation, flat flex channel, calibration change. |
| `src/csv.ts`, `src/exporter.ts` | The session folder. |
| `config/classes.json` | Class list (add `serve`, `loop`, `chop` here and rebuild), idle sub-labels, targets, defaults. |
| `config/detector.json` | Detector parameters, versioned. Every event records a tag of the parameters used. |

## The detector

Energy = smoothed `sqrt((|gyro|/500 dps)² + (|accel|/2 g)²)`, using the glove's gravity-removed hand-frame values (50 ms smoothing).
Tracking starts above `highThreshold`, follows the running maximum, and emits when energy falls to 50% of it or 120 ms after
the peak. The event time is the maximum. 400 ms refractory. **Recovery rule:** bringing the hand back to the ready position makes a second bump 0.4-0.7 s after a stroke. On real recordings
every such bump swung the opposite way to the stroke (gyro cosine -0.35 to -0.98) and was 25-63% of its peak, or even larger than
a soft push. A candidate within `recoveryMs` (900) of the previous event is dropped if its peak is below `recoveryRatio` (0.5) of that
event's peak, or if its direction has cosine below `recoveryCos` (-0.3) against it. A second stroke in the same direction still counts;
an opposite-direction stroke more than 0.9 s later still counts. A set that looks complete but ends early is the symptom of bumps
being counted: the auto-end fires at the expected count.
Because the smoothing is causal, the reported peak lags the
true peak by about 25 ms, **consistently**, so windows stay aligned. `windowAround()` cuts 0.48 s before and 0.32 s after.
`test/golden/detector_v1.json` holds an input and its expected events so a Python port can be verified.

The default threshold (0.35) is a guess. Record some idle sets (walking, adjusting the grip, half swings) and press
**Settings → Suggest threshold from idle sets**; soft pushes need it low enough, idle movement needs it high enough.

## Export format (one folder per session)

`meta.json`, `calibration.json` (start and end), `motion.csv` (raw counts, glove time, `t_rx_ms` for diagnostics only),
`motion.csv`, `analog.csv` and `derived.csv` end with `set_id,boot_id`: the glove's clock restarts at power-up, so two runs can
cover the same `t_us` range. **Select rows by `set_id`, never by a time window alone.** `analog.csv` (**long format**, one row per ADC conversion with its channel and finger: the channels are converted one after
another, so a wide table would invent timestamps), `derived.csv` (from the glove, same sample as motion; **no yaw**),
`sets.csv`, `events.csv`, `README.txt`. Discarded sets are left out.

## Phone, and HTTPS hosting

- **Laptop:** everything works. `http://localhost` counts as a secure page, which the save-to-folder feature needs.
- **Phone on the same WiFi:** start the relay with `HOST=0.0.0.0 node server/relay.mjs` and open `http://<laptop-ip>:8787`.
  Recording, review and the zip export work (IndexedDB and audio are fine). Save-to-folder does not exist on phone browsers,
  and the page is not a secure context there. The laptop still has to run the relay, and anyone on that WiFi could use it.
- **The app hosted over HTTPS:** an HTTPS page may not open a `ws://` connection to a LAN address (mixed content), but
  Chrome and Edge allow `ws://localhost`, so a hosted copy works on the laptop that runs the relay. It would not reach a
  relay on another machine unless that relay serves TLS.
- The glove-side hand model in `web/viewer.html` is a separate copy: that page is embedded in the glove's flash and has no bundler.

## Known limits

- Not yet run against the real glove: all of the above was tested against the simulated one, except the firmware stream
  itself, which was measured separately (see the root README).
- Datagram loss is now 0.2% (the retry is one delayed attempt, then the loss shows as a sequence jump and is flagged).
- While streaming the busiest ADC chip now delivers about 103 Hz per flex channel (4 channels on 0x48; a 3+3 split would give more margin).

## Train and Use sections
The header switches between **Train** (the recorder: session, record, review, dashboard, settings) and **Use** (live stroke classification).
Use runs the XGBoost model from `ml/` in the browser on the same glove stream: the recorder's causal detector fires, a window is cut
around its peak (peak at sample 96, ends 160 ms (Fast) or 320 ms (Accurate) later), `src/ml/featuresLive.ts` computes the features
(exact port of `ml/features_live.py`) and `src/ml/xgb.ts` evaluates the trees. It shows the latest stroke with its confidence ("Unsure"
below the level you set), a tape of recent strokes, a tally, swing intensity relative to your last 20 strokes, and a drill mode (pick a
target stroke with keys 1-4; each stroke is scored match / wrong stroke / unsure).
Updating the model: train in `ml/` (`final.py`), then `ml/export_compact.py` writes `public/models/stroke_live{160,320}.json` and the
parity fixtures in `test/fixtures/`; `npm test` checks that the TypeScript features and probabilities still match the Python.
`node server/e2e-use.mjs` drives the Use section against the simulated glove (its strokes are synthetic and all classify as push).
