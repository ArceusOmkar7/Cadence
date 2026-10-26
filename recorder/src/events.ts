// Event bookkeeping shared by the live recorder and the review screen (pure, no DOM).
import { detectAll, energyTrace, type DetectorConfig } from './detector';
import type { ImuRec } from './protocol';
import type { EventRec, SessionRec, SetRec } from './types';

/** Short tag stored with every event: detector version plus a hash of its parameters, so re-tuned runs are distinguishable. */
export function detectorTag(cfg: DetectorConfig): string {
  const s = JSON.stringify([cfg.smoothingMs, cfg.gyroScaleDps, cfg.accelScaleG, cfg.highThreshold, cfg.endFraction, cfg.maxAfterPeakMs, cfg.refractoryMs, cfg.maxDtMs, cfg.recoveryMs, cfg.recoveryRatio, cfg.recoveryCos]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${cfg.version}-${h.toString(16).padStart(8, '0').slice(0, 6)}`;
}

export function nextEventId(session: SessionRec, setId: string): string {
  const n = session.events.filter((e) => e.setId === setId).length;
  let id = `${setId}-e${n + 1}`;
  while (session.events.some((e) => e.id === id)) id += 'x';
  return id;
}

/** Labels for the events of a set: the set's label, or for a mixed-cue set the cued labels in order. */
export function labelEvents(set: SetRec, count: number): { labels: string[]; ordered: boolean } {
  if (set.kind !== 'cue' || !set.cues) return { labels: Array(count).fill(set.label), ordered: true };
  const ok = count === set.cues.length;
  return { labels: Array.from({ length: count }, (_, i) => set.cues![i] ?? 'unknown'), ordered: ok };
}

/** Replaces the automatic events of a set by a fresh run of the detector over its samples. Manual events and the
 *  status the user gave to them are kept. */
export function rerunDetector(session: SessionRec, set: SetRec, imu: ImuRec[], cfg: DetectorConfig): void {
  const inSet = imu.filter((r) => r.tUs >= set.tStartUs - 1_000_000 && r.tUs <= set.tEndUs);
  const found = detectAll(cfg, inSet).filter((e) => e.tPeakUs >= set.tStartUs && e.tPeakUs <= set.tEndUs);
  session.events = session.events.filter((e) => !(e.setId === set.id && e.source === 'auto'));
  const manual = session.events.filter((e) => e.setId === set.id && e.status !== 'deleted').length;
  const { labels, ordered } = labelEvents(set, found.length + manual);
  const tag = detectorTag(cfg);
  // a cue set whose event count does not match its cues cannot be labelled by order, so its events stay ambiguous
  found.forEach((e, i) => session.events.push({ id: nextEventId(session, set.id), setId: set.id, label: labels[i], tPeakUs: e.tPeakUs, source: 'auto', status: set.kind === 'cue' && !ordered ? 'ambiguous' : 'ok', peakEnergy: e.peakEnergy, detectorVersion: tag }));
  refreshSetFlags(session, set);
}

/** Recomputes detectedN and the flags that depend on the events (count mismatch, idle triggers) after any edit. */
export function refreshSetFlags(session: SessionRec, set: SetRec): void {
  const n = session.events.filter((e) => e.setId === set.id && e.status !== 'deleted').length;
  set.detectedN = n;
  set.flags = set.flags.filter((f) => !['count_mismatch', 'idle_triggers'].includes(f.code));
  if (set.kind === 'idle' && n) set.flags.push({ code: 'idle_triggers', severity: 'amber', detail: `${n} stroke-like movements during an idle set` });
  if (set.kind === 'stroke' && set.expectedN !== null && n !== set.expectedN) set.flags.push({ code: 'count_mismatch', severity: 'amber', detail: `detected ${n}, expected ${set.expectedN}` });
  if (set.kind === 'cue' && set.cues && n !== set.cues.length) set.flags.push({ code: 'count_mismatch', severity: 'amber', detail: `${n} events for ${set.cues.length} cues: labels cannot be matched in order` });
}

/** Cuts an idle set short: everything from marginUs before the given time onwards is no longer part of the set (the recording
 *  itself is kept). Used when a stroke or a reach for the keyboard sits at the end of what was meant to be rest. */
export function trimSetBefore(session: SessionRec, set: SetRec, tUs: number, marginUs = 1_000_000): void {
  const end = Math.max(set.tStartUs, tUs - marginUs);
  set.tEndUs = end;
  for (const e of session.events) if (e.setId === set.id && e.tPeakUs >= end) e.status = 'deleted';
  set.note = (set.note ? set.note + '; ' : '') + 'trimmed';
  refreshSetFlags(session, set);
}

/** Time of the local energy maximum within +-window of a clicked time (so a manual event lands on the stroke's peak). */
export function snapToPeak(cfg: DetectorConfig, imu: ImuRec[], tUs: number, windowMs = 80): number {
  const near = imu.filter((r) => Math.abs(r.tUs - tUs) <= windowMs * 1000);
  if (near.length < 3) return tUs;
  const tr = energyTrace({ ...cfg }, imu.filter((r) => Math.abs(r.tUs - tUs) <= (windowMs + 400) * 1000));
  let best = tr.find((x) => Math.abs(x.tUs - tUs) <= windowMs * 1000) ?? tr[0];
  for (const x of tr) if (Math.abs(x.tUs - tUs) <= windowMs * 1000 && x.e > best.e) best = x;
  return best.tUs;
}

export function addManualEvent(session: SessionRec, set: SetRec, tPeakUs: number, peakEnergy: number, cfg: DetectorConfig, label?: string): EventRec {
  const ev: EventRec = { id: nextEventId(session, set.id), setId: set.id, label: label ?? (set.kind === 'cue' ? 'unknown' : set.label), tPeakUs, source: 'manual', status: 'ok', peakEnergy, detectorVersion: detectorTag(cfg) };
  session.events.push(ev);
  refreshSetFlags(session, set);
  return ev;
}
