"""Live-matched features: computed on a window whose peak is FIXED at sample PK (the detector peak) and that ends `post_ms` after it,
so training and the app compute exactly the same thing. No FFT, no argmin/argmax times, no finger sensors, no re-finding of the peak.
Everything is a box smoothing (edge-replicated), min/max/mean, sums, ratios: easy to port to TypeScript and unit-test against Python."""
import numpy as np, pandas as pd

FS = 200; PK = 96


def sm(x, n=10):
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, "valid")


def feats_live(w, post_ms=160):
    n = min(PK + 1 + int(post_ms * FS / 1000), len(w)); w = w[:n]; p = PK; f = {}
    g, a = w[:, 0:3], w[:, 3:6]
    gm, am = np.linalg.norm(g, axis=1), np.linalg.norm(a, axis=1)
    en = sm(np.hypot(gm / 500, am / 2)); pe = en[p]
    gs = np.stack([sm(g[:, i], 6) for i in range(3)], 1); as_ = np.stack([sm(a[:, i], 6) for i in range(3)], 1)
    gsm, asm = np.linalg.norm(gs, axis=1), np.linalg.norm(as_, axis=1)
    sig = {"gx": g[:, 0], "gy": g[:, 1], "gz": g[:, 2], "ax": a[:, 0], "ay": a[:, 1], "az": a[:, 2], "gmag": gm, "amag": am}
    for k, x in sig.items():
        xs = sm(x); f[f"imu_{k}_min"] = xs.min(); f[f"imu_{k}_max"] = xs.max(); f[f"imu_{k}_atpeak"] = xs[p]
        f[f"imu_{k}_mean"] = x.mean(); f[f"imu_{k}_std"] = x.std()
    for k, x in {"gx": g[:, 0], "gy": g[:, 1], "gz": g[:, 2]}.items():
        f[f"imu_{k}_angle_pre"] = x[:p].sum() / FS; f[f"imu_{k}_angle_post"] = x[p:].sum() / FS
    for k, x in {"ax": a[:, 0], "ay": a[:, 1], "az": a[:, 2]}.items():
        f[f"imu_{k}_dv_pre"] = x[:p].sum() / FS; f[f"imu_{k}_dv_post"] = x[p:].sum() / FS
    f["imu_peak_energy"] = pe
    f["imu_acc_over_gyro"] = asm.max() / (gsm.max() / 250 + 1e-6)
    above = en >= 0.5 * pe; i0 = p; i1 = p
    while i0 > 0 and above[i0 - 1]: i0 -= 1
    while i1 < n - 1 and above[i1 + 1]: i1 += 1
    f["imu_width50_ms"] = (i1 - i0 + 1) * 1000 / FS
    lo20 = np.where(en[:p] < 0.2 * pe)[0]; f["imu_rise_ms"] = (p - (lo20[-1] if len(lo20) else 0)) * 1000 / FS
    pre = en[:max(p - 30, 1)]; f["imu_windup_ratio"] = pre.max() / pe
    f["imu_jerk_max"] = np.abs(np.diff(np.stack([sm(a[:, i], 5) for i in range(3)]), axis=1)).max() * FS
    f["imu_gyro_jerk_max"] = np.abs(np.diff(np.stack([sm(g[:, i], 5) for i in range(3)]), axis=1)).max() * FS
    for i, k in enumerate("xyz"):
        f[f"imu_gdir_{k}"] = gs[p, i] / (gsm[p] + 1e-6); f[f"imu_adir_{k}"] = as_[p, i] / (asm[p] + 1e-6)
    gmax = gsm.max() + 1e-6; u = gs / gmax
    for i, k in enumerate("xyz"):
        f[f"nrm_g{k}_peak"] = u[p, i]; f[f"nrm_g{k}_pre"] = u[max(p - 40, 0):p, i].mean()
    f["nrm_gy_back_min"] = u[:p - 10, 1].min(); f["nrm_gy_back_max"] = u[:p - 10, 1].max()
    low = np.where(gsm[:p] < 0.2 * gmax)[0]; f["nrm_swing_ms"] = (p - (low[-1] if len(low) else 0)) * 1000 / FS
    f["nrm_jerk"] = np.abs(np.diff(sm(am, 5))).max() * FS / (asm.max() + 1e-6)
    m = n - p
    if m > 3:  # post-peak part, only what has arrived
        q = min(m - 1, 40)
        for i, k in enumerate("xyz"): f[f"nrm_g{k}_post"] = u[p:p + q + 1, i].mean()
        f["nrm_a_decel"] = np.diff(asm[p:]).min() * FS / (asm.max() + 1e-6)
    else:
        for k in "xyz": f[f"nrm_g{k}_post"] = 0.0
        f["nrm_a_decel"] = 0.0
    for k, x in {"roll": w[:, 6], "pitch": w[:, 7]}.items():
        xs = sm(x); f.update({f"pose_{k}_start": xs[:20].mean(), f"pose_{k}_peak": xs[p], f"pose_{k}_end": xs[-10:].mean(),
                              f"pose_{k}_delta": xs[-10:].mean() - xs[:20].mean(), f"pose_{k}_min": xs.min(), f"pose_{k}_max": xs.max(),
                              f"rel_d{k}_peak": xs[p] - xs[:20].mean()})
    return f


def build(W, post_ms):
    return pd.DataFrame([feats_live(w, post_ms) for w in W])
