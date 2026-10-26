"""Final evaluation + export of the live-matched models. Run: .venv/Scripts/python final.py
Writes results_final.txt, models/stroke_live{160,320}.json (+ _meta.json with the exact feature list and window definition)."""
import json, os, numpy as np, pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import confusion_matrix
from sklearn.utils.class_weight import compute_sample_weight
import exp3 as E

out = []
def P_(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); out.append(s)

CL = E.CL; CI = E.CI
rng = np.random.default_rng(0)
os.makedirs("models", exist_ok=True)
for post in (160, 320):
    cfg = dict(post=post, unm_w=0.1, seeds=3)
    P, cols = E.run(cfg)
    ev = [i for i in E.M.index[E.EV] if i in P]; un = [i for i in E.M.index[E.UNM] if i in P]
    y = E.M.loc[ev, "label"].map(CI).to_numpy(); pr = np.array([P[i] for i in ev]); yp = pr.argmax(1); sets = E.M.loc[ev, "set"].to_numpy(); sess = E.M.loc[ev, "session"].to_numpy()
    P_(f"\n================ live window ends {post} ms after the detector's peak (classification {post + 25} ms after the energy peak, ~{post - 120} ms after the detector fires) ================")
    P_(f"features: {len(cols)}; training = offline strokes +-80 ms jitter + live-detector windows + idle bumps + extra triggers (weight 0.1); leave-one-set-out, 3 seeds averaged")
    P_(f"live windows evaluated: {len(ev)} (strokes {int((y < 4).sum())}, idle triggers {int((y == 4).sum())}) + {len(un)} extra triggers inside stroke sets")
    P_(f"accuracy {np.mean(yp == y):.3f}; stroke type among real strokes {np.mean(yp[y < 4] == y[y < 4]):.3f}; real stroke lost as 'none' {np.mean(yp[y < 4] == 4):.3f}; idle trigger rejected {np.mean(yp[y == 4] == 4):.3f}; extra triggers rejected {np.mean([P[i].argmax() == 4 for i in un]):.3f}")
    for s in ("shadow", "ball"):
        m = sess == s; P_(f"   {s:6s} windows: accuracy {np.mean(yp[m] == y[m]):.3f} (n={m.sum()})")
    # bootstrap over sets (the honest unit: windows of one set are correlated)
    us = np.unique(sets); accs = []
    for _ in range(2000):
        pick = rng.choice(us, len(us)); idx = np.concatenate([np.where(sets == s)[0] for s in pick]); accs.append(np.mean(yp[idx] == y[idx]))
    P_(f"accuracy, bootstrap over {len(us)} sets: 95% interval {np.percentile(accs, 2.5):.3f} - {np.percentile(accs, 97.5):.3f}")
    P_("confusion matrix (rows true, columns predicted: " + ", ".join(CL) + ")")
    P_(pd.DataFrame(confusion_matrix(y, yp, labels=range(5)), index=[c[:8] for c in CL], columns=[c[:8] for c in CL]).to_string())
    P_("recall per class: " + ", ".join(f"{CL[k]} {np.mean(yp[y == k] == k):.2f} (n={(y == k).sum()})" for k in range(5)))
    P_("\nconfidence cut-off (below it the app says 'unsure' instead of a class):")
    mp = pr.max(1)
    for t in (0.0, 0.5, 0.6, 0.7, 0.8, 0.9):
        k = mp >= t; P_(f"   max-probability >= {t:.1f}: answers {k.mean():.0%} of triggers, accuracy on those {np.mean(yp[k] == y[k]):.3f}")
    # final model on all data
    X = E.feats(post); tr = E.rows(cfg); yt = E.M.loc[tr, "label"].replace({"unmatched": "none"}).map(CI).to_numpy()
    w = compute_sample_weight("balanced", yt) * np.where(E.UNM[tr].to_numpy(), 0.1, 1.0)
    models = []
    for seed in range(3):
        m = XGBClassifier(**E.XGBP, objective="multi:softprob", num_class=5, tree_method="hist", random_state=seed, n_jobs=3, verbosity=0)
        m.fit(X.loc[tr, cols], yt, sample_weight=w); m.save_model(f"models/stroke_live{post}_seed{seed}.json"); models.append(m)
    imp = pd.concat([pd.Series(m.get_booster().get_score(importance_type="gain")) for m in models], axis=1).mean(axis=1).sort_values(ascending=False)
    P_("\ntop 12 features of the final model (mean gain over 3 seeds; descriptive only):")
    for k, v in imp.head(12).items(): P_(f"   {k:<24} {v:6.2f}")
    json.dump({"classes": CL, "features": cols, "fs": 200, "peak_index": 96, "pre_ms": 480, "post_ms": post, "smoothing": "box, edge-replicated",
               "models": [f"stroke_live{post}_seed{s}.json" for s in range(3)], "combine": "mean of predict_proba", "trained_on_windows": int(tr.sum()),
               "channels": ["gyro_x_dps", "gyro_y_dps", "gyro_z_dps", "acc_x_g", "acc_y_g", "acc_z_g", "roll_deg", "pitch_deg"]},
              open(f"models/stroke_live{post}_meta.json", "w"), indent=1)
open("results_final.txt", "w").write("\n".join(out))
