import numpy as np, pandas as pd, exp3 as E
P, cols = E.run(dict(post=320, unm_w=0.1, seeds=1))
ev = [i for i in E.M.index[E.EV] if i in P]; d = E.M.loc[ev, ["set", "label", "session"]].copy()
d["pred"] = [E.CL[P[i].argmax()] for i in ev]; d["ok"] = d.label == d.pred
t = d.groupby(["label", "session", "set"]).agg(n=("ok", "size"), recall=("ok", "mean"), wrong=("pred", lambda s: ", ".join(f"{k}:{v}" for k, v in s.value_counts().items()))).round(2)
print(t.to_string())
