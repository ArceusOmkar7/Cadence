// Exact port of ml/features_live.py (feats_live). The model was trained on these numbers, so every line mirrors the Python:
// peak FIXED at sample PK, window ends postMs later, box smoothing with edge replication. Parity with Python is tested in
// test/ml.test.ts against fixtures produced by ml/export_compact.py. Change both sides together or not at all.

export const FS = 200;
export const PK = 96;
/** Channels of a window row: gx gy gz (deg/s), ax ay az (g), roll pitch (deg). */
export const CH = 8;

/** Box smoothing of length n with the Python's padding (n>>1 on the left, n-1-(n>>1) on the right, edge replicated). */
export function sm(x: ArrayLike<number>, n = 10): Float64Array {
  const len = x.length, left = n >> 1, right = n - 1 - left, out = new Float64Array(len);
  const at = (i: number) => x[Math.min(Math.max(i, 0), len - 1)];
  let acc = 0;
  for (let k = 0; k < n; k++) acc += at(k - left);
  out[0] = acc / n;
  for (let i = 1; i < len; i++) { acc += at(i + right) - at(i - 1 - left); out[i] = acc / n; }
  return out;
}

const maxOf = (a: ArrayLike<number>, from = 0, to = a.length) => { let m = -Infinity; for (let i = from; i < to; i++) if (a[i] > m) m = a[i]; return m; };
const minOf = (a: ArrayLike<number>, from = 0, to = a.length) => { let m = Infinity; for (let i = from; i < to; i++) if (a[i] < m) m = a[i]; return m; };
const meanOf = (a: ArrayLike<number>, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); };
const sumOf = (a: ArrayLike<number>, from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s; };
const stdOf = (a: ArrayLike<number>) => { const m = meanOf(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / a.length); };
function maxAbsDiff(x: ArrayLike<number>): number { let m = 0; for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; }
function minDiff(x: ArrayLike<number>, from: number): number { let m = Infinity; for (let i = from + 1; i < x.length; i++) m = Math.min(m, x[i] - x[i - 1]); return m; }
function lastBelow(x: ArrayLike<number>, to: number, lim: number): number { let last = -1; for (let i = 0; i < to; i++) if (x[i] < lim) last = i; return last; }

