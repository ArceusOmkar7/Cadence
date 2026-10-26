// Checks the whole real path in 10 s: relay -> glove -> UDP back through the Windows firewall -> page protocol.
//   npm run glove-check -- <glove ip or name>
// Prints packets received and any lost IMU records. Exit code 1 if no data arrived (usually the firewall: allow Node on private networks).
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const relay = spawn('node', ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8797', GLOVE_HOST: process.argv[2] || '' } });
await new Promise((r) => setTimeout(r, 2500));
const ws = new WebSocket('ws://localhost:8797/relay');
let pk = 0, imu = [], states = new Set(), texts = new Set();
ws.on('message', (d, bin) => {
  if (!bin) { const m = JSON.parse(d.toString()); if (m.t === 'relay') states.add(m.glove); else texts.add(m.t); return; }
  pk++; let o = 28; while (o < d.length) { if (d[o] === 1) { imu.push(d.readUInt32LE(o + 5)); o += 85; } else o += 12; }
});
await new Promise((r) => ws.once('open', r));
await new Promise((r) => setTimeout(r, 1500));
const cal = await (await fetch('http://localhost:8797/glove/api/calibration')).json();
ws.send(JSON.stringify({ cmd: 'start' }));
await new Promise((r) => setTimeout(r, 6000));
ws.send(JSON.stringify({ cmd: 'stop' }));
const lost = imu.length ? imu[imu.length - 1] - imu[0] + 1 - imu.length : 0;
console.log(JSON.stringify({ relayStates: [...states], packets: pk, imuRecords: imu.length, imuLost: lost, glovePoseAndStatusFrames: [...texts], fw: cal.fw, imu: cal.imu?.model, calibrated: cal.calibrated }));
relay.kill(); process.exit(pk > 100 ? 0 : 1);
