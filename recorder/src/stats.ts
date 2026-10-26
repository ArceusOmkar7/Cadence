// Dashboard numbers across sessions (pure).
import type { ClassesConfig, SessionRec } from './types';

export interface ClassStat {
  id: string;
  total: number;
  train: number;
  holdout: number;
  bySession: Record<string, number>;
}
export interface Stats {
  classes: ClassStat[];
  idleMinutes: number;
  warnings: string[];
}

/** A valid event is an 'ok' event of a set the user kept ('ok' or 'flagged-and-kept'), never a discarded or pending one. */
export function computeStats(sessions: SessionRec[], cfg: ClassesConfig): Stats {
  const classes: ClassStat[] = cfg.strokes.map((c) => ({ id: c.id, total: 0, train: 0, holdout: 0, bySession: {} }));
  const byId = new Map(classes.map((c) => [c.id, c]));
  let idleUs = 0;
  for (const s of sessions) {
    const kept = new Set(s.sets.filter((x) => x.status === 'ok' || x.status === 'flagged').map((x) => x.id));
    for (const e of s.events) {
      if (e.status !== 'ok' || !kept.has(e.setId)) continue;
      const c = byId.get(e.label);
      if (!c) continue;
      c.total++;
      if (s.holdout) c.holdout++; else c.train++;
      c.bySession[s.id] = (c.bySession[s.id] ?? 0) + 1;
    }
    for (const x of s.sets) if (x.kind === 'idle' && (x.status === 'ok' || x.status === 'flagged')) idleUs += Math.max(0, x.tEndUs - x.tStartUs);
  }
  const warnings: string[] = [];
  for (const c of classes) {
    const top = Object.entries(c.bySession).sort((a, b) => b[1] - a[1])[0];
    if (top && c.total >= 30 && top[1] / c.total > cfg.targets.maxSessionShare)
      warnings.push(`${c.id}: session ${top[0]} holds ${Math.round((100 * top[1]) / c.total)}% of the events (limit ${Math.round(cfg.targets.maxSessionShare * 100)}%). Record this class in other sessions.`);
  }
  const days = new Set(sessions.map((s) => s.startedAt.slice(0, 10))).size;
  if (sessions.length >= 3 && days < 3) warnings.push(`All sessions fall on ${days} day(s). Variety across days (and re-wearing the glove) is what generalises.`);
  return { classes, idleMinutes: idleUs / 6e7, warnings };
}

export const PROTOCOL_HINTS = [
  'Aim for 6 or more sessions on different days: take the glove off, put it on again, recalibrate each time.',
  'About 25 strokes per class per session, in sets of 10 to 20.',
  'Vary speed, spin and placement. Include game-tempo sets, and use a real ball whenever you can.',
  'Keep one session aside as a holdout (tick the box when you start it) and do not tune on it.',
];
