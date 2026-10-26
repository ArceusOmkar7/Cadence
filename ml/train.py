"""Step 3: train and evaluate XGBoost stroke-type classifiers. Run: .venv/Scripts/python train.py"""
import json, warnings, numpy as np, pandas as pd
from xgboost import XGBClassifier
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold, LeaveOneGroupOut
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, confusion_matrix, classification_report
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.utils.class_weight import compute_sample_weight
warnings.filterwarnings("ignore")

X = pd.read_csv("features.csv"); M = pd.read_csv("windows_meta.csv")
CLASSES = ["forehand_drive", "backhand_drive", "smash", "push"]
stroke = M.label.isin(CLASSES).to_numpy()
Xs, Ms = X[stroke].reset_index(drop=True), M[stroke].reset_index(drop=True)
y = Ms.label.map({c: i for i, c in enumerate(CLASSES)}).to_numpy(); grp = (Ms.session.str[-4:] + "-" + Ms.set).to_numpy()
ball = Ms.ball.to_numpy()
GROUPS = {"imu": [c for c in X if c.startswith("imu_")], "imu+pose": [c for c in X if c.startswith(("imu_", "pose_"))], "imu+pose+fingers": list(X.columns)}
out = []
def P(*a):
    s = " ".join(str(x) for x in a); print(s); out.append(s)

def xgb(seed=0):
    return XGBClassifier(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.5, reg_lambda=2.0,
                         objective="multi:softprob", num_class=4, tree_method="hist", random_state=seed, n_jobs=4, verbosity=0)

def fit_predict(make, Xtr, ytr, Xte, weight=True):
    m = make()
    if isinstance(m, XGBClassifier): m.fit(Xtr, ytr, sample_weight=compute_sample_weight("balanced", ytr))
    else: m.fit(Xtr, ytr)
    return m.predict_proba(Xte) if hasattr(m, "predict_proba") else None, m

def scores(yt, yp): return dict(acc=accuracy_score(yt, yp), bal=balanced_accuracy_score(yt, yp), f1=f1_score(yt, yp, average="macro"))
def show(name, yt, yp):
    s = scores(yt, yp); P(f"{name:<58} acc {s['acc']:.3f}  balanced acc {s['bal']:.3f}  macro-F1 {s['f1']:.3f}  (n={len(yt)})"); return s

def loso(make, cols):
    pr = np.zeros((len(y), 4))
    for tr, te in LeaveOneGroupOut().split(Xs, y, grp):
        p, _ = fit_predict(make, Xs.loc[tr, cols], y[tr], Xs.loc[te, cols]); pr[te] = p
    return pr

P("DATA: %d stroke windows in %d sets (%s)" % (len(y), len(set(grp)), "; ".join(f"{c}: {int((y == i).sum())}" for i, c in enumerate(CLASSES))))
P("      shadow (no ball): %d windows, with ball: %d windows" % ((~ball).sum(), ball.sum()))
P("sets per class:", {c: len(set(grp[y == i])) for i, c in enumerate(CLASSES)}); P()

P("=== 1. Leave-one-SET-out (every window is predicted by a model that never saw any window of its set) ===")
res = {}
for name, cols in GROUPS.items():
    pr = loso(xgb, cols); res[name] = pr; show(f"XGBoost [{name}] ({len(cols)} features)", y, pr.argmax(1))
def lr(): return make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=2000, class_weight="balanced"))
pr_lr = loso(lr, GROUPS["imu+pose"]); show("Logistic regression [imu+pose] (baseline)", y, pr_lr.argmax(1))
P(f"{'Chance (4 classes) / always the biggest class':<58} acc 0.250 / {np.bincount(y).max() / len(y):.3f}")
best = max(res, key=lambda k: scores(y, res[k].argmax(1))["f1"])
P(f"\nconfusion matrix, XGBoost [{best}], rows = true, columns = predicted ({', '.join(CLASSES)}):")
cm = confusion_matrix(y, res[best].argmax(1)); P(pd.DataFrame(cm, index=CLASSES, columns=[c[:8] for c in CLASSES]).to_string())
P(classification_report(y, res[best].argmax(1), target_names=CLASSES, digits=3))
yp_best = res[best].argmax(1)
for nm, msk in [("shadow-play windows (no ball)", ~ball), ("with-ball windows", ball)]:
    P(f"leave-one-set-out accuracy on {nm}: {(yp_best[msk] == y[msk]).mean():.3f} (n={msk.sum()}), macro-F1 {f1_score(y[msk], yp_best[msk], average='macro'):.3f}")
P("per held-out set (recall of its class):")
rows = []
for gname in sorted(set(grp)):
    i = grp == gname; rows.append((gname, CLASSES[y[i][0]], "ball" if ball[i][0] else "shadow", int(i.sum()), (res[best].argmax(1)[i] == y[i]).mean()))
for r in rows: P(f"  {r[0]:>10} {r[1]:<15} {r[2]:<7} n={r[3]:>2}  recall {r[4]:.2f}")