/** @param w rows of CH values, row-major (length rows*CH); only the first PK+1+postMs*FS/1000 rows are used. */
export function featsLive(w: Float32Array | Float64Array, rows: number, postMs: number): Record<string, number> {
  const n = Math.min(PK + 1 + Math.trunc((postMs * FS) / 1000), rows), p = PK;
  const col = (c: number) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = w[i * CH + c]; return o; };
  const g = [col(0), col(1), col(2)], a = [col(3), col(4), col(5)];
  const gm = new Float64Array(n), am = new Float64Array(n), e0 = new Float64Array(n);
  for (let i = 0; i < n; i++) { gm[i] = Math.hypot(g[0][i], g[1][i], g[2][i]); am[i] = Math.hypot(a[0][i], a[1][i], a[2][i]); e0[i] = Math.hypot(gm[i] / 500, am[i] / 2); }
  const en = sm(e0), pe = en[p];
  const gs = g.map((x) => sm(x, 6)), as = a.map((x) => sm(x, 6));
  const gsm = new Float64Array(n), asm = new Float64Array(n);
  for (let i = 0; i < n; i++) { gsm[i] = Math.hypot(gs[0][i], gs[1][i], gs[2][i]); asm[i] = Math.hypot(as[0][i], as[1][i], as[2][i]); }
  const f: Record<string, number> = {};
  const sig: Record<string, Float64Array> = { gx: g[0], gy: g[1], gz: g[2], ax: a[0], ay: a[1], az: a[2], gmag: gm, amag: am };
  for (const [k, x] of Object.entries(sig)) {
    const xs = sm(x);
    f[`imu_${k}_min`] = minOf(xs); f[`imu_${k}_max`] = maxOf(xs); f[`imu_${k}_atpeak`] = xs[p];
    f[`imu_${k}_mean`] = meanOf(x); f[`imu_${k}_std`] = stdOf(x);
  }
  (['gx', 'gy', 'gz'] as const).forEach((k, i) => { f[`imu_${k}_angle_pre`] = sumOf(g[i], 0, p) / FS; f[`imu_${k}_angle_post`] = sumOf(g[i], p, n) / FS; });
  (['ax', 'ay', 'az'] as const).forEach((k, i) => { f[`imu_${k}_dv_pre`] = sumOf(a[i], 0, p) / FS; f[`imu_${k}_dv_post`] = sumOf(a[i], p, n) / FS; });
  f.imu_peak_energy = pe;
  f.imu_acc_over_gyro = maxOf(asm) / (maxOf(gsm) / 250 + 1e-6);
  let i0 = p, i1 = p;
  while (i0 > 0 && en[i0 - 1] >= 0.5 * pe) i0--;
  while (i1 < n - 1 && en[i1 + 1] >= 0.5 * pe) i1++;
  f.imu_width50_ms = ((i1 - i0 + 1) * 1000) / FS;
  const lo20 = lastBelow(en, p, 0.2 * pe); f.imu_rise_ms = ((p - (lo20 >= 0 ? lo20 : 0)) * 1000) / FS;
  f.imu_windup_ratio = maxOf(en, 0, Math.max(p - 30, 1)) / pe;
  const jerk = (axes: Float64Array[]) => Math.max(...axes.map((x) => maxAbsDiff(sm(x, 5)))) * FS;
  f.imu_jerk_max = jerk(a); f.imu_gyro_jerk_max = jerk(g);
  ['x', 'y', 'z'].forEach((k, i) => { f[`imu_gdir_${k}`] = gs[i][p] / (gsm[p] + 1e-6); f[`imu_adir_${k}`] = as[i][p] / (asm[p] + 1e-6); });
  const gmax = maxOf(gsm) + 1e-6, u = gs.map((x) => x.map((v) => v / gmax));
  ['x', 'y', 'z'].forEach((k, i) => { f[`nrm_g${k}_peak`] = u[i][p]; f[`nrm_g${k}_pre`] = meanOf(u[i], Math.max(p - 40, 0), p); });
  f.nrm_gy_back_min = minOf(u[1], 0, p - 10); f.nrm_gy_back_max = maxOf(u[1], 0, p - 10);
  const low = lastBelow(gsm, p, 0.2 * gmax); f.nrm_swing_ms = ((p - (low >= 0 ? low : 0)) * 1000) / FS;
  f.nrm_jerk = (maxAbsDiff(sm(am, 5)) * FS) / (maxOf(asm) + 1e-6);
  const m = n - p;
  if (m > 3) {
    const q = Math.min(m - 1, 40);
    ['x', 'y', 'z'].forEach((k, i) => { f[`nrm_g${k}_post`] = meanOf(u[i], p, p + q + 1); });
    f.nrm_a_decel = (minDiff(asm, p) * FS) / (maxOf(asm) + 1e-6);
  } else { for (const k of 'xyz') f[`nrm_g${k}_post`] = 0; f.nrm_a_decel = 0; }
  (['roll', 'pitch'] as const).forEach((k, i) => {
    const xs = sm(col(6 + i)), start = meanOf(xs, 0, 20), end = meanOf(xs, n - 10, n);
    f[`pose_${k}_start`] = start; f[`pose_${k}_peak`] = xs[p]; f[`pose_${k}_end`] = end; f[`pose_${k}_delta`] = end - start;
    f[`pose_${k}_min`] = minOf(xs); f[`pose_${k}_max`] = maxOf(xs); f[`rel_d${k}_peak`] = xs[p] - start;
  });
  return f;
}
