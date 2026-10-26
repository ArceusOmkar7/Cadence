// A simulated glove that speaks the real protocol, so the recorder can be built and tested without hardware.
//   node server/fake-glove.mjs [--port 9100] [--calibrated]
// HTTP on --port, WebSocket on port+1 (use host "localhost:9100" in the recorder). Behaviour is steered over HTTP:
//   POST /fake/config?strokes=20&interval=0.9&loss=0.01&burst=0&reboot=0
//     strokes  strokes performed after each rec:start (0 = idle movement only)
//     interval seconds between strokes   loss  fraction of datagrams dropped   burst  1 = also drop 8 s of data once
//     reboot   1 = reboot (new boot id, seq restarts) ~3 s after the next rec:start
import http from 'node:http';
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';
import { buildPacket } from './wire.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 9100));
const cfg = { strokes: 20, interval: 0.9, loss: 0.0, burst: 0, reboot: 0 };
const state = {
  flags: process.argv.includes('--calibrated') ? 1 | 4 | 8 | 16 | 32 : 0,
  bootId: (Math.random() * 2 ** 32) >>> 0, imuSeq: 0, adcSeq: 0, pktSeq: 0,
  capStage: 'none', capUntil: 0, resSeq: 0, resOk: 1, resMsg: '',
  rec: null, // { sock, ip, port, t0, strokeTimes[], tNext, ... }
};
const fingerToChannel = [2, 0, 4, 1, 3];
const micros = () => Math.round(Number(process.hrtime.bigint() / 1000n));
const T0 = micros() - 30_000_000;                 // pretend the glove has been up for 30 s
const gloveUs = () => micros() - T0 + 1_000_000;