P("\n=== 2. Repeated 4-fold, grouped by set, 20 random partitions (spread = how much the answer depends on which sets are held out) ===")
for name, cols in GROUPS.items():
    f1s, accs = [], []
    for seed in range(20):
        yp = np.zeros(len(y), int)
        for tr, te in StratifiedGroupKFold(n_splits=4, shuffle=True, random_state=seed).split(Xs, y, grp):
            yp[te] = fit_predict(lambda: xgb(seed), Xs.loc[tr, cols], y[tr], Xs.loc[te, cols])[0].argmax(1)
        s = scores(y, yp); f1s.append(s["f1"]); accs.append(s["acc"])
    P(f"XGBoost [{name:<17}] acc {np.mean(accs):.3f} +- {np.std(accs):.3f} (min {min(accs):.3f}, max {max(accs):.3f})   macro-F1 {np.mean(f1s):.3f} +- {np.std(f1s):.3f}")

P("\n=== 3. Across conditions (train on one session type, test on the other) ===")
cols = GROUPS[best]
for a, b, nm in [(~ball, ball, "train shadow-play -> test with-ball"), (ball, ~ball, "train with-ball -> test shadow-play")]:
    p, _ = fit_predict(xgb, Xs.loc[a, cols], y[a], Xs.loc[b, cols]); yt = y[b]
    s = show(nm, yt, p.argmax(1)); P("   per class recall:", {CLASSES[k]: round(float((p.argmax(1)[yt == k] == k).mean()), 2) if (yt == k).any() else None for k in range(4)})
    P("   confusion:\n" + pd.DataFrame(confusion_matrix(yt, p.argmax(1), labels=range(4)), index=[c[:8] for c in CLASSES], columns=[c[:8] for c in CLASSES]).to_string())

P("\n=== 4. What a careless split would have claimed (random window split, windows of one set on both sides) ===")
f1s, accs = [], []
for seed in range(20):
    yp = np.zeros(len(y), int)
    for tr, te in StratifiedKFold(n_splits=4, shuffle=True, random_state=seed).split(Xs, y):
        yp[te] = fit_predict(lambda: xgb(seed), Xs.loc[tr, cols], y[tr], Xs.loc[te, cols])[0].argmax(1)
    s = scores(y, yp); f1s.append(s["f1"]); accs.append(s["acc"])
P(f"XGBoost [{best}] random 4-fold: acc {np.mean(accs):.3f} +- {np.std(accs):.3f}, macro-F1 {np.mean(f1s):.3f}  <- inflated, do not quote")

P("\n=== 5. Stroke-only features vs finger features: which signal carries the answer? ===")
for name, cols_ in {"fingers+pressure only": [c for c in X if c.startswith("fing_")], "pose only": [c for c in X if c.startswith("pose_")]}.items():
    pr = loso(xgb, cols_); show(f"XGBoost [{name}] leave-one-set-out", y, pr.argmax(1))

P("\n=== 5b. Hyper-parameter sensitivity (leave-one-set-out macro-F1, [%s]); the defaults above were fixed in advance, not tuned ===" % best)
for d in (2, 3, 4):
    row = []
    for n in (100, 200, 400):
        mk = lambda d=d, n=n: XGBClassifier(n_estimators=n, max_depth=d, learning_rate=0.05, subsample=0.8, colsample_bytree=0.5, reg_lambda=2.0, objective="multi:softprob", num_class=4, tree_method="hist", random_state=0, n_jobs=4, verbosity=0)
        row.append(f1_score(y, loso(mk, cols).argmax(1), average="macro"))
    P(f"  max_depth {d}: n_estimators 100/200/400 -> " + " / ".join(f"{v:.3f}" for v in row))

# final model + importance
_, final = fit_predict(xgb, Xs[cols], y, Xs[cols])
imp = pd.Series(final.get_booster().get_score(importance_type="gain")).sort_values(ascending=False)
P("\n=== 6. Top 15 features of the final model (gain; trained on all windows, so descriptive only) ===")
for k, v in imp.head(15).items(): P(f"  {k:<26} {v:7.2f}")
final.save_model("stroke_xgb.json"); json.dump({"classes": CLASSES, "features": cols, "window": {"fs": 200, "pre_s": 0.48, "post_s": 0.32}}, open("stroke_xgb_meta.json", "w"), indent=1)

# idle windows: how confident is the model on non-stroke motion
idle = ~stroke
if idle.any():
    pi = final.predict_proba(X.loc[idle, cols]); P("\n=== 7. Windows from idle sets (not strokes; the model has no 'none' class) ===")
    for r, p in zip(M[idle].itertuples(), pi): P(f"  {r.session[-4:]}-{r.set} peak {r.peak_energy:.2f}: predicted {CLASSES[p.argmax()]} (p={p.max():.2f})")
    P("  strokes, for reference: median max-probability under leave-one-set-out = %.2f" % np.median(res[best].max(1)))
open("results.txt", "w").write("\n".join(out))
