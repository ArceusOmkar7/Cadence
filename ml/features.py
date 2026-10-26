"""Step 2: feature engineering. One row per stroke window (0.8 s at 200 Hz, peak at sample 96).
Feature groups (prefix): imu_ (motion only, from gravity-removed hand-frame signals), pose_ (roll/pitch; yaw is never used),
fing_ (flex curls and palm pressure). Nothing here uses the absolute time, the session, or the set."""
import numpy as np, pandas as pd

FS = 200; PK = 96
CH = ["gx", "gy", "gz", "ax", "ay", "az", "roll", "pitch", "c_thumb", "c_index", "c_middle", "c_ring", "c_little", "press"]


def sm(x, n=10):
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, "valid")


def feats(w):
    f = {}; t = (np.arange(len(w)) - PK) / FS
    g, a = w[:, 0:3], w[:, 3:6]
    gm, am = np.linalg.norm(g, axis=1), np.linalg.norm(a, axis=1)
    en = sm(np.hypot(gm / 500, am / 2))
    p = int(np.argmax(en[PK - 40:PK + 40])) + PK - 40  # sub-peak alignment: max of this very window, +-200 ms
    pe = en[p]
    sig = {"gx": g[:, 0], "gy": g[:, 1], "gz": g[:, 2], "ax": a[:, 0], "ay": a[:, 1], "az": a[:, 2], "gmag": gm, "amag": am}
    for n, x in sig.items():
        xs = sm(x)
        f.update({f"imu_{n}_mean": x.mean(), f"imu_{n}_std": x.std(), f"imu_{n}_min": xs.min(), f"imu_{n}_max": xs.max(),
                  f"imu_{n}_tmin": t[xs.argmin()], f"imu_{n}_tmax": t[xs.argmax()], f"imu_{n}_atpeak": xs[p]})
    for n, x in {"gx": g[:, 0], "gy": g[:, 1], "gz": g[:, 2]}.items():  # angle swept (deg) before and after the peak
        f[f"imu_{n}_angle_pre"] = x[:p].sum() / FS; f[f"imu_{n}_angle_post"] = x[p:].sum() / FS
    for n, x in {"ax": a[:, 0], "ay": a[:, 1], "az": a[:, 2]}.items():  # velocity change (g*s)
        f[f"imu_{n}_dv_pre"] = x[:p].sum() / FS; f[f"imu_{n}_dv_post"] = x[p:].sum() / FS
    # shape of the energy burst
    f["imu_peak_energy"] = pe; f["imu_peak_gyro"] = sm(gm)[p]; f["imu_peak_acc"] = sm(am).max()
    f["imu_acc_over_gyro"] = sm(am).max() / (sm(gm).max() / 250 + 1e-6)
    above = en >= 0.5 * pe; i0 = p; i1 = p
    while i0 > 0 and above[i0 - 1]: i0 -= 1
    while i1 < len(en) - 1 and above[i1 + 1]: i1 += 1
    f["imu_width50_ms"] = (i1 - i0 + 1) * 1000 / FS
    lo20 = np.where(en[:p] < 0.2 * pe)[0]; f["imu_rise_ms"] = (p - (lo20[-1] if len(lo20) else 0)) * 1000 / FS
    hi20 = np.where(en[p:] < 0.2 * pe)[0]; f["imu_fall_ms"] = (hi20[0] if len(hi20) else len(en) - p) * 1000 / FS
    post = en[min(p + 30, len(en) - 1):]; f["imu_return_ratio"] = post.max() / pe if len(post) else 0
    pre = en[:max(p - 30, 1)]; f["imu_windup_ratio"] = pre.max() / pe
    f["imu_energy_pre_frac"] = en[:p].sum() / en.sum()
    f["imu_jerk_max"] = np.abs(np.diff(np.stack([sm(a[:, i], 5) for i in range(3)]), axis=1)).max() * FS
    f["imu_gyro_jerk_max"] = np.abs(np.diff(np.stack([sm(g[:, i], 5) for i in range(3)]), axis=1)).max() * FS
    # direction of the swing at the peak (unit vectors; the sign separates forehand from backhand)
    gs = np.stack([sm(g[:, i], 6) for i in range(3)], 1); as_ = np.stack([sm(a[:, i], 6) for i in range(3)], 1)
    for i, n in enumerate("xyz"):
        f[f"imu_gdir_{n}"] = gs[p, i] / (np.linalg.norm(gs[p]) + 1e-6); f[f"imu_adir_{n}"] = as_[p, i] / (np.linalg.norm(as_[p]) + 1e-6)
    f["imu_g_a_cos"] = float(gs[p] @ as_[p] / (np.linalg.norm(gs[p]) * np.linalg.norm(as_[p]) + 1e-6))
    # direction before vs after the peak: how far the hand swings back (cosine of the mean gyro before / after)
    gp, gq = g[max(p - 20, 0):p].mean(0), g[p + 10:p + 60].mean(0)
    f["imu_pre_post_cos"] = float(gp @ gq / (np.linalg.norm(gp) * np.linalg.norm(gq) + 1e-6))
    # spectrum of the gyro magnitude
    sp = np.abs(np.fft.rfft(gm - gm.mean())) ** 2; fr = np.fft.rfftfreq(len(gm), 1 / FS); tot = sp.sum() + 1e-9
    for lo, hi in [(0, 3), (3, 6), (6, 12), (12, 25)]:
        f[f"imu_spec_{lo}_{hi}"] = sp[(fr >= lo) & (fr < hi)].sum() / tot
    # pose (not heading)
    for n, x in {"roll": w[:, 6], "pitch": w[:, 7]}.items():
        xs = sm(x); f.update({f"pose_{n}_start": xs[:20].mean(), f"pose_{n}_peak": xs[p], f"pose_{n}_end": xs[-20:].mean(),
                              f"pose_{n}_delta": xs[-20:].mean() - xs[:20].mean(), f"pose_{n}_min": xs.min(), f"pose_{n}_max": xs.max(), f"pose_{n}_range": np.ptp(xs)})
    # fingers and palm
    for j, n in enumerate(["thumb", "index", "middle", "ring", "little"]):
        x = sm(w[:, 8 + j]); f.update({f"fing_{n}_mean": x.mean(), f"fing_{n}_std": x.std(), f"fing_{n}_delta": x[-20:].mean() - x[:20].mean(), f"fing_{n}_atpeak": x[p]})
    x = sm(w[:, 13]); f.update({"fing_press_mean": x.mean(), "fing_press_max": x.max(), "fing_press_delta": x[-20:].mean() - x[:20].mean(), "fing_press_atpeak": x[p]})
    return f


def build(prefix="windows"):
    W = np.load(f"{prefix}.npy"); M = pd.read_csv(f"{prefix}_meta.csv")
    X = pd.DataFrame([feats(w) for w in W])
    return X, M


if __name__ == "__main__":
    X, M = build()
    X.to_csv("features.csv", index=False); print(X.shape); print(X.isna().sum().sum(), "NaN")
    g = {p: sum(c.startswith(p) for c in X.columns) for p in ["imu_", "pose_", "fing_"]}; print(g)
