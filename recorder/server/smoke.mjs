// Integration smoke test: simulated glove + relay + a WebSocket client playing the page's role. `npm run smoke`.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const procs = [spawn('node', ['server/fake-glove.mjs', '--port', '9100', '--calibrated'], { stdio: 'inherit' }), spawn('node', ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8799' } })];
const done = (code) => { procs.forEach((p) => p.kill()); process.exit(code); };
await new Promise((r) => setTimeout(r, 1200));
const ws = new WebSocket('ws://localhost:8799/relay');
let imuSeqs = [], adc = 0, packets = 0, texts = new Set(), badMagic = 0;
ws.on('message', (d, bin) => {
  if (!bin) { try { texts.add(JSON.parse(d.toString()).t); } catch { /* ignore */ } return; }
  if (d[0] !== 0xa5) badMagic++;
  packets++; let off = 28;
  while (off < d.length) { if (d[off] === 1) { imuSeqs.push(d.readUInt32LE(off + 5)); off += 85; } else { adc++; off += 12; } }
});
await new Promise((r) => ws.once('open', r));
ws.send(JSON.stringify({ cmd: 'connect', host: 'localhost:9100' }));
await new Promise((r) => setTimeout(r, 800));
const cal = await (await fetch('http://localhost:8799/glove/api/calibration')).json();
ws.send(JSON.stringify({ cmd: 'start' }));
await new Promise((r) => setTimeout(r, 4000));
ws.send(JSON.stringify({ cmd: 'stop' }));
const jumps = imuSeqs.slice(1).filter((s, i) => s !== imuSeqs[i] + 1).length;
const ok = packets > 100 && imuSeqs.length > 700 && adc > 1500 && jumps === 0 && !badMagic && texts.has('s') && cal.fw === 'fake-glove-1';
console.log(JSON.stringify({ packets, imu: imuSeqs.length, adc, seqJumps: jumps, badMagic, textFrames: [...texts], calibrationViaProxy: cal.fw, ok }));
done(ok ? 0 : 1);
