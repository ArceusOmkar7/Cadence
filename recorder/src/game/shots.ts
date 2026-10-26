// Shot generation for the game: the balls the opponent plays to you, and the return your stroke produces.
// Every incoming ball is built from a target landing spot and checked against the real physics (physics.ts), so it is always playable.
import { TABLE, predict, solveLaunch, spinFor, speedOf, type Ball } from './physics';

export type Stroke = 'forehand_drive' | 'backhand_drive' | 'smash' | 'push';
export const STROKES: Stroke[] = ['forehand_drive', 'backhand_drive', 'smash', 'push'];
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function gauss(rng: Rng): number { const u = Math.max(1e-9, rng()), v = rng(); return clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v), -2, 2); }

export interface Level {
  name: string;
  blurb: string;
  /** ball speed factor: flight times are divided by this */
  speed: number;
  weights: Record<Stroke, number>;
  /** the opponent's chance of returning a clean average shot is about skill - 0.22 (see GameEngine.decideAi) */
  skill: number;
  /** chance that the opponent's own return is a fault (net or out) */
  fault: number;
  spin: number;
}
export const LEVELS: Level[] = [
  { name: 'Rookie', blurb: 'Forehands and backhands, slow balls.', speed: 0.8, weights: { forehand_drive: 0.5, backhand_drive: 0.5, smash: 0, push: 0 }, skill: 0.8, fault: 0.08, spin: 0.4 },
  { name: 'Club player', blurb: 'Short pushes join the mix.', speed: 1.0, weights: { forehand_drive: 0.36, backhand_drive: 0.36, smash: 0, push: 0.28 }, skill: 0.92, fault: 0.06, spin: 0.7 },
  { name: 'Regional', blurb: 'Lobs to smash, and faster balls.', speed: 1.2, weights: { forehand_drive: 0.3, backhand_drive: 0.3, smash: 0.22, push: 0.18 }, skill: 1.04, fault: 0.05, spin: 0.9 },
  { name: 'Champion', blurb: 'Quick, spinning, and no mercy.', speed: 1.5, weights: { forehand_drive: 0.28, backhand_drive: 0.28, smash: 0.24, push: 0.2 }, skill: 1.16, fault: 0.03, spin: 1.1 },
];

export interface Incoming {
  ball: Ball;
  required: Stroke;
  /** first bounce on the player's half */
  landing: { x: number; z: number };
  strikeZ: number;
  /** where and when (seconds after launch) the ball reaches the strike plane, per the real physics */
  strike: { x: number; y: number; z: number; t: number };
  kmh: number;
}

interface Plan { lx: number; lz: number; T: number; top: number; side: number; strikeZ: number; yLo: number; yHi: number; descending: boolean }

export function pickStroke(rng: Rng, lvl: Level): Stroke {
  let r = rng() * STROKES.reduce((s, k) => s + lvl.weights[k], 0);
  for (const k of STROKES) { r -= lvl.weights[k]; if (r <= 0) return k; }
  return 'forehand_drive';
}

function plan(rng: Rng, stroke: Stroke, lvl: Level, fhSign: number): Plan {
  const u = (a: number, b: number) => lerp(a, b, rng());
  switch (stroke) {
    case 'forehand_drive': return { lx: fhSign * u(0.2, 0.6), lz: u(0.5, 1.0), T: u(0.52, 0.68) / lvl.speed, top: u(20, 55) * lvl.spin, side: u(-6, 6) * lvl.spin, strikeZ: 1.62, yLo: 0.8, yHi: 1.25, descending: false };
    case 'backhand_drive': return { lx: -fhSign * u(0.2, 0.6), lz: u(0.5, 1.0), T: u(0.52, 0.68) / lvl.speed, top: u(20, 55) * lvl.spin, side: u(-6, 6) * lvl.spin, strikeZ: 1.62, yLo: 0.8, yHi: 1.25, descending: false };
    case 'push': return { lx: u(-0.45, 0.45), lz: u(0.22, 0.5), T: u(0.8, 0.95) / Math.sqrt(lvl.speed), top: -u(40, 70) * lvl.spin, side: 0, strikeZ: 0.9, yLo: 0.79, yHi: 1.1, descending: false };
    case 'smash': return { lx: u(-0.45, 0.45), lz: u(0.55, 1.0), T: u(1.0, 1.2) / Math.sqrt(lvl.speed), top: u(0, 15), side: 0, strikeZ: 1.75, yLo: 1.05, yHi: 1.7, descending: true };
  }
}

