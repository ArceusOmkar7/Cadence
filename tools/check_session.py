"""Loads a recorded session folder and reports whether the data is usable, set by set.

  python tools/check_session.py recordings/20261025-142440                 # report only
  python tools/check_session.py recordings/20261025-142440 --plot s1       # also save a plot of set s1 (PNG next to the session)
  python tools/check_session.py recordings/20261025-142440.zip             # a zip export works too

Prints, per kept set: the real sample rate, loss, longest gap, glove run (boot_id). Then events per class and flagged sets.
Exits with 1 if a file fails to load or a set is clearly broken (loss over 5%, a gap over 500 ms, time going backwards, two glove
runs in one set), so it can guard a training pipeline.

Important: the glove's clock restarts at power-up. Rows are labelled with set_id and boot_id; always select by set_id.
Exports made before those columns existed cannot be separated reliably if the glove restarted during the session.
"""
import argparse, json, sys, tempfile, zipfile
from pathlib import Path

import numpy as np
import pandas as pd


def load(path: Path):
    if path.suffix == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="glove_session_"))
        zipfile.ZipFile(path).extractall(tmp)
        path = next(tmp.iterdir())
    need = ["meta.json", "calibration.json", "motion.csv", "analog.csv", "derived.csv", "sets.csv", "events.csv"]
    missing = [n for n in need if not (path / n).exists()]
    if missing:
        sys.exit(f"missing files: {missing}")
    return path, {
        "meta": json.loads((path / "meta.json").read_text()),
        "cal": json.loads((path / "calibration.json").read_text()),
        "motion": pd.read_csv(path / "motion.csv"),
        "analog": pd.read_csv(path / "analog.csv"),
        "derived": pd.read_csv(path / "derived.csv"),
        "sets": pd.read_csv(path / "sets.csv"),
        "events": pd.read_csv(path / "events.csv"),
    }


