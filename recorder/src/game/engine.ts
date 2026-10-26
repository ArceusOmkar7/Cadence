// The rally engine: who hits when, what counts as a point, scoring, and the opponent. No DOM, no Three.js; time comes in through update(now).
// The glove's stroke answer arrives ~0.2 s after the swing, so the ball does not fly past you: when it reaches your strike plane it hangs
// (a "hit-stop") until your swing is classified, then goes back the way your stroke, timing and intensity decide.
import { STEP, copyBall, stepBall, type Ball } from './physics';
import { LEVELS, makeIncoming, makeReturn, mulberry32, pickStroke, spoil, type Incoming, type Level, type Rng, type Stroke } from './shots';

export type Phase = 'ready' | 'serving' | 'rally' | 'contact' | 'point' | 'over';
export type Grade = 'perfect' | 'great' | 'ok' | 'early' | 'late';
export type Side = 'player' | 'opp';

/** One swing, already classified. peakMs is when the swing peaked (same clock as update(now)). stroke null = the glove could not tell. */
export interface Swing { peakMs: number; stroke: Stroke | null; confidence: number; power: number; aim: { dx: number; dz: number } }

export type GameEvent =
  | { t: 'serve-wait' }
  | { t: 'incoming'; inc: Incoming; serve: boolean; faulty: boolean }
  | { t: 'bounce'; x: number; z: number; side: Side; speed: number }
  | { t: 'contact-open' }
  | { t: 'player-hit'; stroke: Stroke; required: Stroke; grade: Grade; match: number; quality: number; points: number; kmh: number; mishit: boolean; combo: number }
  | { t: 'fault'; who: Side; why: 'net' | 'out' | 'short' }
  | { t: 'point'; winner: Side; why: 'net' | 'out' | 'short' | 'player-miss' | 'opp-miss' | 'late'; bonus: number }
  | { t: 'swing-wasted' }
  | { t: 'match-over'; won: boolean };

