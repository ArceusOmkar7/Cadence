// Plays simulated matches using the REAL glove recordings: each swing the simulated player makes is a recorded stroke that went through the live
// classifier (detector -> window -> features -> XGBoost). It tells us how the game behaves with the glove's real hit rate (and its confusions),
// not how it feels: the recorded strokes were not played to a ball in this game, so the timing is a stated assumption (Gaussian, below).
// Skipped when the dataset folder is not on this machine (it is git-ignored). Writes test/out/game-sim.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import detectorJson from '../config/detector.json';
import type { DetectorConfig } from '../src/detector';
import { GameEngine, type Swing } from '../src/game/engine';
import { LEVELS, STROKES, mulberry32, type Stroke } from '../src/game/shots';
import { LiveClassifier, type LiveResult, type Mode } from '../src/ml/liveClassifier';
import type { CompactModel } from '../src/ml/xgb';
import type { ImuRec } from '../src/protocol';

const SESSIONS = ['20261025-172341', '20261025-162140-re-exported'];
const dir = (s: string) => new URL(`../../dataset/${s}/`, import.meta.url);
const have = SESSIONS.every((s) => existsSync(new URL('derived.csv', dir(s))));
const model = (n: number) => JSON.parse(readFileSync(new URL(`../public/models/stroke_live${n}.json`, import.meta.url), 'utf8')) as CompactModel;
const MIN_CONF = Number(process.env.MIN_CONF ?? 0.45);

interface Item { truth: Stroke; label: string | null; confidence: number; energy: number; delayMs: number; raw: string; rawConf: number }

