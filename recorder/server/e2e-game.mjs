// End-to-end test of the Game section: headless Edge/Chrome, the built app, the relay and the simulated glove.
//   npm run build && node server/e2e-game.mjs [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve(process.argv[2] || 'e2e-out-game');
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) { console.error('No Edge/Chrome found'); process.exit(2); }

const procs = [spawn('node', ['server/fake-glove.mjs', '--port', '9120', '--calibrated'], { stdio: 'inherit' }), spawn('node', ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8797' } })];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code, browser) => { try { await browser?.close(); } catch { /* closing */ } procs.forEach((p) => p.kill()); process.exit(code); };
const results = [];
let page;
const check = async (name, ok, detail = '') => {
  results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) { try { console.log('   page says: ' + (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400)); await page.screenshot({ path: path.join(OUT, 'FAIL-' + results.length + '.png') }); } catch { /* gone */ } }
};

await sleep(1500);
const fake = (q) => fetch('http://localhost:9120/fake/config?' + q, { method: 'POST' });
await fake('strokes=0'); // keyboard phase: the simulated glove stays still
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1500,1000'] });
page = await browser.newPage();
await page.setViewport({ width: 1440, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/503/.test(m.text())) errors.push(m.text()); });
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (re, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await text())) return true; await sleep(200); } return false; };
const click = (label, sel = 'button') => page.evaluate((l, s) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(l) && !x.disabled); if (b) b.click(); return !!b; }, label, sel);
const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
const KEY = { FH: '1', BH: '2', SM: '3', PU: '4' };

try {
  await page.goto('http://localhost:8797/', { waitUntil: 'load' });
  await sleep(1500);
  await check('a Game tab sits next to Train and Use', (await page.$$('button.sec')).length === 3 && await waitText(/Game/));
  await page.$eval('input[aria-label="Glove address"]', (i) => { i.value = ''; });
  await page.type('input[aria-label="Glove address"]', 'localhost:9120');
  await click('Connect');
  await check('glove connects', await waitText(/Glove connected/));
  await click('Game', 'button.sec');
  await check('the menu lists the four opponents', await waitText(/Rookie/) && await waitText(/Champion/) && await waitText(/First to 7/));
  await check('one WebGL canvas for the game', (await page.$$('.gamecanvas canvas')).length === 1 && (await page.$eval('.gamecanvas canvas', (c) => c.clientHeight)) > 300);
  await check('the glove is live in the game', await waitText(/Glove live/, 20000));
  await sleep(1500);
  await check('the Blender arena loaded', !(await text()).includes('plain arena'));
  await shot('game-menu');
  await click('Start');
  await check('the menu closes and the scoreboard shows 0 – 0 against Rookie', await waitText(/You\s*0\s*–\s*0\s*Rookie/) && (await page.$eval('.gmenu', (m) => m.hidden)));
  await check('a stroke is called (cue chip)', await waitText(/FH\s+Forehand|BH\s+Backhand/, 20000));

  // play with the keyboard: answer every call at the moment the ball is held at the paddle
  let played = 0, scored = 0, shots = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 70000 && played < 14) {
    const st = await page.evaluate(() => ({ cue: document.querySelector('.gchip b')?.textContent || '', now: [...document.querySelectorAll('.gpop')].some((x) => x.textContent === 'SWING!') }));
    if (st.now && KEY[st.cue]) { await page.keyboard.press(KEY[st.cue]); played++; await sleep(300); if (shots++ < 3) await shot('game-hit-' + shots); }
    else await sleep(60);
  }
  await check('answering the calls with keys 1-4 returns balls', played >= 3, `answered ${played}`);
  const t = await text();
  const pts = Number((/(\d+)\s*pts/.exec(t) ?? [])[1] ?? 0);
  await check('the score goes up', pts > 0, `${pts} pts`);
  scored = pts;
  await shot('game-play');
  // glove phase: no keys; the simulated glove swings every ~1.1 s and the classifier answers them
  await page.keyboard.press('Escape'); await sleep(300);
  await click('Start');
  await fake('strokes=80&interval=1.1'); // starts at the next stream start
  await click('Use', 'button.sec'); await sleep(500); await click('Game', 'button.sec'); await sleep(500); await click('Start');
  const seen = new Set(); const g0 = Date.now();
  while (Date.now() - g0 < 90000 && seen.size < 1) {
    const t2 = await text();
    for (const w of ['PERFECT', 'GREAT', 'GOOD', 'EARLY', 'LATE', 'MISHIT']) if (t2.includes(w)) seen.add(w);
    await sleep(80);
  }
  await check('swings made by the glove (no keys) are graded in the game', seen.size > 0, [...seen].join(','));
  await shot('game-glove');
  // leave and come back
  await click('Use', 'button.sec');
  await check('Use still works after the game', await waitText(/Listening|Play a stroke|No glove yet|Waiting/, 20000));
  await click('Game', 'button.sec');
  await check('the Game menu comes back (fresh match)', await waitText(/Start \(Space\)/));
  await click('Train', 'button.sec');
  await check('Train comes back', await waitText(/Calibration/));
  await check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  void scored;
} catch (e) { console.log('E2E CRASH', e); results.push({ name: 'crash', ok: false }); }
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
await finish(bad ? 1 : 0, browser);