export const MATCH_POINTS = 7;
const WINDOW_EARLY = 450, WINDOW_LATE = 350, HOLD_MS = 600; // how far from the ideal moment a swing still counts, and how long the ball waits for the glove
const AI_STRIKE_Z = -1.68;
const COMPAT: Record<Stroke, Record<Stroke, number>> = {
  forehand_drive: { forehand_drive: 1, backhand_drive: 0.5, smash: 0.55, push: 0.4 },
  backhand_drive: { forehand_drive: 0.5, backhand_drive: 1, smash: 0.5, push: 0.4 },
  smash: { forehand_drive: 0.55, backhand_drive: 0.45, smash: 1, push: 0.2 },
  push: { forehand_drive: 0.4, backhand_drive: 0.4, smash: 0.2, push: 1 },
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function gradeOf(deltaMs: number): Grade {
  const a = Math.abs(deltaMs);
  return a < 80 ? 'perfect' : a < 170 ? 'great' : a < 290 ? 'ok' : deltaMs < 0 ? 'early' : 'late';
}
const TIMING: Record<Grade, [number, number]> = { perfect: [1, 2], great: [0.8, 1.5], ok: [0.55, 1.2], early: [0.35, 1], late: [0.35, 1] }; // [quality share, score multiplier]

export class GameEngine {
  phase: Phase = 'ready';
  levelIndex = 0;
  score = { you: 0, opp: 0 };
  arcade = 0;
  combo = 0;
  bestCombo = 0;
  hits = 0; right = 0;
  ball: Ball | null = null;
  /** the ball is held at the strike plane waiting for your swing */
  frozen = false;
  /** the current incoming ball (what the player must answer), null after the return */
  incoming: Incoming | null = null;
  hitter: Side = 'opp';
  contactAt = 0;
  contactPos: { x: number; y: number; z: number } | null = null;
  /** where the opponent will be standing when it meets the ball */
  aiX = 0;
  events: GameEvent[] = [];
  lastShot: { kmh: number; stroke: Stroke } | null = null;

  private rng: Rng;
  private last = 0;
  private acc = 0;
  private nextAt = 0;
  private bouncesRecv = 0;
  private willReturn = true;
  private threat = 0.4;
  private shotQuality = 0.6;
  private queued: Swing | null = null;
  private tail = 0;
  private exchange = 0;
  /** seconds of flight since the current incoming ball was hit (the ball clock; it stops while the ball waits at your paddle) */
  flightT = 0;

  constructor(private readonly fhSign: number, seed = Date.now()) { this.rng = mulberry32(seed); }

  get level(): Level { return LEVELS[this.levelIndex]; }
  get receiver(): Side { return this.hitter === 'player' ? 'opp' : 'player'; }
  /** the ball has bounced on the receiver's half once: it is now live for a return */
  get live(): boolean { return this.bouncesRecv === 1; }

  start(levelIndex: number, now: number): void {
    this.levelIndex = clamp(levelIndex, 0, LEVELS.length - 1);
    this.score = { you: 0, opp: 0 }; this.arcade = 0; this.combo = 0; this.bestCombo = 0; this.hits = 0; this.right = 0;
    this.ball = null; this.incoming = null; this.frozen = false; this.queued = null; this.events = [];
    this.last = now; this.beginServe(now);
  }

  drain(): GameEvent[] { const e = this.events; this.events = []; return e; }

  private beginServe(now: number): void {
    this.phase = 'serving'; this.nextAt = now + 1300; this.ball = null; this.incoming = null; this.frozen = false; this.queued = null;
    this.events.push({ t: 'serve-wait' });
  }

  update(now: number): void {
    const dt = clamp((now - this.last) / 1000, 0, 0.05); this.last = now;
    if (this.phase === 'ready' || this.phase === 'over') return;
    if (this.phase === 'serving') { if (now >= this.nextAt) this.serve(); return; }
    if (this.phase === 'point') {
      this.tail -= dt; if (this.ball && this.tail > 0) this.advance(dt, now);
      if (now >= this.nextAt) {
        if (this.score.you >= MATCH_POINTS || this.score.opp >= MATCH_POINTS) { this.phase = 'over'; this.ball = null; this.events.push({ t: 'match-over', won: this.score.you > this.score.opp }); }
        else this.beginServe(now);
      }
      return;
    }
    if (this.phase === 'contact') {
      if (now - this.contactAt > HOLD_MS) { this.frozen = false; this.endPoint('opp', 'late', now); }
      return;
    }
    this.advance(dt, now);
  }

  private serve(): void {
    this.exchange = 0;
    const from = { x: (this.rng() - 0.5) * 0.6, y: 1.0, z: -1.62 };
    const inc = makeIncoming(this.rng, this.level, this.fhSign, from);
    this.launch(inc, inc.ball, true, false);
  }

  private launch(inc: Incoming, ball: Ball, serve: boolean, faulty: boolean): void {
    this.incoming = inc; this.ball = copyBall(ball); this.hitter = 'opp'; this.bouncesRecv = 0; this.frozen = false; this.phase = 'rally'; this.acc = 0; this.queued = null; this.flightT = 0;
    this.lastShot = { kmh: inc.kmh, stroke: inc.required };
    this.events.push({ t: 'incoming', inc, serve, faulty });
  }

  /** The glove (or a key) reports a classified swing. */
  swing(s: Swing, now: number): void {
    if (this.phase === 'contact') { this.tryResolve(s); return; }
    if (this.phase === 'rally' && this.receiver === 'player') {
      // an early swing: kept until the ball arrives, if it is still recent enough then
      if (now - s.peakMs <= WINDOW_EARLY + 900) { this.queued = s; return; }
    }
    this.events.push({ t: 'swing-wasted' });
  }

  private advance(dt: number, now: number): void {
    const b = this.ball; if (!b) return;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      const ev = stepBall(b); this.flightT += STEP;
      if (this.phase === 'point') { if (ev?.kind === 'floor') this.tail = Math.min(this.tail, 0.6); continue; }
      if (ev) { this.onTouch(ev, now); if (this.phase !== 'rally' || this.ball !== b) return; }
      if (Math.abs(b.z) > 4 || Math.abs(b.x) > 3) { this.onTouch({ kind: 'floor' }, now); return; }
      this.checkStrike(b, now); if (this.phase !== 'rally' || this.ball !== b) return;
    }
  }

  private onTouch(ev: { kind: 'table'; x: number; z: number; vIn: number } | { kind: 'net' } | { kind: 'floor' }, now: number): void {
    const hitter = this.hitter, recv = this.receiver;
    if (ev.kind === 'table') {
      const side: Side = ev.z > 0 ? 'player' : 'opp';
      this.events.push({ t: 'bounce', x: ev.x, z: ev.z, side, speed: ev.vIn });
      if (side === recv) {
        if (this.bouncesRecv === 0) { this.bouncesRecv = 1; if (recv === 'opp') this.decideAi(); }
        else this.endPoint(hitter, recv === 'player' ? 'player-miss' : 'opp-miss', now);
      } else if (this.bouncesRecv === 0) { this.events.push({ t: 'fault', who: hitter, why: 'short' }); this.endPoint(recv, 'short', now); }
    } else if (ev.kind === 'net') {
      this.events.push({ t: 'fault', who: hitter, why: 'net' }); this.endPoint(recv, 'net', now);
    } else if (this.bouncesRecv === 0) {
      this.events.push({ t: 'fault', who: hitter, why: 'out' }); this.endPoint(recv, 'out', now);
    } else this.endPoint(hitter, recv === 'player' ? 'player-miss' : 'opp-miss', now);
  }

  private decideAi(): void {
    // a clean shot is hard to answer; a sloppy one (wrong stroke, bad timing, mishit) is easy to attack
    const p = clamp(this.level.skill - 0.5 * this.threat * (0.35 + 0.65 * this.shotQuality) + (this.shotQuality < 0.7 ? 0.15 : 0), 0.05, 0.97);
    this.willReturn = this.rng() < p;
  }

  private checkStrike(b: Ball, now: number): void {
    if (!this.live) return;
    if (this.receiver === 'player') {
      if (this.incoming && b.z >= this.incoming.strikeZ) this.enterContact(b, now);
    } else if (this.willReturn) {
      if (b.z <= AI_STRIKE_Z) this.aiHit(b);
    } else if (b.z < -2.2) this.endPoint('player', 'opp-miss', now);
  }

  private aiHit(b: Ball): void {
    const from = { x: clamp(b.x, -0.95, 0.95), y: clamp(b.y, 0.95, 1.2), z: b.z };
    const lvl = { ...this.level, speed: this.level.speed * (1 + 0.06 * Math.min(this.exchange, 5)) }; // long rallies speed up
    const inc = makeIncoming(this.rng, lvl, this.fhSign, from, pickStroke(this.rng, lvl));
    const faulty = this.rng() < this.level.fault;
    const ball = faulty ? spoil(inc, this.rng() < 0.5 ? 'net' : 'out') : inc.ball;
    this.launch(inc, ball, false, faulty);
  }

  private enterContact(b: Ball, now: number): void {
    this.phase = 'contact'; this.frozen = true; this.contactAt = now; this.contactPos = { x: b.x, y: b.y, z: b.z };
    this.events.push({ t: 'contact-open' });
    const q = this.queued; this.queued = null;
    if (q) this.tryResolve(q);
  }

  private tryResolve(s: Swing): void {
    const delta = s.peakMs - this.contactAt;
    if (delta < -WINDOW_EARLY || delta > WINDOW_LATE) { this.events.push({ t: 'swing-wasted' }); return; }
    const inc = this.incoming!, b = this.ball!;
    const mishit = s.stroke === null;
    const played = s.stroke ?? inc.required;
    const match = mishit ? 0.3 : COMPAT[inc.required][played];
    const grade = gradeOf(delta);
    const conf = clamp((s.confidence - 0.5) / 0.4, 0, 1);
    let quality = 0.5 * match + 0.35 * TIMING[grade][0] + 0.15 * conf;
    if (mishit) quality *= 0.6;
    const shot = makeReturn(this.rng, { stroke: played, quality, power: s.power, aim: s.aim, contact: { x: b.x, y: b.y, z: b.z } });
    const combo = quality >= 0.55 ? this.combo + 1 : 0;
    const points = Math.round(100 * match * TIMING[grade][1] * (1 + 0.1 * Math.min(combo, 10)));
    this.combo = combo; this.bestCombo = Math.max(this.bestCombo, combo); this.arcade += points; this.hits++; if (match >= 0.99) this.right++;
    this.ball = copyBall(shot.ball); this.hitter = 'player'; this.bouncesRecv = 0; this.frozen = false; this.phase = 'rally'; this.incoming = null; this.acc = 0;
    this.exchange++; this.threat = shot.threat; this.shotQuality = quality; this.aiX = shot.landing.x; this.lastShot = { kmh: shot.kmh, stroke: played };
    this.events.push({ t: 'player-hit', stroke: played, required: inc.required, grade, match, quality, points, kmh: shot.kmh, mishit, combo });
  }

  private endPoint(winner: Side, why: Extract<GameEvent, { t: 'point' }>['why'], now: number): void {
    this.frozen = false; this.queued = null;
    let bonus = 0;
    if (winner === 'player') { this.score.you++; bonus = 300 + 50 * Math.min(this.combo, 10); this.arcade += bonus; } else { this.score.opp++; this.combo = 0; }
    this.phase = 'point'; this.nextAt = now + 1800; this.tail = 1.2; this.incoming = null;
    this.events.push({ t: 'point', winner, why, bonus });
  }
}
