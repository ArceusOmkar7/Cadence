// Table-tennis ball physics for the game. Pure maths, no DOM and no Three.js, so it runs in unit tests.
// World: metres, Y up, the table centred at the origin with its long axis along Z. The player stands at +Z, the opponent at -Z, the net is at z = 0.
// Modelled: gravity, quadratic air drag, Magnus force from spin, a table bounce with restitution and Coulomb friction (spin changes the bounce),
// the net, and the floor. Not modelled: the table edge, the net cord, racket deformation.

export const G = 9.81;
export const BALL_R = 0.02;
export const TABLE = { hw: 0.7625, hl: 1.37, top: 0.76, netTop: 0.76 + 0.1525, netHw: 0.915 };
const DRAG = 0.112;     // 1/m: 0.5 rho Cd A / m for a 40 mm, 2.7 g ball
const MAGNUS = 0.003;   // a = MAGNUS * (omega x v), omega in rad/s: about 1.9 g at 100 rev/s and 10 m/s (lift coefficient ~0.5 at that spin ratio)
const E_TABLE = 0.93, MU_TABLE = 0.22, E_FLOOR = 0.7;
export const STEP = 1 / 480;
export const RPS = 2 * Math.PI; // rad/s per revolution per second

export interface Ball { x: number; y: number; z: number; vx: number; vy: number; vz: number; wx: number; wy: number; wz: number }
export type BallEvent = { kind: 'table'; x: number; z: number; vIn: number } | { kind: 'net' } | { kind: 'floor' };

export const copyBall = (b: Ball): Ball => ({ ...b });
export const speedOf = (b: Ball): number => Math.hypot(b.vx, b.vy, b.vz);

/** Advances the ball by one step and returns what it touched, if anything. */
export function stepBall(b: Ball, dt: number = STEP): BallEvent | null {
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  const ax = -DRAG * sp * b.vx + MAGNUS * (b.wy * b.vz - b.wz * b.vy);
  const ay = -G - DRAG * sp * b.vy + MAGNUS * (b.wz * b.vx - b.wx * b.vz);
  const az = -DRAG * sp * b.vz + MAGNUS * (b.wx * b.vy - b.wy * b.vx);
  b.vx += ax * dt; b.vy += ay * dt; b.vz += az * dt;
  const px = b.x, py = b.y, pz = b.z;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  const decay = Math.exp(-0.05 * dt); b.wx *= decay; b.wy *= decay; b.wz *= decay;

  // net: the ball centre crossing z = 0 below the net top (plus the ball radius), above the table, inside the net's width
  if ((pz > 0) !== (b.z > 0) && pz !== b.z) {
    const f = pz / (pz - b.z), yc = py + (b.y - py) * f, xc = px + (b.x - px) * f;
    if (yc - BALL_R < TABLE.netTop && yc > TABLE.top - 0.02 && Math.abs(xc) < TABLE.netHw + BALL_R) {
      b.x = xc; b.y = yc; b.z = 0; b.vz *= -0.12; b.vx *= 0.3;
      return { kind: 'net' };
    }
  }
  // table top
  if (py - BALL_R > TABLE.top && b.y - BALL_R <= TABLE.top && b.vy < 0 && Math.abs(b.x) <= TABLE.hw && Math.abs(b.z) <= TABLE.hl) {
    const vIn = -b.vy;
    b.y = TABLE.top + BALL_R;
    const r = BALL_R, ux = b.vx + b.wz * r, uz = b.vz - b.wx * r, un = Math.hypot(ux, uz);
    b.vy = E_TABLE * vIn;
    if (un > 1e-6) {
      const jt = Math.min((2 / 7) * un, MU_TABLE * (1 + E_TABLE) * vIn); // friction impulse per unit mass, capped by Coulomb
      const fx = (-ux / un) * jt, fz = (-uz / un) * jt, k = r / (0.4 * r * r);
      b.vx += fx; b.vz += fz; b.wx += -fz * k; b.wz += fx * k;
    }
    return { kind: 'table', x: b.x, z: b.z, vIn };
  }
  if (b.y <= BALL_R && b.vy < 0) { b.y = BALL_R; b.vy = -E_FLOOR * b.vy; b.vx *= 0.8; b.vz *= 0.8; return { kind: 'floor' }; }
  return null;
}

export interface Landing { x: number; z: number; t: number }

