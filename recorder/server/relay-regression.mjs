// Regression test: connect requests arriving while an earlier attempt is still connecting must not crash the relay.
//   node server/relay-regression.mjs
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const relay = spawn('node', ['server/relay.mjs'], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: '8795' } });
let exited = null; relay.on('exit', (c) => { exited = c; });
await new Promise((r) => setTimeout(r, 1800));
const ws = new WebSocket('ws://localhost:8795/relay'); await new Promise((r) => ws.once('open', r));
// a host that never answers, so the first attempt is still connecting when the second connect arrives
ws.send(JSON.stringify({ cmd: 'connect', host: '10.255.255.1' })); await new Promise((r) => setTimeout(r, 300));
ws.send(JSON.stringify({ cmd: 'connect', host: '10.255.255.2' })); await new Promise((r) => setTimeout(r, 300));
ws.send(JSON.stringify({ cmd: 'connect', host: 'localhost:9' })); await new Promise((r) => setTimeout(r, 1500));
console.log(exited === null ? 'relay still running: OK' : 'RELAY CRASHED, exit code ' + exited);
relay.kill(); process.exit(exited === null ? 0 : 1);
