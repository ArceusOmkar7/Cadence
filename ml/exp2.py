"""Pipeline v2, step 2: experiment harness. Leave-one-SET-out everywhere. Run: .venv/Scripts/python exp2.py [batch]"""
import sys, json, warnings, numpy as np, pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import f1_score, confusion_matrix
from sklearn.utils.class_weight import compute_sample_weight
warnings.filterwarnings("ignore")
X = pd.read_csv("features3.csv"); M = pd.read_csv("windows2_meta.csv")
CL = ["forehand_drive", "backhand_drive", "smash", "push", "none"]; CI = {c: i for i, c in enumerate(CL)}
_old = [c for c in X if c.startswith(("imu_", "pose_", "fing_"))]
_dead = ["imu_peak_acc", "imu_peak_gyro", "imu_g_a_cos", "imu_adir_y", "imu_gdir_x", "imu_energy_pre_frac", "imu_spec_12_25", "imu_gz_angle_pre", "imu_gz_min"]
_clean = [c for c in _old if not c.startswith("fing_") and not c.endswith(("_tmin", "_tmax")) and c not in _dead]
_newc = [c for c in X if c.startswith(("nrm_", "rel_"))]
_abs = [c for c in _clean if c.startswith("pose_") and c.endswith(("_start", "_peak", "_end", "_min", "_max"))]
FG = {"imu": [c for c in _old if c.startswith("imu_")], "imu+pose": [c for c in _old if c.startswith(("imu_", "pose_"))], "all": [c for c in _old],
      "clean": _clean, "clean+new": _clean + _newc,
      "clean+new-abspose": [c for c in _clean + _newc if c not in _abs],
      "clean+new-meanstd": [c for c in _clean + _newc if not c.endswith(("_mean", "_std")) or c.startswith("pose_")],
      "new-only+deltas": _newc + ["pose_roll_delta", "pose_pitch_delta", "imu_peak_energy", "imu_width50_ms", "imu_rise_ms", "imu_fall_ms", "imu_return_ratio", "imu_windup_ratio"],
      "imu-new": [c for c in _clean + _newc if c.startswith(("imu_", "nrm_"))]}
XGBP = dict(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.5, reg_lambda=2.0)
off = (M.kind == "offline"); cau = (M.kind == "causal")
# what the live detector would fire on: none windows below 0.35 are never classified live
EVAL_OFF = off & (M.shift_ms == 0) & ((M.label != "none") | (M.peak_energy >= 0.35))
EVAL_CAU = cau & (M.label != "unmatched")
UNM = cau & (M.label == "unmatched")


def train_rows(cfg):
    keep = off.copy()
    if not cfg.get("aug"): keep &= M.shift_ms == 0
    none_mode = cfg.get("none", "all")
    isnone = M.label == "none"
    if none_mode == "trigger": keep &= ~isnone | (M.peak_energy >= 0.35)
    keep |= UNM & (cfg.get("unmatched", False))
    if cfg.get("train_domain") in ("shadow", "ball"): keep &= M.session == cfg["train_domain"]
    return keep


def labels(rows):
    return M.loc[rows, "label"].replace({"unmatched": "none"}).map(CI).to_numpy()


def weights(rows, cfg):
    y = labels(rows); w = compute_sample_weight("balanced", y)
    if cfg.get("domain_bal"):
        d = M.loc[rows, "session"].to_numpy(); key = pd.Series([f"{a}|{b}" for a, b in zip(y, d)])
        w = compute_sample_weight("balanced", key.to_numpy())
    if cfg.get("unmatched") and cfg.get("unm_w") is not None: w = w * np.where(UNM[rows].to_numpy(), cfg["unm_w"], 1.0)
    return w


def model(cfg, seed=0):
    return XGBClassifier(**{**XGBP, **cfg.get("params", {})}, objective="multi:softprob", num_class=5, tree_method="hist", random_state=seed, n_jobs=3, verbosity=0)


def loso(cfg, cols, test_domain=None):
    """Hold out one set at a time. Returns predictions for EVAL_OFF, EVAL_CAU, UNM rows."""
    tr_all = train_rows(cfg); sets = sorted(M.set.unique()); P = {}
    for s in sets:
        te = (M.set == s) & (EVAL_OFF | EVAL_CAU | UNM)
        if test_domain: te &= M.session == test_domain
        if not te.any(): continue
        tr = tr_all & (M.set != s)
        y = labels(tr)
        if len(set(y)) < 5 and not cfg.get("allow_missing"): pass
        m = model(cfg); m.fit(X.loc[tr, cols], y, sample_weight=weights(tr, cfg))
        pr = m.predict_proba(X.loc[te, cols])
        for i, p in zip(M.index[te], pr): P[i] = p
    return P


