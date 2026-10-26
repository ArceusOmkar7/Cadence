"""Loading of recorder sessions and a Python port of the recorder's causal stroke detector (recorder/src/detector.ts, v3)."""
import json, numpy as np, pandas as pd
from pathlib import Path

DATASET = Path(__file__).resolve().parent.parent / "dataset"
DET = dict(smoothingMs=50, gyroScaleDps=500, accelScaleG=2, highThreshold=0.35, endFraction=0.5, maxAfterPeakMs=120,
           refractoryMs=400, maxDtMs=50, recoveryMs=900, recoveryRatio=0.5, recoveryCos=-0.3)
CURL = ["curl_thumb", "curl_index", "curl_middle", "curl_ring", "curl_little"]
ACC = ["acc_x_g", "acc_y_g", "acc_z_g"]; GYR = ["gyro_x_dps", "gyro_y_dps", "gyro_z_dps"]


def cosine(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return 1.0 if na < 1e-6 or nb < 1e-6 else float(a @ b / (na * nb))


def detect(t_us, gyro, acc, c=DET, threshold=None):
    """Same state machine as the recorder. Returns [(index_of_peak, peak_energy)]."""
    thr = c["highThreshold"] if threshold is None else threshold
    e = np.hypot(np.linalg.norm(gyro, axis=1) / c["gyroScaleDps"], np.linalg.norm(acc, axis=1) / c["accelScaleG"])
    out = []; energy = e[0]; sg = gyro[0].copy(); state = 0; maxE = 0; iMax = 0; peakG = sg.copy()
    lastPeak = -1e18; lastEv = -1e18; lastE = 0; lastG = np.zeros(3)
    for i in range(len(t_us)):
        if i:
            dt = min(max(0, (t_us[i] - t_us[i - 1]) / 1000), c["maxDtMs"]); k = 1 - np.exp(-dt / c["smoothingMs"])
            energy += k * (e[i] - energy); sg += k * (gyro[i] - sg)
        s = energy
        if state == 0:
            if s > thr and t_us[i] - lastPeak >= c["refractoryMs"] * 1000:
                state = 1; maxE = s; iMax = i; peakG = sg.copy()
            continue
        if s > maxE: maxE = s; iMax = i; peakG = sg.copy()
        if s <= c["endFraction"] * maxE or t_us[i] - t_us[iMax] >= c["maxAfterPeakMs"] * 1000:
            state = 0; lastPeak = t_us[iMax]
            if t_us[iMax] - lastEv < c["recoveryMs"] * 1000 and (maxE < c["recoveryRatio"] * lastE or cosine(peakG, lastG) < c["recoveryCos"]):
                continue
            lastEv = t_us[iMax]; lastE = maxE; lastG = peakG.copy(); out.append((iMax, maxE))
    return out


def load_session(name):
    p = DATASET / name
    meta = json.loads((p / "meta.json").read_text())
    sets = pd.read_csv(p / "sets.csv"); der = pd.read_csv(p / "derived.csv"); mot = pd.read_csv(p / "motion.csv")
    ana = pd.read_csv(p / "analog.csv"); ev = pd.read_csv(p / "events.csv")
    return meta, sets, mot, der, ana, ev
