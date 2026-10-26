import { describe, expect, it } from 'vitest';
import { BALL_R, TABLE, predict, solveLaunch, spinFor, stepBall, type Ball } from '../src/game/physics';
import { GameEngine, gradeOf, type GameEvent } from '../src/game/engine';
import { LEVELS, STROKES, makeIncoming, makeReturn, mulberry32, spoil } from '../src/game/shots';

const drop = (over: Partial<Ball>): Ball => ({ x: 0, y: 1.2, z: 0.5, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, ...over });

describe('physics', () => {
  it('bounces on the table with about 0.93 of the speed and lands where solveLaunch aimed', () => {
    const b = drop({});
    let ev: ReturnType<typeof stepBall> = null; for (let i = 0; i < 2000 && !(ev = stepBall(b)); i++);
    expect(ev?.kind).toBe('table');
    expect(ev?.kind === 'table' ? b.vy / ev.vIn : 0).toBeCloseTo(0.93, 2);
    const s = solveLaunch({ x: 0.1, y: 1, z: -1.6 }, spinFor(0, 1, 40), 0.3, 0.8, 0.6);
    const pr = predict(s, 1, 1.6);
    expect(pr.bounce!.x).toBeCloseTo(0.3, 1); expect(pr.bounce!.z).toBeCloseTo(0.8, 1);
  });
  it('topspin kicks forward off the table and backspin slows (the bounce alone)', () => {
    const run = (top: number) => { const b = drop({ y: TABLE.top + BALL_R + 0.003, z: 0.4, vy: -3, vz: 3, ...spinFor(0, 1, top) }); for (let n = 0; n < 50; n++) if (stepBall(b)?.kind === 'table') return b.vz; return NaN; };
    expect(run(60)).toBeGreaterThan(run(0)); expect(run(-60)).toBeLessThan(run(0));
  });
  it('stops a ball low at the net and lets one clear it', () => {
    const low = drop({ y: 0.8, z: -0.3, vz: 4 }); let hit = false; for (let i = 0; i < 400; i++) if (stepBall(low)?.kind === 'net') hit = true;
    expect(hit).toBe(true);
    const high = drop({ y: 1.2, z: -0.3, vz: 4 }); hit = false; for (let i = 0; i < 100; i++) if (stepBall(high)?.kind === 'net') hit = true;
    expect(hit).toBe(false); void BALL_R; void TABLE;
  });
});

describe('shots', () => {
  it('every generated incoming ball is playable at every level and for every stroke', () => {
    const rng = mulberry32(5);
    for (const lvl of LEVELS) for (const st of STROKES) for (let i = 0; i < 25; i++) {
      const inc = makeIncoming(rng, lvl, 1, { x: (rng() - 0.5) * 0.8, y: 0.95, z: -1.65 }, st);
      expect(inc.required).toBe(st);
      expect(inc.strike.t).toBeGreaterThan(0.4);
      expect(inc.landing.z).toBeGreaterThan(0);
    }
  });
  it('forehand balls land on the forehand side, mirrored for a left hander', () => {
    const rng = mulberry32(9);
    for (const fh of [1, -1]) for (let i = 0; i < 20; i++) expect(Math.sign(makeIncoming(rng, LEVELS[0], fh, { x: 0, y: 1, z: -1.6 }, 'forehand_drive').landing.x)).toBe(fh);
  });
  it('spoiled balls are really faults', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 12; i++) {
      const inc = makeIncoming(rng, LEVELS[1], 1, { x: 0, y: 1, z: -1.6 }, 'forehand_drive');
      const net = predict(spoil(inc, 'net'), 1, inc.strikeZ), out = predict(spoil(inc, 'out'), 1, inc.strikeZ);
      expect(net.hitNet || net.netClear < 0.01 || !net.bounce).toBe(true); expect(out.bounce).toBeNull();
    }
  });
  it('a clean stroke mostly lands, a sloppy one often does not', () => {
    const rng = mulberry32(11);
    const rate = (q: number) => { let ok = 0; const N = 150; for (let i = 0; i < N; i++) {
      const r = makeReturn(rng, { stroke: STROKES[i % 4], quality: q, power: 0.5, aim: { dx: 0, dz: 0 }, contact: { x: (rng() - 0.5) * 0.8, y: 1.0 + (i % 4 === 2 ? 0.3 : 0), z: i % 4 === 3 ? 0.9 : 1.62 } });
      const p = predict(r.ball, -1, -1.9); if (p.bounce && !p.hitNet && p.netClear > 0) ok++; } return ok / N; };
    expect(rate(1)).toBeGreaterThan(0.95); expect(rate(0.15)).toBeLessThan(0.85); expect(rate(1)).toBeGreaterThan(rate(0.15));
  });
});

