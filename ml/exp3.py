"""Live-matched experiments: windows around the detector peak, ending post_ms later. Leave-one-set-out, evaluated on the live detector windows.
Run: .venv/Scripts/python exp3.py <batch>"""
import sys, warnings, numpy as np, pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import f1_score
from sklearn.utils.class_weight import compute_sample_weight
import features_live as FL
warnings.filterwarnings("ignore")
W = np.load("windows2.npy"); M = pd.read_csv("windows2_meta.csv")
CL = ["forehand_drive", "backhand_drive", "smash", "push", "none"]; CI = {c: i for i, c in enumerate(CL)}
XGBP = dict(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.5, reg_lambda=2.0)
off, cau = M.kind == "offline", M.kind == "causal"
EV = cau & (M.label != "unmatched"); UNM = cau & (M.label == "unmatched")
_cache = {}


def feats(post):
    if post not in _cache: _cache[post] = FL.build(W, post)
    return _cache[post]


DROP_ABS = lambda c: c.startswith("pose_") and c.endswith(("_start", "_peak", "_end", "_min", "_max"))
FSETS = {"all": lambda c: True, "no-abspose": lambda c: not DROP_ABS(c), "no-meanstd": lambda c: not c.endswith(("_mean", "_std")),
         "no-nrm": lambda c: not c.startswith(("nrm_", "rel_")), "core": lambda c: not c.endswith(("_mean", "_std")) and not c.startswith("rel_")}


def rows(cfg):
    keep = off & (M.shift_ms.abs() <= cfg.get("shift", 80)) if cfg.get("aug_off", True) else pd.Series(False, index=M.index)
    keep &= ~((M.label == "none") & (M.shift_ms != 0))
    if cfg.get("causal_train", True): keep |= EV
    if cfg.get("unm_w", 0) > 0: keep |= UNM
    return keep


def run(cfg):
    post = cfg.get("post", 160); X = feats(post); cols = [c for c in X if FSETS[cfg.get("fs", "all")](c)]
    tr_all = rows(cfg); P = {}
    for s in sorted(M.set.unique()):
        te = (M.set == s) & (EV | UNM)
        if not te.any(): continue
        tr = tr_all & (M.set != s)
        y = M.loc[tr, "label"].replace({"unmatched": "none"}).map(CI).to_numpy()
        w = compute_sample_weight("balanced", y)
        if cfg.get("unm_w", 0) > 0: w = w * np.where(UNM[tr].to_numpy(), cfg["unm_w"], 1.0)
        pr = 0
        for seed in range(cfg.get("seeds", 1)):
            m = XGBClassifier(**{**XGBP, **cfg.get("params", {})}, objective="multi:softprob", num_class=5, tree_method="hist", random_state=seed, n_jobs=3, verbosity=0)
            m.fit(X.loc[tr, cols], y, sample_weight=w); pr = pr + m.predict_proba(X.loc[te, cols]) / cfg.get("seeds", 1)
        for i, p in zip(M.index[te], pr): P[i] = p
    return P, cols


def report(name, P, only=None):
    idx = [i for i in M.index[EV] if i in P and (only is None or M.session[i] == only)]
    y = M.loc[idx, "label"].map(CI).to_numpy(); pr = np.array([P[i] for i in idx]); yp = pr.argmax(1); st = y < 4
    u = [i for i in M.index[UNM] if i in P and (only is None or M.session[i] == only)]
    r = dict(name=name, acc=(yp == y).mean(), f1=f1_score(y, yp, average="macro", labels=range(5)), stroke4=(yp[st] == y[st]).mean(), s2none=(yp[st] == 4).mean(),
             none_rec=(yp[y == 4] == 4).mean(), unm2none=np.mean([P[i].argmax() == 4 for i in u]) if u else np.nan, n=len(idx))
    ia = [i for i in list(M.index[EV]) + list(M.index[UNM]) if i in P]; ya = np.array([CI.get(M.label[i], 4) for i in ia]); r["acc_all"] = (np.array([P[i].argmax() for i in ia]) == ya).mean()
    print(f"{name:46s} all-triggers acc {r['acc_all']:.3f} | acc {r['acc']:.3f} f1 {r['f1']:.3f} stroke-type {r['stroke4']:.3f} stroke->none {r['s2none']:.3f} none recall {r['none_rec']:.2f} extra->none {r['unm2none']:.2f} (n={r['n']})", flush=True)
    return r


BATCH = {"2": [(f"post {p}, extra triggers weight {u}, 3 seeds", dict(post=p, unm_w=u, seeds=3)) for p in (160, 320) for u in (0, 0.1, 0.3)],
         "3": [(f"post 160, 3 seeds, shift {sh}", dict(post=160, seeds=3, shift=sh)) for sh in (0, 40, 80)],"1": [(f"post {p} ms, all features", dict(post=p)) for p in (320, 160, 80)] +
              [(f"post 160, fs={f}", dict(post=160, fs=f)) for f in ("no-abspose", "no-meanstd", "no-nrm", "core")] +
              [("post 160, live windows only", dict(post=160, aug_off=False)), ("post 160, offline+jitter only", dict(post=160, causal_train=False)),
               ("post 160, shift aug +-40 only", dict(post=160, shift=40)), ("post 160, no aug", dict(post=160, shift=0))]}

if __name__ == "__main__":
    for name, cfg in BATCH[sys.argv[1]]:
        P, cols = run(cfg); report(name, P)
