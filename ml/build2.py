import numpy as np, pandas as pd, features as F
W = np.load("windows2.npy"); X = pd.DataFrame([F.feats(w) for w in W]); X.to_csv("features2.csv", index=False); print(X.shape)
M = pd.read_csv("windows2_meta.csv"); u = M[M.label == "unmatched"]; print(u.groupby("session").peak_energy.describe())
