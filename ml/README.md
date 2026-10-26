# Stroke-type classifier (XGBoost)

Setup (Windows): `python -m venv .venv && .venv\Scripts\python -m pip install -r requirements.txt`. Run everything from this folder.

## Current pipeline (v2, live-matched) - results in results_final.txt
    .venv\Scripts\python segment2.py       # clean + windows (strokes, idle bumps, +-40/80 ms jitter copies, windows at the LIVE detector's peak)
    .venv\Scripts\python features_v2.py    # (only needed for exp2.py experiments)
    .venv\Scripts\python exp3.py 2         # live-matched experiments (leave-one-set-out)
    .venv\Scripts\python final.py          # final evaluation + models/stroke_live{160,320}_seed{0,1,2}.json + _meta.json (exact feature list)
Data: dataset/20261025-162140-re-exported (shadow, no ball) and dataset/20261025-172341 (with ball). The first export of the shadow
session (dataset/20261025-162140, no set_id) is NOT used: the glove restarted during it.
Classes: forehand_drive, backhand_drive, smash, push, none. 'none' = idle bumps >= 0.2 energy from idle sets; the live detector's extra
triggers inside stroke sets are added as 'none' with weight 0.1.
Evaluation is always leave-one-SET-out; never quote a random window split (0.95 vs 0.82).

## Earlier (v1, offline windows, 4 classes): segment.py, features.py, train.py, results.txt
Feature code for the app must match features_live.py exactly (peak fixed at sample 96, window ends post_ms later, box smoothing).
