"""Step 1: clean the exported sessions and cut one fixed window per stroke.

Cleaning rules (every drop is counted in the report):
  * sets with status discarded are not exported at all;
  * mixed (cue) sets are excluded: their labels were never verified;
  * session 20261025-162140 was exported before rows carried set_id/boot_id; the glove restarted during it, so any set whose
    time window holds a duplicated sequence number or a rate far from 200 Hz is excluded (s7, s9);
  * each set is resampled onto a uniform 200 Hz grid. A hole is one lost datagram (about 8 samples = 40 ms). A window is dropped if a
    hole is longer than 45 ms anywhere, or if ANY hole (> 1 sample) lies within 150 ms of the peak; holes elsewhere in the window
    are bridged by linear interpolation;
  * in a stroke set, a peak under 20% of the set's median peak is not a stroke of that class (e.g. a 0.45 bump between smashes of 5);
  * a window must lie fully inside its set.
Segmentation is offline (non-causal): the energy used by the recorder's detector, smoothed with a centred 50 ms window, then
scipy find_peaks, then the recorder's recovery rule (a bump within 0.9 s of the previous stroke that is under half its size or
swings against it is the hand returning, not a stroke).
"""
import numpy as np, pandas as pd
from scipy.signal import find_peaks
from glovedata import *

FS = 200; PRE = 0.48; POST = 0.32; MAX_GAP_MS = 45; CORE_S = 0.15; MIN_PEAK = 0.35
SESSIONS = ["20261025-162140", "20261025-172341"]
EXCLUDE_KIND = {"cue"}


def smooth(x, n=10):
    k = np.ones(n) / n
    return np.apply_along_axis(lambda v: np.convolve(np.pad(v, (n // 2, n - 1 - n // 2), mode="edge"), k, "valid"), 0, x)


def set_frame(sess, r, der, labelled):
    d = der[der.set_id == r.set_id] if labelled else der
    d = d[(d.t_us >= r.t_start_us) & (d.t_us <= r.t_end_us)].sort_values("t_us")
    return d.reset_index(drop=True)


def grid(d, cols):
    """Uniform 200 Hz grid + validity mask (False inside a hole longer than MAX_GAP_MS)."""
    t = d.t_us.to_numpy(float); g = np.arange(t[0], t[-1], 1e6 / FS)
    out = {c: np.interp(g, t, d[c].to_numpy(float)) for c in cols}
    idx = np.searchsorted(t, g, side="right") - 1
    nxt = np.minimum(idx + 1, len(t) - 1)
    hole = (t[nxt] - t[np.maximum(idx, 0)]) / 1000
    return g, out, hole


def peaks_for(g, G, A):
    e = np.hypot(np.linalg.norm(G, axis=1) / DET["gyroScaleDps"], np.linalg.norm(A, axis=1) / DET["accelScaleG"])
    es = smooth(e[:, None], 10)[:, 0]; gs = smooth(G, 10)
    idx, _ = find_peaks(es, height=MIN_PEAK, prominence=0.15, distance=int(0.3 * FS))
    keep = []; last = None
    for i in idx:
        if last is not None and g[i] - g[last] < DET["recoveryMs"] * 1000 and (es[i] < DET["recoveryRatio"] * es[last] or cosine(gs[i], gs[last]) < DET["recoveryCos"]):
            continue
        keep.append(i); last = i
    return es, np.array(keep, int)


def main():
    rep = []; wins = []; meta_rows = []
    cols = GYR + ACC + ["roll_deg", "pitch_deg"] + CURL + ["pressure_pct"]
    for sess in SESSIONS:
        meta, sets, mot, der, ana, ev = load_session(sess)
        labelled = "set_id" in der.columns
        for r in sets.itertuples():
            row = dict(session=sess, set=r.set_id.split("-")[-1], label=r.label, kind=r.kind, status=r.status, ball=meta["with_ball"])
            if r.status == "discarded": row["note"] = "discarded in the app"; rep.append(row); continue
            if r.kind in EXCLUDE_KIND: row["note"] = "mixed/cue set: labels not verified"; rep.append(row); continue
            d = set_frame(sess, r, der, labelled)
            dup = int(mot[(mot.t_us >= r.t_start_us) & (mot.t_us <= r.t_end_us)].seq.duplicated().sum()) if not labelled else 0
            hz = (len(d) - 1) / ((d.t_us.iloc[-1] - d.t_us.iloc[0]) / 1e6)
            if dup or abs(hz - 200) > 10: row["note"] = f"mixed glove runs (dup seq {dup}, {hz:.0f} Hz)"; rep.append(row); continue
            g, x, hole = grid(d, cols)
            G = np.c_[[x[c] for c in GYR]].T; A = np.c_[[x[c] for c in ACC]].T
            es, pk = peaks_for(g, G, A)
            nbad = ntouch = nweak = 0; n_in = 0
            if r.kind == "stroke" and len(pk):
                strong = es[pk] >= 0.2 * np.median(es[pk]); nweak = int((~strong).sum()); pk = pk[strong]
            for i in pk:
                lo, hi = i - int(PRE * FS), i + int(POST * FS)
                if lo < 0 or hi > len(g): ntouch += 1; continue
                c0 = int(CORE_S * FS)
                if (hole[lo:hi] > MAX_GAP_MS).any() or (hole[i - c0:i + c0] > 12).any(): nbad += 1; continue
                n_in += 1
                wins.append(np.c_[[x[c][lo:hi] for c in cols]].T.astype(np.float32))
                meta_rows.append(dict(session=sess, set=row["set"], set_id=r.set_id, label=r.label, kind=r.kind, ball=meta["with_ball"], t_peak_us=g[i], peak_energy=es[i], tempo=r.tempo))
            row.update(note="used", peaks=len(pk), windows=n_in, dropped_weak=nweak, dropped_edge=ntouch, dropped_gap=nbad, expected=r.expected_n, hz=round(hz, 1), secs=round(len(d) / FS))
            rep.append(row)
    rep = pd.DataFrame(rep); meta_df = pd.DataFrame(meta_rows)
    np.save("windows.npy", np.stack(wins)); meta_df.to_csv("windows_meta.csv", index=False); rep.to_csv("cleaning_report.csv", index=False)
    pd.set_option("display.width", 250); print(rep.to_string())
    print("\nwindows per class and session:"); print(meta_df.groupby(["label", "ball"]).size().unstack(fill_value=0))
    print("columns:", cols)

if __name__ == "__main__": main()