describe('engine', () => {
  it('grades timing', () => { expect(gradeOf(10)).toBe('perfect'); expect(gradeOf(-100)).toBe('great'); expect(gradeOf(-400)).toBe('early'); expect(gradeOf(320)).toBe('late'); });

  /** plays a full match with a perfect, always-on-time player and returns the events */
  function play(seed: number, levelIndex: number, perfect: boolean) {
    const eng = new GameEngine(1, seed);
    let now = 1000; eng.start(levelIndex, now);
    const log: GameEvent[] = []; let guard = 0;
    while (eng.phase !== 'over' && guard++ < 400000) {
      now += 8; eng.update(now);
      for (const e of eng.drain()) {
        log.push(e);
        if (e.t === 'contact-open' && perfect) {
          const need = eng.incoming!.required;
          eng.swing({ peakMs: now - 20, stroke: need, confidence: 0.9, power: 0.5, aim: { dx: 0, dz: 0 } }, now + 185);
        }
      }
    }
    return { eng, log };
  }
  it('a match against Rookie ends, with a result and a sensible score', () => {
    const { eng, log } = play(1, 0, true);
    expect(eng.phase).toBe('over'); expect(log.some((e) => e.t === 'match-over')).toBe(true);
    expect(Math.max(eng.score.you, eng.score.opp)).toBe(7);
    expect(eng.arcade).toBeGreaterThan(0);
  });
  it('doing nothing loses every point to a late ball', () => {
    const { eng, log } = play(2, 1, false);
    expect(eng.score.you).toBeLessThan(7); expect(eng.score.opp).toBe(7);
    expect(log.filter((e) => e.t === 'point' && e.why === 'late' ).length).toBeGreaterThan(3);
  });
  it('a perfect player beats Rookie in most seeds and Champion is harder', () => {
    let rookie = 0, champ = 0;
    for (let s = 1; s <= 8; s++) { if (play(s, 0, true).eng.score.you >= 7) rookie++; if (play(s, 3, true).eng.score.you >= 7) champ++; }
    expect(rookie).toBeGreaterThanOrEqual(6); expect(champ).toBeLessThanOrEqual(rookie);
  });
  it('the ball is held while waiting for the classifier, then flies on', () => {
    const eng = new GameEngine(1, 4); let now = 0; eng.start(0, now);
    let open = false, g = 0;
    while (!open && g++ < 100000) { now += 8; eng.update(now); open = eng.drain().some((e) => e.t === 'contact-open'); }
    expect(open).toBe(true); expect(eng.frozen).toBe(true);
    const z = eng.ball!.z; now += 100; eng.update(now); expect(eng.ball!.z).toBe(z);
    eng.swing({ peakMs: now - 150, stroke: eng.incoming!.required, confidence: 0.9, power: 0.5, aim: { dx: 0, dz: 0 } }, now);
    expect(eng.frozen).toBe(false); expect(eng.phase).toBe('rally'); expect(eng.hitter).toBe('player');
  });
  it('a swing that peaks too early or too late is wasted and the point is lost', () => {
    const eng = new GameEngine(1, 4); let now = 0; eng.start(0, now);
    let g = 0, open = false; while (!open && g++ < 100000) { now += 8; eng.update(now); open = eng.drain().some((e) => e.t === 'contact-open'); }
    eng.swing({ peakMs: now - 900, stroke: 'forehand_drive', confidence: 0.9, power: 0.5, aim: { dx: 0, dz: 0 } }, now);
    expect(eng.phase).toBe('contact');
    now += 700; eng.update(now); expect(eng.phase).toBe('point'); expect(eng.score.opp).toBe(1);
  });
});
