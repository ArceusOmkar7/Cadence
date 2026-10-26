"""Other model families on the same data and the same leave-one-set-out protocol as exp3.py (XGBoost).
Every model gets the same training windows (offline strokes with +-80 ms jitter, live-detector windows, idle bumps, extra triggers at weight 0.1)
and the same features (features_live.py, 93 columns). Models without sample weights are fed a weighted resample instead.
Run: .venv/Scripts/python exp4.py [post_ms ...]    -> results_models.txt"""
import sys, time, warnings, numpy as np, pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.utils.class_weight import compute_sample_weight
from lightgbm import LGBMClassifier
from xgboost import XGBClassifier
import exp3 as E

warnings.filterwarnings("ignore")
CI = E.CI; M = E.M
SEEDS = 3


def models():
    xgb = lambda s: XGBClassifier(**E.XGBP, objective="multi:softprob", num_class=5, tree_method="hist", random_state=s, n_jobs=3, verbosity=0)
    return {
        "XGBoost (current)": (lambda s: xgb(s), True),
        "LightGBM": (lambda s: LGBMClassifier(n_estimators=200, max_depth=3, num_leaves=8, learning_rate=0.05, subsample=0.8, subsample_freq=1, colsample_bytree=0.5, reg_lambda=2.0, min_child_samples=10, random_state=s, verbose=-1, n_jobs=3), True),
        "sklearn HistGradientBoosting": (lambda s: HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=200, l2_regularization=2.0, random_state=s), True),
        "Random forest": (lambda s: RandomForestClassifier(n_estimators=400, min_samples_leaf=2, max_features="sqrt", n_jobs=3, random_state=s), True),
        "Extra trees": (lambda s: ExtraTreesClassifier(n_estimators=500, min_samples_leaf=2, max_features="sqrt", n_jobs=3, random_state=s), True),
        "Logistic regression": (lambda s: make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=3000)), True),
        "SVM (RBF)": (lambda s: make_pipeline(StandardScaler(), SVC(C=3.0, gamma="scale", probability=True, random_state=s)), True),
        "k-nearest neighbours (k=7)": (lambda s: make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=7, weights="distance")), False),
        "Small neural net (MLP)": (lambda s: make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(64, 32), alpha=1e-2, max_iter=600, early_stopping=False, random_state=s)), False),
    }


def fit_proba(make, weighted, Xtr, ytr, wtr, Xte, seeds):
    out = 0
    for s in range(seeds):
        m = make(s)
        if weighted:
            if hasattr(m, "steps"): m.fit(Xtr, ytr, **{m.steps[-1][0] + "__sample_weight": wtr})
            else: m.fit(Xtr, ytr, sample_weight=wtr)
        else:
            rng = np.random.default_rng(s); idx = rng.choice(len(ytr), len(ytr), p=wtr / wtr.sum()); m.fit(Xtr.iloc[idx], ytr[idx])
        p = m.predict_proba(Xte); full = np.zeros((len(Xte), 5)); full[:, m.classes_ if not hasattr(m, "steps") else m.steps[-1][1].classes_] = p
        out = out + full / seeds
    return out


def loso(name, make, weighted, post, seeds):
    cfg = dict(post=post, unm_w=0.1); X = E.feats(post); cols = [c for c in X]
    tr_all = E.rows(cfg); P = {}
    for s in sorted(M.set.unique()):
        te = (M.set == s) & (E.EV | E.UNM)
        if not te.any(): continue
        tr = tr_all & (M.set != s)
        y = M.loc[tr, "label"].replace({"unmatched": "none"}).map(CI).to_numpy()
        w = compute_sample_weight("balanced", y) * np.where(E.UNM[tr].to_numpy(), cfg["unm_w"], 1.0)
        pr = fit_proba(make, weighted, X.loc[tr, cols], y, w, X.loc[te, cols], seeds)
        for i, p in zip(M.index[te], pr): P[i] = p
    return P


if __name__ == "__main__":
    posts = [int(a) for a in sys.argv[1:]] or [160, 320]
    out, allP = [], {}
    for post in posts:
        out.append(f"\n===== window ends {post} ms after the detector peak; leave-one-set-out; {SEEDS} seeds for models with randomness =====")
        for name, (make, weighted) in models().items():
            t0 = time.time(); P = loso(name, make, weighted, post, 1 if name.startswith(("Logistic", "k-nearest", "SVM")) else SEEDS); allP[(post, name)] = P
            r = E.report(name, P); out.append(f"{name:34s} all-triggers {r['acc_all']:.3f} | acc {r['acc']:.3f} macro-F1 {r['f1']:.3f} stroke-type {r['stroke4']:.3f} stroke->none {r['s2none']:.3f} none-recall {r['none_rec']:.2f} extra->none {r['unm2none']:.2f}  ({time.time() - t0:.0f}s)")
        # soft-vote ensembles of the best families
        for combo in (("XGBoost (current)", "Random forest"), ("XGBoost (current)", "LightGBM", "Extra trees", "SVM (RBF)")):
            keys = [(post, n) for n in combo]; P = {i: np.mean([allP[k][i] for k in keys], axis=0) for i in allP[keys[0]]}
            name = "Vote: " + " + ".join(c.split(" (")[0] for c in combo); r = E.report(name, P)
            out.append(f"{name:34s} all-triggers {r['acc_all']:.3f} | acc {r['acc']:.3f} macro-F1 {r['f1']:.3f} stroke-type {r['stroke4']:.3f} stroke->none {r['s2none']:.3f} none-recall {r['none_rec']:.2f} extra->none {r['unm2none']:.2f}")
    open("results_models.txt", "w").write("\n".join(out))
