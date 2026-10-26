"""Exports the trained XGBoost models in a compact form the browser evaluates (recorder/public/models/stroke_live{160,320}.json), plus
parity fixtures: windows, Python features and Python probabilities, so the TypeScript port can be tested against this code.
Run: .venv/Scripts/python export_compact.py"""
import json, numpy as np, pandas as pd
from pathlib import Path
from xgboost import XGBClassifier
import exp3 as E

OUT = Path("../recorder/public/models"); OUT.mkdir(parents=True, exist_ok=True)
FIX = Path("../recorder/test/fixtures"); FIX.mkdir(parents=True, exist_ok=True)


def compact(path):
    m = json.load(open(path)); lm = m["learner"]; gb = lm["gradient_booster"]["model"]
    base = [float(x) for x in lm["learner_model_param"]["base_score"].strip("[]").split(",")]
    trees = []
    for t, cls in zip(gb["trees"], gb["tree_info"]):
        assert all(s == 0 for s in t["split_type"]) and not t["categories"]
        trees.append({"c": cls, "l": t["left_children"], "r": t["right_children"], "f": t["split_indices"],
                      "t": [float(x) for x in t["split_conditions"]], "d": [int(x) for x in t["default_left"]]})
    return base, trees


def predict_py(base, trees, x):
    margin = list(base)
    for t in trees:
        n = 0
        while t["l"][n] != -1:
            v = x[t["f"][n]]
            n = (t["l"][n] if t["d"][n] else t["r"][n]) if v != v else (t["l"][n] if np.float32(v) < np.float32(t["t"][n]) else t["r"][n])
        margin[t["c"]] += t["t"][n]
    e = np.exp(np.array(margin) - max(margin)); return e / e.sum()


import re
RES = open("results_final.txt").read()
CALIB = json.load(open("../dataset/20261025-172341/calibration.json"))["start"]


def evidence(post):
    """Numbers measured by final.py for this latency, parsed from results_final.txt (never typed by hand)."""
    block = RES.split("================")[2 if post == 160 else 4]  # pieces: "", heading, body160, heading, body320
    acc = float(re.search(r"^accuracy ([0-9.]+);", block, re.M).group(1))
    lo, hi = map(float, re.search(r"95% interval ([0-9.]+) - ([0-9.]+)", block).groups())
    rec = {m.group(1): float(m.group(2)) for m in re.finditer(r"(\w+) ([0-9.]+) \(n=\d+\)", re.search(r"recall per class: (.*)", block).group(1))}
    nw = re.search(r"live windows evaluated: (\d+)", block).group(1)
    ns = re.search(r"bootstrap over (\d+) sets", block).group(1)
    return {"accuracy": acc, "interval": [lo, hi], "recall": rec, "windows": int(nw), "sets": int(ns),
            "how": "leave-one-set-out: every window was classified by a model that never saw any window of its set"}


rng = np.random.default_rng(1)
for post in (160, 320):
    meta = json.load(open(f"models/stroke_live{post}_meta.json"))
    seeds = [compact(f"models/stroke_live{post}_seed{s}.json") for s in range(3)]
    # sanity: the compact form reproduces xgboost's own probabilities
    X = E.feats(post)[meta["features"]]
    idx = rng.choice(len(X), 40, replace=False)
    mods = [XGBClassifier() for _ in range(3)]
    for s, m in enumerate(mods): m.load_model(f"models/stroke_live{post}_seed{s}.json")
    ref = np.mean([m.predict_proba(X.iloc[idx].to_numpy(np.float32)) for m in mods], axis=0)
    mine = np.array([np.mean([predict_py(b, t, X.iloc[i].to_numpy(np.float32)) for b, t in seeds], axis=0) for i in idx])
    print(post, "max |xgboost - compact| =", np.abs(ref - mine).max())
    assert np.abs(ref - mine).max() < 1e-4
    out = {"classes": meta["classes"], "features": meta["features"], "post_ms": post, "peak_index": meta["peak_index"], "fs": meta["fs"],
           "evidence": evidence(post), "trained_mount_q_wxyz": CALIB["mount_q_wxyz"], "seeds": [{"base": b, "trees": t} for b, t in seeds]}
    (OUT / f"stroke_live{post}.json").write_text(json.dumps(out, separators=(",", ":")))
    print("   wrote", (OUT / f"stroke_live{post}.json").stat().st_size // 1024, "KB")
    # parity fixture: 30 windows (peak at 96), their features and probabilities
    sel = idx[:12]
    fx = {"post_ms": post, "windows": E.W[sel].round(4).tolist(), "features": {k: X.iloc[sel][k].tolist() for k in meta["features"]}, "proba": ref[:12].round(6).tolist()}
    (FIX / f"parity_{post}.json").write_text(json.dumps(fx, separators=(",", ":")))