/** The opponent's ball to you. `from` is where the opponent meets it (a serve starts above the far end). */
export function makeIncoming(rng: Rng, lvl: Level, fhSign: number, from: { x: number; y: number; z: number }, forced?: Stroke): Incoming {
  const stroke = forced ?? pickStroke(rng, lvl);
  for (let i = 0; i < 240; i++) {
    const p = plan(rng, stroke, lvl, fhSign);
    const stage = Math.floor(i / 60); // a hard starting spot (far corner, low): allow slower, higher balls and a smaller net margin
    p.T *= [1, 1.3, 1.6, 2][stage];
    const dx = p.lx - from.x, dz = p.lz - from.z;
    const ball = solveLaunch(from, spinFor(dx, dz, p.top, p.side), p.lx, p.lz, p.T);
    const pr = predict(ball, 1, p.strikeZ);
    if (!pr.bounce || !pr.strike || pr.hitNet || pr.netClear < [0.035, 0.015, 0.01, 0][stage]) continue;
    if (Math.abs(pr.bounce.x - p.lx) > 0.12 || Math.abs(pr.bounce.z - p.lz) > 0.15 || Math.abs(pr.bounce.x) > TABLE.hw - 0.06) continue;
    const s = pr.strike;
    if (s.ball.y < p.yLo || s.ball.y > p.yHi || (p.descending && s.ball.vy >= 0) || s.t < 0.42 || s.t > 2.6) continue;
    return { ball, required: stroke, landing: { x: pr.bounce.x, z: pr.bounce.z }, strikeZ: p.strikeZ, strike: { x: s.ball.x, y: s.ball.y, z: s.ball.z, t: s.t }, kmh: speedOf(ball) * 3.6 };
  }
  if (stroke !== 'forehand_drive') return makeIncoming(rng, lvl, fhSign, from, 'forehand_drive');
  // last resorts: meet the ball from a neutral spot (the opponent "steps in"), never fail a rally over a hard starting position
  if (Math.abs(from.x) > 0.3 || from.y !== 1.0) return makeIncoming(rng, lvl, fhSign, { x: from.x * 0.4, y: 1.0, z: from.z }, 'forehand_drive');
  throw new Error(`could not generate a playable ball from (${from.x.toFixed(2)}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)})`);
}

/** Turns a good incoming ball into one the opponent fumbles: into the net or long. */
export function spoil(inc: Incoming, kind: 'net' | 'out'): Ball {
  const b = { ...inc.ball };
  for (let i = 0; i < 40; i++) {
    const pr = predict(b, 1, inc.strikeZ);
    if (kind === 'net' ? pr.hitNet || pr.netClear < -0.02 || !pr.bounce : !pr.bounce) break;
    if (kind === 'net') b.vy *= 0.85; else { b.vz *= 1.12; b.vx *= 1.05; }
  }
  return b;
}

// ----------------------------------------------------------------- the player's return
export interface ReturnSpec {
  stroke: Stroke;
  /** 0..1: how clean the stroke was (right stroke, on time, confident) */
  quality: number;
  /** 0..1: swing intensity */
  power: number;
  /** -1..1 placement offsets; the game passes 0 (the glove's heading is not reliable, so placement is random) */
  aim: { dx: number; dz: number };
  contact: { x: number; y: number; z: number };
}
export interface ReturnShot { ball: Ball; landing: { x: number; z: number }; kmh: number; threat: number }

export function makeReturn(rng: Rng, s: ReturnSpec): ReturnShot {
  const p = clamp(s.power, 0, 1), q = clamp(s.quality, 0, 1);
  const c = { x: s.contact.x, y: clamp(s.contact.y, 0.82, 1.5), z: s.contact.z };
  let lx = clamp(s.aim.dx * 0.5 + (rng() - 0.5) * 0.9, -0.62, 0.62), lz: number, T: number, top: number;
  switch (s.stroke) {
    case 'smash': lz = -clamp(0.7 + s.aim.dz * 0.3 + (rng() - 0.5) * 0.4, 0.4, 1.15); T = lerp(0.28, 0.19, p); top = 15; break;
    case 'push': lz = -clamp(0.5 + s.aim.dz * 0.2 + (rng() - 0.5) * 0.3, 0.3, 0.85); T = lerp(0.95, 0.8, p); top = -45; lx *= 0.8; break;
    default: lz = -clamp(0.75 + s.aim.dz * 0.35 + (rng() - 0.5) * 0.5, 0.35, 1.2); T = lerp(0.46, 0.31, p); top = 40 + 40 * p; break;
  }
  const ball = solveLaunch(c, spinFor(lx - c.x, lz - c.z, top, 0), lx, lz, T);
  // your mistakes become angle errors on the way out: low quality = the net, long, or wide
  const err = s.stroke === 'smash' ? 0.5 : 1; // a smash is steep and short, so the same angle error costs more; it is also the glove's weakest class
  const el = gauss(rng) * err * lerp(15, 0.6, q) * (Math.PI / 180), az = gauss(rng) * err * lerp(10, 0.5, q) * (Math.PI / 180), sp = 1 + gauss(rng) * 0.08 * (1 - q);
  const phi = Math.atan2(ball.vy, Math.hypot(ball.vx, ball.vz)) + el, th = Math.atan2(ball.vx, ball.vz) + az;
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz) * sp;
  ball.vx = speed * Math.cos(phi) * Math.sin(th); ball.vz = speed * Math.cos(phi) * Math.cos(th); ball.vy = speed * Math.sin(phi);
  // aimed edge: how close to a corner, and how deep; used by the opponent to judge how hard the shot is
  const edge = clamp(Math.abs(lx) / TABLE.hw, 0, 1), deep = clamp((-lz - 0.3) / 0.9, 0, 1);
  const hard = (s.stroke === 'smash' ? 1.25 : s.stroke === 'push' ? 0.5 : 1) * p;
  const threat = clamp(0.45 * hard + 0.35 * edge + 0.2 * deep, 0, 1);
  return { ball, landing: { x: lx, z: lz }, kmh: speedOf(ball) * 3.6, threat };
}
