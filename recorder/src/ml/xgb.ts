// Evaluates the compact XGBoost export (ml/export_compact.py). multi:softprob, gbtree, numeric splits only.
// A node goes left when value < split condition (float32 compare in XGBoost); a missing value follows the default direction.

export interface CompactTree { c: number; l: number[]; r: number[]; f: number[]; t: number[]; d: number[] }
export interface CompactSeed { base: number[]; trees: CompactTree[] }
export interface ModelEvidence { accuracy: number; interval: [number, number]; recall: Record<string, number>; windows: number; sets: number; how: string }
export interface CompactModel {
  classes: string[]; features: string[]; post_ms: number; peak_index: number; fs: number;
  /** measured on held-out sets when the model was trained (ml/final.py) */
  evidence?: ModelEvidence;
  /** hand-mount calibration the training data was recorded with (quaternion w x y z) */
  trained_mount_q_wxyz?: number[];
  seeds: CompactSeed[];
}

export function predictProba(model: CompactModel, x: ArrayLike<number>): number[] {
  const k = model.classes.length, out = new Array<number>(k).fill(0);
  for (const seed of model.seeds) {
    const margin = seed.base.slice();
    for (const t of seed.trees) {
      let n = 0;
      while (t.l[n] !== -1) {
        const v = x[t.f[n]];
        n = Number.isNaN(v) ? (t.d[n] ? t.l[n] : t.r[n]) : Math.fround(v) < Math.fround(t.t[n]) ? t.l[n] : t.r[n];
      }
      margin[t.c] += t.t[n];
    }
    const mx = Math.max(...margin);
    let s = 0;
    const e = margin.map((m) => { const v = Math.exp(m - mx); s += v; return v; });
    for (let i = 0; i < k; i++) out[i] += e[i] / s / model.seeds.length;
  }
  return out;
}

/** Feature vector in the model's own order from a name -> value record. */
export function vectorFor(model: CompactModel, feats: Record<string, number>): Float64Array {
  const v = new Float64Array(model.features.length);
  model.features.forEach((name, i) => {
    const x = feats[name];
    if (x === undefined) throw new Error(`feature ${name} is not computed`);
    v[i] = x;
  });
  return v;
}

export async function loadModel(url: string): Promise<CompactModel> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`model ${url}: HTTP ${r.status}`);
  return (await r.json()) as CompactModel;
}
