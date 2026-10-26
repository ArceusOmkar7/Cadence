# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person, who builds and wears the glove: a right-handed shakehand table-tennis player and the developer of the whole system (ESP8266 glove, firmware, recorder, model). Two situations: (1) at a desk, recording labelled strokes and reviewing data; (2) standing at or next to the table, glancing at a screen 1-2 m away while playing, to see what the model thinks each stroke was. Laptop first; the same screen must work at phone width. Network is a phone hotspot; the glove streams UDP to a local relay on the laptop that serves this app at http://localhost:8787.

## Product Purpose

Glove recorder: records raw glove sensor streams with labelled sets, detects stroke events, reviews and exports session folders (the Train side). The Use side runs the trained XGBoost stroke classifier live on the same stream and tells the player which stroke they just played, so the model can be tested in real play and corrected. Success: the player can trust at a glance what the app says, and can see when it should not be trusted.

## Positioning

The classifier is the player's own: trained on their data from their glove, so the app always shows what the model is unsure about and how it was measured, rather than presenting a verdict as fact.

## Operating Context

- Strokes: forehand_drive, backhand_drive, smash, push, plus none (non-stroke movement the detector fired on).
- A causal energy detector (recorder/src/detector.ts, config/detector.json v3) fires per stroke candidate; the model classifies a fixed window around the detector's peak (peak at sample 96, ends 160 ms or 320 ms later). Latency choice: Fast (about 185 ms after the peak, measured leave-one-set-out accuracy about 0.78) or Accurate (about 345 ms, about 0.81); the difference is inside the measurement noise (n=169 windows, 19 sets, 95% interval about 0.67-0.91).
- Known weak spots from the evaluation: smash is confused with forehand (all shadow-play smashes; only 5 with-ball smash windows exist), absolute hand pitch carries much of the signal (grip habit), idle-reach motions can be called backhand. The model has been tested only on this one player and two sessions.
- Models and their exact feature list are in ml/models/*.json and *_meta.json; features are defined in ml/features_live.py and must be reproduced exactly in the browser.

## Capabilities and Constraints

- Stack: existing TypeScript + Vite app, DOM built with a small el() helper, IndexedDB storage, Three.js hand view, WebSocket to the local relay. No framework to introduce.
- Use section requested features: latest stroke with confidence and an "unsure" state, session tally and a timeline of recent strokes, per-stroke intensity relative to the player's own recent strokes, drill mode (pick a target stroke, each stroke scored match / wrong stroke / unsure with a hit rate), a Fast/Accurate toggle.
- Train section = the existing screens (session, record, review, dashboard, settings), unchanged in behaviour.
- Not requested now: saving corrections for retraining (declined this round).
- Terminology: "set", "session", "event", "window", "detector", "none".

## Brand Commitments

None stated. The existing app has a plain light slate-blue look; the Use screen is an extension of it.

## Evidence on Hand

- ml/results_final.txt: leave-one-set-out results, confusion matrix, confidence cut-off table (answering only at max-probability >= 0.7 answered 70% of triggers at about 0.84 accuracy).
- No testimonials or other users exist. Do not present accuracy as better than measured.

## Product Principles

- Show uncertainty: an "unsure" answer beats a confident wrong one.
- Legible from 2 m while playing: one answer, large, no reading required.
- The same measurement everywhere: the browser must compute exactly what the training code computed.
- Honest about evidence: state what the accuracy numbers are and how they were obtained.
- Train and Use share one app and one glove connection; switching between them never loses the stream.

## Accessibility & Inclusion

Colour never carries the stroke identity alone (labels and shapes always accompany it); contrast high enough to read at distance in a bright hall; no reliance on sound alone.