function load(session: string): { pool: Item[]; sets: number } {
  const lines = readFileSync(new URL('derived.csv', dir(session)), 'utf8').split('\n');
  const h = lines[0].split(','), ix = (n: string) => h.indexOf(n);
  const bySet = new Map<string, { boot: number; rec: ImuRec }[]>();
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const c = l.split(','), id = c[ix('set_id')], n = (k: string) => Number(c[ix(k)]);
    if (!bySet.has(id)) bySet.set(id, []);
    bySet.get(id)!.push({ boot: n('boot_id'), rec: { tUs: n('t_us'), seq: n('seq'), raw: [], q: [n('qw'), n('qx'), n('qy'), n('qz')], accH: [n('acc_x_g'), n('acc_y_g'), n('acc_z_g')], gyroH: [n('gyro_x_dps'), n('gyro_y_dps'), n('gyro_z_dps')], curl: [], pressure: 0 } });
  }
  const sets = readFileSync(new URL('sets.csv', dir(session)), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const events = readFileSync(new URL('events.csv', dir(session)), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const pool: Item[] = []; let used = 0;
  for (const [setId, label, , kind, , , , , , status] of sets) {
    if (kind !== 'stroke' || !(status === 'ok' || status === 'flagged') || !STROKES.includes(label as Stroke) || !bySet.has(setId)) continue;
    used++;
    const truthT = events.filter((e) => e[1] === setId && e[5] === 'ok').map((e) => Number(e[3]));
    const lc = new LiveClassifier({ fast: model(160), accurate: model(320) }, detectorJson as DetectorConfig);
    lc.mode = 'fast';
    const res: LiveResult[] = []; lc.onResult = (r) => res.push(r);
    for (const { rec, boot } of bySet.get(setId)!) lc.push(rec, boot, 0);
    for (const r of res) {
      if (!truthT.some((t) => Math.abs(t - r.tPeakUs) < 150_000)) continue; // a detector trigger that is not one of the labelled strokes
      const readable = r.status === 'ok' && r.label !== 'none' && r.confidence >= MIN_CONF;
      pool.push({ truth: label as Stroke, label: readable ? r.label : null, confidence: readable ? r.confidence : 0, energy: r.peakEnergy, delayMs: (r.tClassUs - r.tPeakUs) / 1000, raw: r.status === 'ok' ? r.label! : r.status, rawConf: r.confidence });
    }
  }
  return { pool, sets: used };
}

type Player = 'recorded' | 'held-out-like' | 'recorded-late' | 'exact' | 'always-forehand';
/** leave-one-set-out recall of the fast model (public/models/stroke_live160.json evidence): what the glove gets right on strokes it has NOT been trained on */
const HELD_OUT_RECALL: Record<Stroke, number> = { forehand_drive: 0.69, backhand_drive: 0.91, smash: 0.58, push: 0.82 };

function match(levelIndex: number, seed: number, player: Player, pool: Item[]) {
  const rng = mulberry32(seed * 7919 + 13);
  const gauss = () => { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const by = (s: Stroke) => pool.filter((p) => p.truth === s);
  const eng = new GameEngine(1, seed);
  let now = 0; eng.start(levelIndex, now);
  const queue: { at: number; swing: Swing }[] = [];
  let calledRight = 0, calls = 0, mishits = 0, guard = 0; const energies: number[] = [];
  while (eng.phase !== 'over' && guard++ < 600000) {
    now += 8; eng.update(now);
    for (const e of eng.drain()) {
      if (e.t === 'incoming' && !e.faulty) {
        const want = player === 'always-forehand' ? 'forehand_drive' : e.inc.required;
        const contact = now + e.inc.strike.t * 1000;
        // human reaction: a ball that arrives sooner than ~0.6 s after the opponent's hit cannot be met on time
        const jitter = gauss() * (player === 'recorded-late' ? 140 : 60) + (player === 'recorded-late' ? 90 : 0) + Math.max(0, 600 - e.inc.strike.t * 1000);
        if (player === 'exact') queue.push({ at: contact + jitter, swing: { peakMs: contact + jitter, stroke: e.inc.required, confidence: 0.9, power: 0.5, aim: { dx: 0, dz: 0 } } });
        else {
          let it = by(want)[Math.floor(rng() * by(want).length)];
          if (player === 'held-out-like' && rng() > HELD_OUT_RECALL[want]) { // a miss: another stroke, or unreadable ("none"), in equal shares of the remaining outcomes
            const others = [...STROKES.filter((x) => x !== want), null]; const wrong = others[Math.floor(rng() * others.length)];
            it = { ...it, label: wrong, confidence: wrong ? 0.7 : 0 };
          }
          const rank = energies.length >= 5 ? energies.filter((x) => x < it.energy).length / energies.length : 0.5; energies.push(it.energy);
          queue.push({ at: contact + jitter + it.delayMs, swing: { peakMs: contact + jitter, stroke: it.label as Stroke | null, confidence: it.confidence, power: rank, aim: { dx: 0, dz: 0 } } });
        }
      }
      if (e.t === 'player-hit') { calls++; if (e.match >= 0.99) calledRight++; if (e.mishit) mishits++; }
    }
    while (queue.length && queue[0].at <= now) eng.swing(queue.shift()!.swing, now);
    queue.sort((a, b) => a.at - b.at);
  }
  return { won: eng.score.you > eng.score.opp, you: eng.score.you, opp: eng.score.opp, calls, calledRight, mishits, arcade: eng.arcade };
}

describe.skipIf(!have)('simulated matches with recorded strokes', () => {
  it('reports how each level plays with the real classifier', () => {
    const loaded = SESSIONS.map(load), pool = loaded.flatMap((l) => l.pool);
    const lines: string[] = [];
    lines.push(`strokes used: ${pool.length} from ${loaded.reduce((s, l) => s + l.sets, 0)} kept sets of ${SESSIONS.length} sessions (same player)`);
    for (const s of STROKES) { const p = pool.filter((x) => x.truth === s); lines.push(`  ${s}: ${p.length} strokes, classifier gave the right label ${Math.round((100 * p.filter((x) => x.label === s).length) / p.length)}%, unreadable ${Math.round((100 * p.filter((x) => x.label === null).length) / p.length)}%`); }
    for (const t of [0.25, 0.35, 0.45, 0.55]) {
      const right = pool.filter((x) => x.raw === x.truth && x.rawConf >= t).length, wrong = pool.filter((x) => x.raw !== x.truth && x.raw !== 'none' && x.raw !== 'gap' && x.raw !== 'warmup' && x.rawConf >= t).length;
      lines.push(`  confidence threshold ${t}: right ${Math.round((100 * right) / pool.length)}%, other stroke ${Math.round((100 * wrong) / pool.length)}%, unreadable ${Math.round((100 * (pool.length - right - wrong)) / pool.length)}%`);
    }
    lines.push('NOTE: the models were trained on these recordings, so the "recorded" player sees in-sample outputs (no stroke is ever confused for another); "held-out-like" uses the measured leave-one-set-out recall instead.');
    lines.push('timing assumptions (not measured): swing error is Gaussian, sd 60 ms ("late" player: +90 ms, sd 140 ms), plus late by the amount a ball arrives sooner than 0.6 s; classification latency is the recorded one');
    const N = 40;
    for (const player of ['exact', 'recorded', 'held-out-like', 'recorded-late', 'always-forehand'] as Player[]) {
      lines.push(`\nplayer = ${player}`);
      LEVELS.forEach((lv, i) => {
        const r = Array.from({ length: N }, (_, k) => match(i, k + 1, player, pool));
        const won = r.filter((x) => x.won).length, calls = r.reduce((s, x) => s + x.calls, 0), right = r.reduce((s, x) => s + x.calledRight, 0), mis = r.reduce((s, x) => s + x.mishits, 0);
        const pts = r.reduce((s, x) => s + x.you, 0) / N, opp = r.reduce((s, x) => s + x.opp, 0) / N;
        lines.push(`  ${lv.name.padEnd(12)} matches won ${String(won).padStart(2)}/${N}  avg score ${pts.toFixed(1)}-${opp.toFixed(1)}  returns ${(calls / N).toFixed(1)}/match  right stroke ${calls ? Math.round((100 * right) / calls) : 0}%  mishit ${calls ? Math.round((100 * mis) / calls) : 0}%`);
      });
    }
    mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
    writeFileSync(new URL('./out/game-sim.txt', import.meta.url), lines.join('\n') + '\n');
    expect(pool.length).toBeGreaterThan(100);
  }, 300_000);
});

export type { Mode };