def stats(df, allow_equal_time=False):
    """Rate, loss and gaps of one continuous stream (one set)."""
    t = df["t_us"].to_numpy(dtype=np.float64)
    seq = df["seq"].to_numpy(dtype=np.int64)
    gaps = np.diff(t) / 1000.0
    span = (t[-1] - t[0]) / 1e6 if len(t) > 1 else 0
    backwards = int((np.diff(t) < (0 if allow_equal_time else 1)).sum()) if len(t) > 1 else 0
    expected = int(seq.max() - seq.min() + 1)
    return dict(n=len(df), hz=(len(df) - 1) / span if span else float("nan"), loss=100 * (expected - len(df)) / expected if expected else 0,
                longest=float(gaps.max()) if len(gaps) else 0, over50=int((gaps > 50).sum()), backwards=backwards, dup=int(df["seq"].duplicated().sum()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session")
    ap.add_argument("--plot", metavar="SET_ID", help="save a plot of one set (id or its s-number, e.g. s1)")
    a = ap.parse_args()
    path, d = load(Path(a.session))
    meta, sets, events, motion, analog, derived = d["meta"], d["sets"], d["events"], d["motion"], d["analog"], d["derived"]
    ok = True
    labelled = "set_id" in motion.columns

    print(f"session {meta['session_id']}: {meta['hand']} hand, ball={meta['with_ball']}, holdout={meta['holdout']}, firmware {meta['glove']['fw']}")
    keys = ["mount_q_wxyz", "gyro_bias_dps", "acc_offset_g", "acc_scale", "open_ohm_by_channel", "fist_ohm_by_channel", "force_full_v", "finger_to_channel"]
    sig = lambda c: [c.get(k) for k in keys] if c else None
    cal = d["cal"]
    changed = cal.get("end") is not None and sig(cal["start"]) != sig(cal["end"])
    print(f"calibration: {'CHANGED between start and end of the session' if changed else 'unchanged'}")
    if not labelled:
        print("WARNING: this export has no set_id/boot_id columns (older exporter). Rows are selected by time window, which is wrong if the\n"
              "         glove restarted during the session (its clock begins again from zero). Re-export the session with the current app.")
    print(f"derived rows match motion rows: {len(derived) == len(motion)}")
    print("yaw column present (must not be):", any("yaw" in c.lower() for c in derived.columns))
    ok &= len(derived) == len(motion) and not any("yaw" in c.lower() for c in derived.columns)

    sets["duration_s"] = (sets["t_end_us"] - sets["t_start_us"]) / 1e6
    kept = sets[sets["status"] != "discarded"]
    print(f"\nper set ({len(kept)} kept of {len(sets)}):")
    print(f"{'set':>5} {'class':<15} {'status':<8} {'IMU Hz':>7} {'loss%':>6} {'longest gap':>12} {'>50ms':>6} {'ADC loss%':>9} {'boot':>12}  flags")
    for s in kept.itertuples():
        sid = s.set_id.split("-")[-1]
        if labelled:
            m, an = motion[motion["set_id"] == s.set_id], analog[analog["set_id"] == s.set_id]
        else:
            m = motion[(motion.t_us >= s.t_start_us) & (motion.t_us <= s.t_end_us)]
            an = analog[(analog.t_us >= s.t_start_us) & (analog.t_us <= s.t_end_us)]
        m = m[(m.t_us >= s.t_start_us) & (m.t_us <= s.t_end_us)]
        an = an[(an.t_us >= s.t_start_us) & (an.t_us <= s.t_end_us)]
        if len(m) < 2:
            print(f"{sid:>5} {s.label:<15} no motion rows"); ok = False; continue
        ms, as_ = stats(m), stats(an, allow_equal_time=True)  # the two ADC chips convert at the same instants
        boots = sorted(m["boot_id"].unique()) if labelled else ["?"]
        bad = ms["backwards"] or ms["dup"] or as_["backwards"] or ms["loss"] > 5 or ms["longest"] > 500 or len(boots) > 1
        ok &= not bad
        flag = "" if pd.isna(s.flags) else s.flags
        print(f"{sid:>5} {s.label:<15} {s.status:<8} {ms['hz']:7.1f} {ms['loss']:6.2f} {ms['longest']:9.0f} ms {ms['over50']:6d} {as_['loss']:9.2f} {str(boots[0]):>12}  {flag}{'  <-- PROBLEM' if bad else ''}")
    if labelled:
        runs = motion.groupby("set_id")["boot_id"].first()
        print(f"\nglove runs in this session: {runs.nunique()}" + ("  (the glove restarted between sets: do not put different runs on one time axis)" if runs.nunique() > 1 else ""))

    print("\nanalog channels (kept sets):")
    a_kept = analog[analog["set_id"].isin(kept["set_id"])] if labelled else analog
    for ch, g in a_kept.groupby("channel"):
        print(f"  channel {ch} ({g['finger'].iloc[0]}): {len(g)} rows, raw mean {g['raw'].mean():.0f}, sd {g['raw'].std():.1f}")

    print("\nevents per class (status ok, in kept sets; ambiguous ones are not counted):")
    keep_ids = set(sets.loc[sets["status"].isin(["ok", "flagged"]), "set_id"])
    good = events[(events["status"] == "ok") & events["set_id"].isin(keep_ids)]
    print(good.groupby("label").size().to_string() if len(good) else "  none")
    amb = events[(events["status"] == "ambiguous") & events["set_id"].isin(keep_ids)]
    if len(amb):
        print(f"  ({len(amb)} ambiguous events in kept sets are excluded)")
    idle_min = sets.loc[(sets["kind"] == "idle") & sets["status"].isin(["ok", "flagged"]), "duration_s"].sum() / 60
    print(f"idle: {idle_min:.1f} min")

    if a.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        sid = a.plot if a.plot in set(sets["set_id"]) else next((s for s in sets["set_id"] if s.endswith("-" + a.plot)), None)
        if sid is None:
            sys.exit(f"no such set: {a.plot}")
        s = sets[sets["set_id"] == sid].iloc[0]
        lo, hi = s["t_start_us"] - 5e5, s["t_end_us"] + 2e5
        sel = (lambda df: df[(df["set_id"] == sid)]) if labelled else (lambda df: df)
        m = sel(motion); m = m[(m["t_us"] >= lo) & (m["t_us"] <= hi)]
        dv = sel(derived); dv = dv[(dv["t_us"] >= lo) & (dv["t_us"] <= hi)]
        ev = events[(events["set_id"] == sid) & (events["status"] != "deleted")]
        t0 = s["t_start_us"]
        fig, ax = plt.subplots(4, 1, figsize=(11, 9), sharex=True)
        ax[0].plot((m["t_us"] - t0) / 1e6, m[["gx", "gy", "gz"]].to_numpy() / 16.4); ax[0].set_ylabel("raw gyro, dps")
        ax[1].plot((m["t_us"] - t0) / 1e6, m[["ax", "ay", "az"]].to_numpy() / 2048); ax[1].set_ylabel("raw accel, g")
        g = np.hypot.reduce(dv[["gyro_x_dps", "gyro_y_dps", "gyro_z_dps"]].to_numpy().T) / 500
        ac = np.hypot.reduce(dv[["acc_x_g", "acc_y_g", "acc_z_g"]].to_numpy().T) / 2
        ax[2].plot((dv["t_us"] - t0) / 1e6, np.hypot(g, ac)); ax[2].set_ylabel("derived energy (unsmoothed)")
        ax[3].plot((dv["t_us"] - t0) / 1e6, dv[[c for c in dv.columns if c.startswith("curl_")]].to_numpy()); ax[3].set_ylabel("curl 0-1"); ax[3].set_xlabel("s from set start")
        for x in ax:
            for t in ev["t_peak_us"]:
                x.axvline((t - t0) / 1e6, color="g", alpha=0.5)
            x.axvspan(0, (s["t_end_us"] - t0) / 1e6, color="gray", alpha=0.07)
        fig.suptitle(f"{sid}: {s['label']} ({len(ev)} events)")
        out = path / f"plot_{sid}.png"
        fig.tight_layout(); fig.savefig(out, dpi=110)
        print(f"\nplot saved: {out}")

    print("\nRESULT:", "OK" if ok else "PROBLEMS FOUND")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
