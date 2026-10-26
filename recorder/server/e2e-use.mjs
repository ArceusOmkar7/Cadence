// End-to-end test of the Use section: headless Edge/Chrome, the built app, the relay and the simulated glove.
//   npm run build && node server/e2e-use.mjs [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve(process.argv[2] || 'e2e-out-use');
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) { console.error('No Edge/Chrome found'); process.exit(2); }

const procs = [spawn('node', ['server/fake-glove.mjs', '--port', '9110', '--calibrated'], { stdio: 'inherit' }), spawn('node', ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8799' } })];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code, browser) => { try { await browser?.close(); } catch { /* closing */ } procs.forEach((p) => p.kill()); process.exit(code); };
const results = [];
let page;
const check = async (name, ok, detail = '') => {
  results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) { try { console.log('   page says: ' + (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500)); await page.screenshot({ path: path.join(OUT, 'FAIL-' + results.length + '.png') }); } catch { /* gone */ } }
};

await sleep(1500);
await fetch('http://localhost:9110/fake/config?strokes=40&interval=1.2', { method: 'POST' });
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1500,1000'] });
page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (re, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await text())) return true; await sleep(250); } return false; };
const click = (label, sel = 'button') => page.evaluate((l, s) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(l) && !x.disabled); if (b) b.click(); return !!b; }, label, sel);
const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });

try {
  await page.goto('http://localhost:8799/', { waitUntil: 'load' });
  await check('page loads with a Train / Use switch', await waitText(/Train/) && await waitText(/Use/));
  await page.$eval('input[aria-label="Glove address"]', (i) => { i.value = ''; });
  await page.type('input[aria-label="Glove address"]', 'localhost:9110');
  await click('Connect');
  await check('glove connects', await waitText(/Glove connected/));
  await click('Use', 'button.sec');
  await check('Use shows the empty state', await waitText(/Play a stroke/));
  await check('Use shows the "How reliable is this?" evidence', await waitText(/How reliable is this/));
  await check('stream starts and the status listens', await waitText(/Listening · \d+ samples\/s/, 20000));
  let rows = 0; for (let i = 0; i < 80 && rows < 4; i++) { await sleep(500); rows = (await page.$$('.trow')).length; }
  await check('strokes appear on the tape', rows >= 4, `rows=${rows}`);
  await check('the 3D hand canvas is on the Use screen', (await page.$$('.uhand canvas')).length === 1 && (await page.$eval('.uhand canvas', (c) => c.clientHeight)) > 200);
  await click('side', '.uhand button');
  await sleep(600);
  await shot('use-desktop'); for (let k = 0; k < 4; k++) { await sleep(170); await (await page.$('.uhand')).screenshot({ path: path.join(OUT, 'hand-' + k + '.png') }); }
  const ans = await page.$eval('.uname', (e) => e.textContent);
  await check('the answer is a stroke name, Unsure, Not a stroke or Missed it', /Forehand|Backhand|Smash|Push|Unsure|Not a stroke|Missed it/.test(ans), ans);
  const tally = await page.$eval('.utally', (e) => e.textContent);
  await check('tally chips list the four strokes', /Forehand/.test(tally) && /Backhand/.test(tally) && /Smash/.test(tally) && /Push/.test(tally), tally.replace(/\s+/g, ' '));
  // fast <-> accurate
  await click('Accurate', '.seg button');
  await check('Accurate toggle shows its latency', await waitText(/345 ms after the swing peak/));
  await click('Fast', '.seg button');
  await check('Fast toggle shows its latency', await waitText(/185 ms after the swing peak/));
  // drill
  await click('Drill', '.seg button');
  await check('Drill mode shows the target picker and hit rate', await waitText(/1 Forehand/) && await waitText(/hit rate/));
  await page.keyboard.press('3');
  await check('key 3 selects Smash as the target', await waitText(/Aim for Smash/));
  await waitText(/Match|Wrong stroke|Too unsure/, 30000);
  await shot('use-drill');
  // phone width
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await check('no horizontal scroll at 390 px', overflow <= 1, `overflow=${overflow}px`);
  await shot('use-phone');
  await page.setViewport({ width: 1440, height: 900 });
  // leaving Use returns to Train and stops the stream
  await click('Train', 'button.sec');
  await check('Train section comes back', await waitText(/Session/) && await waitText(/Calibration/));
  await check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { console.log('E2E CRASH', e); results.push({ name: 'crash', ok: false }); }
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
await finish(bad ? 1 : 0, browser);