def summarize(P, name, session=None):
    out = {"name": name}
    for tag, mask in [("off", EVAL_OFF), ("cau", EVAL_CAU)]:
        idx = [i for i in M.index[mask & ((M.session == session) if session else True)] if i in P]
        if not idx: continue
        y = labels(pd.Series(M.index.isin(idx), index=M.index)) if False else M.loc[idx, "label"].map(CI).to_numpy()
        pr = np.array([P[i] for i in idx]); yp = pr.argmax(1)
        out[f"{tag}_acc"] = (yp == y).mean(); out[f"{tag}_f1"] = f1_score(y, yp, average="macro", labels=range(5))
        st = y < 4; nn = y == 4
        out[f"{tag}_stroke_acc4"] = (yp[st] == y[st]).mean()                       # right stroke type among real strokes
        out[f"{tag}_stroke_as_none"] = (yp[st] == 4).mean()                         # real stroke lost
        out[f"{tag}_none_recall"] = (yp[nn] == 4).mean() if nn.any() else np.nan   # false trigger rejected
        out[f"{tag}_n"] = len(idx)
    idx = [i for i in M.index[UNM & ((M.session == session) if session else True)] if i in P]
    if idx: out["unmatched_as_none"] = float(np.mean([P[i].argmax() == 4 for i in idx])); out["unmatched_n"] = len(idx)
    return out


def show(r):
    print(f"{r['name']:46s} off acc {r.get('off_acc', float('nan')):.3f} f1 {r.get('off_f1', float('nan')):.3f} stroke4 {r.get('off_stroke_acc4', float('nan')):.3f} none_rec {r.get('off_none_recall', float('nan')):.2f} s>none {r.get('off_stroke_as_none', float('nan')):.3f} | cau acc {r.get('cau_acc', float('nan')):.3f} f1 {r.get('cau_f1', float('nan')):.3f} | unm>none {r.get('unmatched_as_none', float('nan')):.2f}", flush=True)


def run_domains(batch):
    for name, cfg, fg in batch:
        td = cfg.get("train_domain")
        if td:   # one model, tested only on the OTHER kind of session
            other = "ball" if td == "shadow" else "shadow"; tr = train_rows(cfg); y = labels(tr)
            m = model(cfg); m.fit(X.loc[tr, FG[fg]], y, sample_weight=weights(tr, cfg))
            te = (EVAL_OFF | EVAL_CAU | UNM) & (M.session == other); P = {i: p for i, p in zip(M.index[te], m.predict_proba(X.loc[te, FG[fg]]))}
            show(summarize(P, f"{name} -> test {other} (never seen)", other)); continue
        P = loso(cfg, FG[fg])
        for sess in (None, "shadow", "ball"):
            show(summarize(P, f"{name} -> test {sess or 'all'}", sess))


def run(batch):
    rows = []
    for name, cfg, fg in batch:
        P = loso(cfg, FG[fg]); r = summarize(P, name); r["cfg"] = json.dumps({**cfg, "feat": fg}); rows.append(r)
        show(r)
    return pd.DataFrame(rows)


_C = dict(none="all", aug=True)
_K = dict(none="all", aug=True)
BATCHES = {
 "3": [("train both", _K, "clean"), ("train shadow only", {**_K, "train_domain": "shadow"}, "clean"), ("train ball only", {**_K, "train_domain": "ball"}, "clean")],
 "4": [("unmatched w=0 (not used)", _K, "clean")] + [(f"unmatched as none w={w}", {**_K, "unmatched": True, "unm_w": w}, "clean") for w in (0.1, 0.3, 0.6)],
 "5": [(f"depth {d} n {n} lr {lr}", {**_K, "params": dict(max_depth=d, n_estimators=n, learning_rate=lr)}, "clean") for d, n, lr in [(2, 200, .05), (3, 100, .05), (3, 400, .05), (4, 200, .05), (5, 200, .05), (3, 300, .1), (3, 200, .02)]] +
       [("min_child_weight 3", {**_K, "params": dict(min_child_weight=3)}, "clean"), ("gamma 1", {**_K, "params": dict(gamma=1.0)}, "clean"), ("colsample .3", {**_K, "params": dict(colsample_bytree=0.3)}, "clean"), ("colsample .8", {**_K, "params": dict(colsample_bytree=0.8)}, "clean")],
 "2": [(f"C features={k}", _C, k) for k in ["imu+pose", "clean", "clean+new", "clean+new-abspose", "clean+new-meanstd", "new-only+deltas", "imu-new"]],
 "1": [("A none=triggers only, imu+pose", dict(none="trigger"), "imu+pose"),
       ("B none=all bumps, imu+pose", dict(none="all"), "imu+pose"),
       ("C B + jitter aug", dict(none="all", aug=True), "imu+pose"),
       ("D C + live false triggers as none", dict(none="all", aug=True, unmatched=True), "imu+pose"),
       ("E D, all features", dict(none="all", aug=True, unmatched=True), "all"),
       ("F D, imu only", dict(none="all", aug=True, unmatched=True), "imu"),
       ("G D, domain-balanced weights", dict(none="all", aug=True, unmatched=True, domain_bal=True), "imu+pose")],
}
if __name__ == "__main__":
    b = sys.argv[1] if len(sys.argv) > 1 else "1"
    if b == "3": run_domains(BATCHES[b])
    else: df = run(BATCHES[b]); df.to_csv(f"exp2_batch{b}.csv", index=False)
