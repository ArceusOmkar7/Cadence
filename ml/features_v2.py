"""Feature set v2 = features.py minus unstable/duplicate features, plus speed-normalised and relative-pose features
(suggested by the biomechanics review, each validated separately by exp2.py)."""
import numpy as np, pandas as pd
from features import feats, sm, FS, PK


def new_feats(w):
    f = {}; g, a = w[:, 0:3], w[:, 3:6]
    gm, am = np.linalg.norm(g, axis=1), np.linalg.norm(a, axis=1)
    en = sm(np.hypot(gm / 500, am / 2)); p = int(np.argmax(en[PK - 40:PK + 40])) + PK - 40
    gs = np.stack([sm(g[:, i], 6) for i in range(3)], 1); gsm = np.linalg.norm(gs, axis=1); gmax = gsm.max() + 1e-6
    u = gs / gmax
    for i, n in enumerate("xyz"):
        f[f"nrm_g{n}_peak"] = u[p, i]; f[f"nrm_g{n}_pre"] = u[max(p - 40, 0):p, i].mean(); f[f"nrm_g{n}_post"] = u[p:p + 40, i].mean()
    f["nrm_gy_back_min"] = u[:max(p - 10, 1), 1].min(); f["nrm_gy_back_max"] = u[:max(p - 10, 1), 1].max()
    low = np.where(gsm[:p] < 0.2 * gmax)[0]; f["nrm_swing_ms"] = (p - (low[-1] if len(low) else 0)) * 1000 / FS
    rs, ps = sm(w[:, 6]), sm(w[:, 7])
    f["rel_droll_peak"] = rs[p] - rs[:20].mean(); f["rel_dpitch_peak"] = ps[p] - ps[:20].mean()
    f["rel_droll_after"] = rs[-20:].mean() - rs[p]; f["rel_dpitch_after"] = ps[-20:].mean() - ps[p]
    lo, hi = max(p - 40, 0), min(p + 40, len(am))
    f["nrm_t_acc_minus_gyro_ms"] = (np.argmax(sm(am)[lo:hi]) - np.argmax(sm(gm)[lo:hi])) * 1000 / FS
    asm = sm(am); f["nrm_a_decel"] = np.diff(asm[p:]).min() * FS / (asm.max() + 1e-6) if len(asm) - p > 2 else 0.0
    f["nrm_jerk"] = np.abs(np.diff(sm(am, 5))).max() * FS / (asm.max() + 1e-6)
    return f


def build(W):
    return pd.DataFrame([{**feats(w), **new_feats(w)} for w in W])

if __name__ == "__main__":
    W = np.load("windows2.npy"); X = build(W); X.to_csv("features3.csv", index=False); print(X.shape)
