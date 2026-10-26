// End-to-end test of the real app: headless Edge/Chrome driving the built page against the simulated glove through the relay.
//   npm run build && node server/e2e.mjs [outDir]      (needs Edge or Chrome installed; no glove needed)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve(process.argv[2] || 'e2e-out');
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) { console.error('No Edge/Chrome found'); process.exit(2); }

const procs = [spawn('node', ['server/fake-glove.mjs', '--port', '9100'], { stdio: 'inherit' }), spawn('node', ['server/relay.mjs'], { stdio: 'inherit', env: { ...process.env, PORT: '8798' } })];
const finish = async (code, browser) => { try { await browser?.close(); } catch { /* closing */ } procs.forEach((p) => p.kill()); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) { try { const t = await page.evaluate(() => document.body.innerText); console.log('   page says: ' + t.replace(/\s+/g, ' ').slice(0, 420)); await page.screenshot({ path: path.join(OUT, 'FAIL-' + results.length + '.png') }); } catch { /* page gone */ } } };
const fake = (q) => fetch('http://localhost:9100/fake/config?' + q, { method: 'POST' });

await sleep(1500);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1500,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });

const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (re, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await text())) return true; await sleep(250); } return false; };
const clickText = async (label, sel = 'button') => { const ok = await page.evaluate((l, s) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(l) && !x.disabled); if (b) b.click(); return !!b; }, label, sel); return ok; };
const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });

try {
  await page.goto('http://localhost:8798/', { waitUntil: 'load' });
  await check('page loads, relay reachable', await waitText(/Train/) && await waitText(/No glove selected|Glove connected/));
  // connect
  await page.$eval('input[aria-label="Glove address"]', (i) => { i.value = ''; });
  await page.type('input[aria-label="Glove address"]', 'localhost:9100');
  await clickText('Connect');
  await check('connects to the glove through the relay', await waitText(/Glove connected/));
  await check('recording is blocked until calibrated', await waitText(/Recording is blocked until: flat hand \(step 1\), fingers up \(step 2\), fist \(step 3\)/));
  await shot('01-session-uncalibrated');
  // calibration (simulated): each step is a 3 s countdown + 3 s capture
  for (const step of ['1 Flat hand', '2 Fingers up', '3 Fist']) {
    await clickText(step);
    await waitText(new RegExp('✓ ' + step), 20000);
  }
  await check('calibration steps complete', await waitText(/Calibration complete/, 8000));
  // session
  await clickText('Start session'); // refused until the ball choice is made
  await check('the session needs an explicit ball choice', await waitText(/Choose whether this session is with a ball/, 5000));
  await page.select('select[aria-label="Ball"]', 'no');
  await clickText('Start session');
  await check('session starts and opens the Record screen', await waitText(/READY/, 10000));
  // a 6-rep forehand set with 6 strokes
  await fake('strokes=6&interval=0.9&loss=0.004&burst=0&reboot=0');
  await page.$eval('input[type=number]', (i) => { i.value = '6'; i.dispatchEvent(new Event('change')); });
  await page.keyboard.press('Space');
  await check('countdown shows', await waitText(/Hold the ready position/, 6000));
  await shot('02-countdown');
  await check('recording shows the live count', await waitText(/RECORDING forehand drive/, 10000));
  await sleep(4500);
  await shot('03-recording');
  const mid = await text();
  await check('live detection counts strokes', /\b[1-6] \/ 6\b/.test(mid), (mid.match(/\b\d \/ 6\b/) || [''])[0]);
  await check('set ends by itself and is listed', await waitText(/forehand drive\s+6 \/ 6/, 45000));
  await sleep(500);
  // an idle set
  await fake('strokes=0');
  await clickText('0 · Idle');
  await sleep(500); // let the screen re-render into idle mode
  await page.$$eval('input[type=number]', (is) => { const i = is[is.length - 1]; i.value = '6'; i.dispatchEvent(new Event('change')); });
  await page.keyboard.press('Space');
  await check('idle set records and finishes', await waitText(/idle · rest\s+–/, 40000));
  await shot('04-sets');
  // review the stroke set (s1) from its row on the Record screen
  await page.evaluate(() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.cells[0].textContent.trim() === 's1'); [...row.querySelectorAll('button')].find((b) => b.textContent === 'Review').click(); });
  await waitText(/Re-run detector/, 10000);
  await sleep(900);
  await shot('05-review');
  const rows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter((r) => /forehand drive/.test(r.textContent)).length);
  await check('review screen lists the 6 detected events', rows === 6, `rows=${rows}`);
  // replay the first event on the 3D hand
  await page.evaluate(() => { [...document.querySelectorAll('tbody tr')].find((r) => /forehand drive/.test(r.textContent)).click(); });
  await sleep(300);
  await clickText('▶ Replay');
  await check('replay runs on the 3D hand', await waitText(/Playing…/, 3000));
  await sleep(1500);
  // add a missed event by clicking empty plot area, then delete it again
  await page.evaluate(() => { const c = document.querySelector('canvas.plot'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * 0.02, clientY: r.top + 40, bubbles: true })); });
  await sleep(600);
  const rows2 = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter((r) => /forehand drive/.test(r.textContent)).length);
  await check('clicking the plot adds a manual event', rows2 === 7, `rows=${rows2}`);
  await clickText('Delete');
  await sleep(500);
  await check('a selected event can be deleted', (await text()).includes('manual · deleted'));
  // dashboard
  await clickText('Dashboard', 'button.tab');
  await sleep(500);
  await shot('06-dashboard');
  const dash = await text();
  await check('dashboard counts the 6 valid events', /forehand drive\s+6\s+6 \/ 0/.test(dash));
  // export as zip
  await clickText('Session', 'button.tab');
  await sleep(300);
  await clickText('Export as zip');
  const zip = await (async () => { for (let i = 0; i < 40; i++) { const f = fs.readdirSync(OUT).find((x) => x.endsWith('.zip')); if (f) return f; await sleep(250); } return null; })();
  await check('session exports as a zip', !!zip, zip || '');
  await check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await check('test run completed', false, String(e));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await finish(failed ? 1 : 0, browser);