// ---- HTTP ----
const calibration = () => ({
  fw: 'fake-glove-1', build: 'simulated', boot_id: state.bootId, uptime_ms: Math.round(gloveUs() / 1000), cal_version: 3, flags: state.flags,
  calibrated: { gyro: !!(state.flags & 1), accel: !!(state.flags & 2), mount: !!(state.flags & 4), open: !!(state.flags & 8), fist: !!(state.flags & 16), force: !!(state.flags & 32) },
  finger_to_channel: fingerToChannel,
  imu: { present: true, model: 'MPU6500', accel_range_g: 16, gyro_range_dps: 2000, nominal_rate_hz: 200, measured_period_us: 5000 },
  adc: { sps: 860 }, i2c_hz: 400000,
});
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const startCap = (stage, bit) => {
  if (state.capStage !== 'none') return false;
  state.capStage = stage; state.capUntil = Date.now() + 3000;
  setTimeout(() => { state.flags |= bit; state.capStage = 'none'; state.resSeq++; state.resOk = 1; state.resMsg = `${stage} pose saved (simulated)`; }, 3000);
  return true;
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/api/calibration') return send(res, 200, calibration());
  if (p === '/api/diag') return send(res, 200, { imu: { rate_hz: 200 }, wifi: { ssid: 'simulated', channel: 6, rssi_dbm: -50, rssi_avg_dbm: -50, rssi_min_dbm: -55 }, free_heap: 30000, min_free_heap: 25000 });
  if (p === '/api/diag/reset') return send(res, 200, 'ok', 'text/plain');
  const cap = { '/api/cal/flat': ['flat', 1 | 8], '/api/cal/up': ['up', 4], '/api/cal/fist': ['fist', 16], '/api/cal/press': ['press', 32] }[p];
  if (cap && req.method === 'POST') return startCap(cap[0], cap[1]) ? send(res, 202, 'Capture started', 'text/plain') : send(res, 409, 'busy', 'text/plain');
  if (p === '/api/cal/clear' && req.method === 'POST') { state.flags = 0; return send(res, 200, 'cleared', 'text/plain'); }
  if (p === '/fake/config' && req.method === 'POST') {
    for (const [k, v] of u.searchParams) if (k in cfg) cfg[k] = Number(v);
    return send(res, 200, cfg);
  }
  send(res, 404, 'not found', 'text/plain');
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake glove: HTTP ${PORT}, WebSocket ${PORT + 1}`));

// ---- WebSocket control + pose/status text frames ----
const wss = new WebSocketServer({ port: PORT + 1, host: '127.0.0.1' });
const clients = new Set();
wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.on('close', () => { clients.delete(ws); if (state.rec?.ws === ws) stopRec(); });
  ws.on('message', (data) => {
    const t = data.toString();
    if (t === 'rec:stop') { stopRec(); ws.send(JSON.stringify({ t: 'rec', on: 0, boot: state.bootId, v: 1, err: '' })); }
    else if (t.startsWith('rec:start')) {
      const port = Number(t.split(':')[2] || 0);
      if (!port) return ws.send(JSON.stringify({ t: 'rec', on: 0, err: 'simulator supports UDP only' }));
      startRec(ws, req.socket.remoteAddress, port);
      ws.send(JSON.stringify({ t: 'rec', on: 1, boot: state.bootId, v: 1, err: '' }));
    }
  });
  ws.send(statusFrame());
});
const statusFrame = () => JSON.stringify({
  t: 's', imu: 1, addr: 104, flags: state.flags, faces: 0, hz: [200, 100], map: fingerToChannel,
  rec: { on: state.rec ? 1 : 0, drop: 0, blk: 0 },
  cap: { stage: state.capStage, face: 0, left: Math.max(0, state.capUntil - Date.now()), total: 3000 },
  res: { seq: state.resSeq, ok: state.resOk, msg: state.resMsg },
});
setInterval(() => { for (const c of clients) if (c.readyState === 1) c.send(statusFrame()); }, 500);

// ---- the simulated sensor streams ----
const udp = dgram.createSocket('udp4');
let rnd = 12345;
const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

function startRec(ws, ip, port) {
  const now = gloveUs();
  if (cfg.reboot) { state.bootId = (Math.random() * 2 ** 32) >>> 0; state.imuSeq = 0; state.adcSeq = 0; state.pktSeq = 0; }
  const strokeTimes = [];
  const t0 = now + 4_500_000;                       // the app counts down 3 s, then the player starts 1.5 s later
  for (let i = 0; i < cfg.strokes; i++) strokeTimes.push(t0 + i * cfg.interval * 1e6 + rand() * 80_000);
  state.rec = { ws, ip, port, strokeTimes, tImu: now, tAdc: now, imu: [], adc: [], rebootAt: cfg.reboot ? now + 3_000_000 : 0, burstAt: cfg.burst ? now + 6_000_000 : 0, strokeAmp: strokeTimes.map(() => 0.7 + 0.6 * Math.abs(rand())) };
  cfg.reboot = 0;
}
function stopRec() { state.rec = null; }

function imuSample(r, t) {
  let burst = 0;
  r.strokeTimes.forEach((c, i) => { burst += r.strokeAmp[i] * Math.exp(-(((t - c) / 1e6 / 0.04) ** 2)); });
  const walk = cfg.strokes === 0 ? 40 * Math.max(0, Math.sin(t / 1e6 * 2)) : 0; // idle sets: some movement, well below stroke energy
  const gx = 900 * burst + walk + 3 * rand(), ax = 4 * burst + 0.002 * walk + 0.01 * rand();
  return {
    tUs: t, seq: state.imuSeq++, raw: [Math.round(ax * 2048), 0, 2048, Math.round(gx * 16.4), 0, 0],
    q: [1, 0, 0, 0], accH: [ax, 0.01 * rand(), 0.01 * rand()], gyroH: [gx, 3 * rand(), 3 * rand()],
    curl: [0.1 + 0.4 * Math.min(1, burst), 0.1, 0.1, 0.1, 0.1], pressure: 0,
  };
}
let lastSend = 0;
setInterval(() => {
  const r = state.rec; if (!r) return;
  const now = gloveUs();
  while (r.tImu + 5000 <= now) { r.tImu += 5000; r.imu.push(imuSample(r, r.tImu)); }
  while (r.tAdc + 1160 <= now) {              // 860 SPS across the chips: ~100 Hz on channels 0-3, ~200 Hz on 4-5
    r.tAdc += 1160;
    const k = state.adcSeq++ % 8; const ch = k < 4 ? k : 4 + (k % 2);
    r.adc.push({ tUs: r.tAdc, seq: state.adcSeq - 1, channel: ch, raw: 6000 + Math.round(8 * rand()) + (ch === 0 ? Math.round(900 * Math.max(0, Math.sin(r.tAdc / 1e6))) : 0) });
  }
  if (r.rebootAt && now > r.rebootAt) { r.rebootAt = 0; state.bootId = (Math.random() * 2 ** 32) >>> 0; state.imuSeq = 0; state.pktSeq = 0; }
  // packets of at most ~520 bytes, in time order, like the firmware
  while (r.imu.length + r.adc.length > 0 && (r.imu.length * 85 + r.adc.length * 12 >= 480 || now - lastSend > 20_000)) {
    const imu = [], adc = []; let bytes = 28;
    while (bytes < 480 && (r.imu.length || r.adc.length)) {
      const takeImu = r.imu.length && (!r.adc.length || r.imu[0].tUs <= r.adc[0].tUs);
      if (takeImu) { imu.push(r.imu.shift()); bytes += 85; } else { adc.push(r.adc.shift()); bytes += 12; }
    }
    const seq = state.pktSeq++;
    const inBurst = r.burstAt && now > r.burstAt && now < r.burstAt + 8_000_000;
    if (!inBurst && Math.random() >= cfg.loss) udp.send(buildPacket({ packetSeq: seq, bootId: state.bootId, dropped: 0, tBaseUs: now, imu, adc }), r.port, r.ip);
    lastSend = now;
    if (!r.imu.length && !r.adc.length) break;
  }
}, 5);