/** Ballistic flight (drag and Magnus, no table) until the ball comes down to the table surface. Null if it never does. */
export function flyToTable(b0: Ball, tMax = 3): Landing | null {
  const b = copyBall(b0), yStop = TABLE.top + BALL_R;
  let t = 0;
  while (t < tMax) {
    const py = b.y, px = b.x, pz = b.z;
    ballistic(b, STEP); t += STEP;
    if (b.vy < 0 && py > yStop && b.y <= yStop) { const f = (py - yStop) / (py - b.y); return { x: px + (b.x - px) * f, z: pz + (b.z - pz) * f, t: t - STEP + STEP * f }; }
  }
  return null;
}
function ballistic(b: Ball, dt: number): void {
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  b.vx += (-DRAG * sp * b.vx + MAGNUS * (b.wy * b.vz - b.wz * b.vy)) * dt;
  b.vy += (-G - DRAG * sp * b.vy + MAGNUS * (b.wz * b.vx - b.wx * b.vz)) * dt;
  b.vz += (-DRAG * sp * b.vz + MAGNUS * (b.wx * b.vy - b.wy * b.vx)) * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
}

/**
 * Launch velocity that lands the ball at (lx, lz) on the table after flight time T, given start position and spin.
 * Starts from the vacuum solution and corrects it against the full (drag and Magnus) flight.
 */
export function solveLaunch(start: { x: number; y: number; z: number }, spin: { wx: number; wy: number; wz: number }, lx: number, lz: number, T: number): Ball {
  const yL = TABLE.top + BALL_R;
  const b: Ball = { x: start.x, y: start.y, z: start.z, vx: (lx - start.x) / T, vy: (yL - start.y + 0.5 * G * T * T) / T, vz: (lz - start.z) / T, wx: spin.wx, wy: spin.wy, wz: spin.wz };
  for (let i = 0; i < 8; i++) {
    const l = flyToTable(b);
    if (!l) { b.vy += 0.5; continue; }
    b.vx += (lx - l.x) / l.t; b.vz += (lz - l.z) / l.t; b.vy += ((T - l.t) * G) / 2;
  }
  return b;
}

/** Spin vector for a ball travelling with horizontal direction (dx, dz): positive rps = topspin, negative = backspin, side = sidespin about Y. */
export function spinFor(dx: number, dz: number, topRps: number, sideRps = 0): { wx: number; wy: number; wz: number } {
  const n = Math.hypot(dx, dz) || 1, ux = dx / n, uz = dz / n, w = topRps * RPS;
  // topspin axis = up x direction = (uz, 0, -ux)
  return { wx: w * uz, wy: sideRps * RPS, wz: -w * ux };
}

export interface Prediction {
  /** the first bounce on the receiving half */
  bounce: { x: number; z: number; t: number } | null;
  /** lowest clearance of the net top, ball centre minus (net top + radius); negative = into the net */
  netClear: number;
  /** the ball when it first reaches z >= strikeZ (towards +Z) or z <= strikeZ (towards -Z) after that bounce */
  strike: { ball: Ball; t: number } | null;
  hitNet: boolean;
}

/** Full simulation of a shot with the real physics, used to check that a generated ball is playable. dir = +1 when flying towards the player (+Z). */
export function predict(b0: Ball, dir: 1 | -1, strikeZ: number, tMax = 4): Prediction {
  const b = copyBall(b0);
  const out: Prediction = { bounce: null, netClear: Infinity, strike: null, hitNet: false };
  let t = 0, prevZ = b.z;
  while (t < tMax) {
    const ev = stepBall(b); t += STEP;
    if ((prevZ > 0) !== (b.z > 0)) out.netClear = Math.min(out.netClear, b.y - BALL_R - TABLE.netTop);
    prevZ = b.z;
    if (ev?.kind === 'net') { out.hitNet = true; break; }
    if (ev?.kind === 'floor') break;
    if (ev?.kind === 'table') {
      const recv = ev.z * dir > 0;
      if (!out.bounce) { if (!recv) break; out.bounce = { x: ev.x, z: ev.z, t }; } else break; // a second bounce: it is gone
    }
    if (out.bounce && !out.strike && (dir === 1 ? b.z >= strikeZ : b.z <= strikeZ)) { out.strike = { ball: copyBall(b), t }; break; }
    if (Math.abs(b.z) > 6) break;
  }
  return out;
}
