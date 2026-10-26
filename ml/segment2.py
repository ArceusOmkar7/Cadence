"""Pipeline v2, step 1: cleaning + windows, now with a 'none' class, jittered copies and windows at the LIVE detector's peak.

Differences from segment.py: uses the re-exported shadow session (set_id/boot_id rows, so its idle set s7 is usable); idle sets give
'none' windows (every bump with smoothed energy >= 0.2; peak_energy tells which of them the live detector would fire on, >= 0.35);
every offline stroke window also gets copies shifted by +-40/+-80 ms (training augmentation, same 'parent'); and for every set the
causal detector (recorder v3 rules) is run and a window is cut around ITS peak ('causal' rows) to measure train/serve skew.
Cleaning rules are those of segment.py (discarded sets, mixed/cue sets, gaps near the peak, 20%-of-median weak peaks).
"""
import numpy as np, pandas as pd
from scipy.signal import find_peaks
from glovedata import *
from segment import smooth, grid, peaks_for, FS, PRE, POST, MAX_GAP_MS, CORE_S
import segment as S1

SESSIONS = [("20261025-162140-re-exported", False), ("20261025-172341", True)]
SHIFTS = [0, -80, -40, 40, 80]
PKI = int(PRE * FS); LEN = int((PRE + POST) * FS)


def load(name):
    p = DATASET / name
    return (pd.read_csv(p / "sets.csv"), pd.read_csv(p / "derived.csv"))


def cut(x, cols, i, hole, shift=0):
    lo = i - PKI + int(shift * FS / 1000); hi = lo + LEN
    if lo < 0 or hi > len(hole): return None
    c0 = int(CORE_S * FS); j = i + int(shift * FS / 1000)
    if (hole[lo:hi] > MAX_GAP_MS).any() or (hole[max(j - c0, 0):j + c0] > 12).any(): return None
    return np.c_[[x[c][lo:hi] for c in cols]].T.astype(np.float32)


def main():
    cols = GYR + ACC + ["roll_deg", "pitch_deg"] + CURL + ["pressure_pct"]
    W, rows, rep = [], [], []
    pid = 0
    for sname, ball in SESSIONS:
        sets, der = load(sname)
        for r in sets.itertuples():
            sid = f"{sname[-4:] if ball else '2140'}-{r.set_id.split('-')[-1]}"
            if r.status == "discarded" or r.kind == "cue":
                rep.append(dict(set=sid, label=r.label, note="discarded" if r.status == "discarded" else "mixed/cue: labels not verified")); continue
            d = der[der.set_id == r.set_id]; d = d[(d.t_us >= r.t_start_us) & (d.t_us <= r.t_end_us)].sort_values("t_us").reset_index(drop=True)
            g, x, hole = grid(d, cols)
            G = np.c_[[x[c] for c in GYR]].T; A = np.c_[[x[c] for c in ACC]].T
            es, pk = peaks_for(g, G, A)
            label = "none" if r.kind == "idle" else r.label
            if r.kind == "idle":   # every bump >= 0.2, and no recovery rule: none of these is a stroke
                e = np.hypot(np.linalg.norm(G, axis=1) / 500, np.linalg.norm(A, axis=1) / 2); es = smooth(e[:, None], 10)[:, 0]
                pk, _ = find_peaks(es, height=0.2, prominence=0.08, distance=int(0.3 * FS))
            elif len(pk):
                strong = es[pk] >= 0.2 * np.median(es[pk]); pk = pk[strong]
            n_off = n_c = 0
            for i in pk:
                base = dict(session="ball" if ball else "shadow", set=sid, label=label, ball=ball, peak_energy=es[i], parent=pid, kind="offline", tempo=r.tempo)
                for sh in (SHIFTS if r.kind != "idle" else [0]):
                    w = cut(x, cols, i, hole, sh)
                    if w is not None: W.append(w); rows.append({**base, "shift_ms": sh}); n_off += sh == 0
                pid += 1
            # causal detector windows (what the live app would classify)
            ev = detect(d.t_us.to_numpy(), d[GYR].to_numpy(), d[ACC].to_numpy())
            for j, (ix, pe) in enumerate(ev):
                gi = int(np.searchsorted(g, d.t_us.iloc[ix]))
                w = cut(x, cols, min(gi, len(g) - 1), hole)
                if w is None: continue
                near = [p for p in pk if abs(g[p] - d.t_us.iloc[ix]) < 250_000]
                lab = "none" if r.kind == "idle" else (r.label if near else "unmatched")
                W.append(w); rows.append(dict(session="ball" if ball else "shadow", set=sid, label=lab, ball=ball, peak_energy=pe, parent=-1 - j, kind="causal", tempo=r.tempo, shift_ms=0,
                                              offset_ms=(d.t_us.iloc[ix] - g[near[0]]) / 1000 if near else np.nan)); n_c += 1
            rep.append(dict(set=sid, label=label, note="used", offline_peaks=len(pk), windows_shift0=n_off, causal_windows=n_c, secs=round(len(d) / FS)))
    np.save("windows2.npy", np.stack(W)); M = pd.DataFrame(rows); M.to_csv("windows2_meta.csv", index=False)
    pd.DataFrame(rep).to_csv("cleaning_report2.csv", index=False)
    pd.set_option("display.width", 220); print(pd.DataFrame(rep).to_string())
    print(M[(M.kind == "offline") & (M.shift_ms == 0)].groupby(["label", "session"]).size().unstack(fill_value=0))
    print("causal windows:"); print(M[M.kind == "causal"].groupby(["label", "session"]).size().unstack(fill_value=0))
    print("none windows with peak>=0.35 (live detector would fire):", int(((M.label == "none") & (M.kind == "offline") & (M.peak_energy >= 0.35)).sum()))

if __name__ == "__main__": main()
