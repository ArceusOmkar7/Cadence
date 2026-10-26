// Local relay for the recorder app. A browser cannot receive UDP, so this small Node program sits between them:
//   glove --UDP datagrams--> relay --WebSocket (binary, one message per datagram)--> page
//   glove <--WebSocket control (rec:start:<udp port>, keepalive)-- relay <--JSON commands-- page
// It also serves the built app (dist/) and proxies a whitelist of the glove's HTTP API at /glove/*, so the page
// needs no CORS. It listens on localhost only unless HOST is set.
//   node server/relay.mjs            (PORT=8787 by default; GLOVE_HOST=192.168.x.y to pre-select the glove)
// A host may be "ip" (HTTP 80, WebSocket 81, like the real glove) or "ip:port" (HTTP port, WebSocket port+1, the simulator).
import http from 'node:http';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to let a phone on the same WiFi open the app (anyone on the WiFi can then use the relay)
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

let gloveHost = process.env.GLOVE_HOST || '';
let gloveWs = null;
let gloveState = 'idle'; // idle | connecting | open | closed
let streaming = false;
let reconnectTimer = null;
let datagrams = 0;
const pages = new Set();

const ports = (host) => {
  const m = /^(.*):(\d+)$/.exec(host);
  return m ? { name: m[1], http: Number(m[2]), ws: Number(m[2]) + 1 } : { name: host, http: 80, ws: 81 };
};

// ---- UDP: one datagram = one record packet; forward untouched ----
// Inbound UDP can be blocked by the Windows firewall for node.exe while Python is allowed, so by default a small Python
// helper (server/udp_in.py) receives the datagrams and hands them to this process over loopback. If Python is missing,
// Node receives them itself (then allow node.exe on private networks if no data arrives). RELAY_UDP=node forces Node.
let udpPort = 0, udpMode = 'starting', helper = null;
const fan = (msg) => { datagrams++; for (const p of pages) if (p.readyState === 1) p.send(msg, { binary: true }); };
function receiveWithNode() {
  if (udpPort) return;
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', fan);
  s.bind(0, '0.0.0.0', () => {
    try { s.setRecvBufferSize(4 << 20); } catch { /* the OS may refuse; the default still works */ }
    udpPort = s.address().port; udpMode = 'node (blocked by the firewall? then use Python)';
    console.log(`UDP receiver (Node) on port ${udpPort}`);
  });
}
if (process.env.RELAY_UDP === 'node') receiveWithNode();
else {
  const loop = dgram.createSocket('udp4');
  loop.on('message', fan);
  loop.bind(0, '127.0.0.1', () => {
    const script = fileURLToPath(new URL('./udp_in.py', import.meta.url));
    helper = spawn(process.env.PYTHON || 'python', [script, String(loop.address().port)], { stdio: ['pipe', 'pipe', 'inherit'] });
    const give_up = setTimeout(() => { console.log('Python helper did not start; receiving UDP in Node.'); receiveWithNode(); }, 4000);
    helper.on('error', () => { clearTimeout(give_up); receiveWithNode(); });
    helper.stdout.on('data', (d) => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m && !udpPort) { clearTimeout(give_up); udpPort = Number(m[1]); udpMode = 'python helper'; console.log(`UDP receiver (Python helper) on port ${udpPort}`); }
    });
  });
  process.on('exit', () => helper?.kill());
}

const toPages = (obj) => { const s = JSON.stringify(obj); for (const p of pages) if (p.readyState === 1) p.send(s); };
const relayStatus = () => ({ t: 'relay', glove: gloveState, host: gloveHost, udpPort, udpMode, streaming, datagrams });

// ---- glove control WebSocket ----
function connectGlove() {
  clearTimeout(reconnectTimer);
  if (gloveWs) { // replacing a socket that may still be connecting: terminate() on it raises an error, which must have a listener
    const old = gloveWs; gloveWs = null;
    old.removeAllListeners(); old.on('error', () => {});
    try { old.terminate(); } catch { /* already gone */ }
  }
  if (!gloveHost) return;
  const { name, ws } = ports(gloveHost);
  gloveState = 'connecting';
  toPages(relayStatus());
  const sock = new WebSocket(`ws://${name}:${ws}/`, { handshakeTimeout: 4000 });
  gloveWs = sock;
  sock.on('open', () => {
    gloveState = 'open';
    toPages(relayStatus());
    if (streaming) sock.send(`rec:start:${udpPort}`); // resume after a reconnect
  });
  sock.on('message', (data, isBinary) => { if (!isBinary) for (const p of pages) if (p.readyState === 1) p.send(data.toString()); });
  const lost = () => {
    if (gloveWs !== sock) return;
    gloveState = 'closed';
    toPages(relayStatus());
    reconnectTimer = setTimeout(connectGlove, 2000);
  };
  sock.on('close', lost);
  sock.on('error', lost);
}
// The glove stalls less when something keeps talking to it (measured): a 1-byte frame every 100 ms, ignored by the firmware.
setInterval(() => { if (gloveWs && gloveWs.readyState === 1) gloveWs.send('k'); }, 100);
setInterval(() => toPages(relayStatus()), 1000);

// ---- HTTP: static app + whitelisted proxy ----
const ALLOWED = /^\/(api\/[\w/]+|data)$/;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/glove/')) {
    const target = url.pathname.slice('/glove'.length);
    if (!gloveHost || !ALLOWED.test(target) || !['GET', 'POST'].includes(req.method)) { res.writeHead(gloveHost ? 403 : 503).end('not available'); return; }
    const { name, http: hp } = ports(gloveHost);
    const up = http.request({ host: name, port: hp, path: target + url.search, method: req.method, timeout: 8000 }, (r) => {
      res.writeHead(r.statusCode || 502, { 'content-type': r.headers['content-type'] || 'text/plain', 'cache-control': 'no-store' });
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('glove did not answer')));
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    req.pipe(up);
    return;
  }
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end('Build the app first: npm run build'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/relay') { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (page) => {
  pages.add(page);
  page.send(JSON.stringify(relayStatus()));
  page.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.cmd === 'connect' && typeof m.host === 'string') { gloveHost = m.host.trim(); streaming = false; connectGlove(); }
    else if (m.cmd === 'start') { streaming = true; if (gloveWs?.readyState === 1) gloveWs.send(`rec:start:${udpPort}`); }
    else if (m.cmd === 'stop') { streaming = false; if (gloveWs?.readyState === 1) gloveWs.send('rec:stop'); }
    toPages(relayStatus());
  });
  page.on('close', () => { pages.delete(page); if (!pages.size && streaming) { streaming = false; if (gloveWs?.readyState === 1) gloveWs.send('rec:stop'); } });
});

// A network error must never end a recording session: log it and carry on.
process.on('uncaughtException', (e) => console.error('relay error (ignored):', e.message));
process.on('unhandledRejection', (e) => console.error('relay rejection (ignored):', e?.message ?? e));

server.listen(PORT, HOST, () => {
  console.log(`Recorder: http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}  (glove: ${gloveHost || 'not set yet'})`);
  if (gloveHost) connectGlove();
});
