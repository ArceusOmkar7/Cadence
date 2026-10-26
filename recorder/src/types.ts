import type { DetectorConfig } from './detector';

export type SetKind = 'stroke' | 'idle' | 'cue';
/** pending: waiting for the user to keep or discard (flagged, or the event count did not match). */
export type SetStatus = 'ok' | 'flagged' | 'discarded' | 'pending';

export interface Flag {
  code: string;
  severity: 'amber' | 'red';
  detail: string;
}

export interface SetRec {
  id: string;
  kind: SetKind;
  /** the class label; for cue sets "mixed" (each event carries its own label) */
  label: string;
  subLabel: string;
  expectedN: number | null;
  /** glove clock, microseconds, unwrapped */
  tStartUs: number;
  tEndUs: number;
  tempo: string;
  status: SetStatus;
  flags: Flag[];
  /** range of stored packet indices (inclusive) holding this set's data */
  packetFirst: number;
  packetLast: number;
  detectedN: number;
  /** cue sets: the cued labels in order */
  cues?: string[];
  note: string;
}

export interface EventRec {
  id: string;
  setId: string;
  label: string;
  tPeakUs: number;
  source: 'auto' | 'manual';
  status: 'ok' | 'ambiguous' | 'deleted';
  peakEnergy: number;
  detectorVersion: string;
}

export interface SessionRec {
  id: string;
  startedAt: string;
  hand: 'left' | 'right';
  withBall: boolean;
  gripNotes: string;
  notes: string;
  holdout: boolean;
  glove: { host: string; fw: string; build: string; bootId: number | null };
  /** GET /api/calibration at session start and at export time */
  calibrationStart: unknown;
  calibrationEnd: unknown | null;
  detector: DetectorConfig;
  classesVersion: number;
  sets: SetRec[];
  events: EventRec[];
  /** number of packets stored for this session */
  packetCount: number;
}

export interface StoredPacket {
  rxMs: number;
  buf: ArrayBuffer;
}

export interface ClassesConfig {
  version: number;
  strokes: { id: string; label: string; key?: string }[];
  idle: { id: string; label: string; subLabels: string[]; defaultSeconds: number };
  targets: { eventsPerClass: number; idleMinutes: number; maxSessionShare: number };
  defaults: {
    expectedReps: number;
    countdownSeconds: number;
    stillSecondsToAutoEnd: number;
    cueCount: number;
    tempos: Record<string, number>;
  };
}
