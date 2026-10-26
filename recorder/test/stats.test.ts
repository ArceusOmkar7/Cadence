import { describe, expect, it } from 'vitest';
import classes from '../config/classes.json';
import detectorJson from '../config/detector.json';
import { addManualEvent, detectorTag, rerunDetector, snapToPeak } from '../src/events';
import { computeStats } from '../src/stats';
import type { DetectorConfig } from '../src/detector';
import type { ClassesConfig, SessionRec, SetRec } from '../src/types';
import { makeImuStream } from './helpers';

const cfg = detectorJson as DetectorConfig;
const cls = classes as ClassesConfig;
const set = (o: Partial<SetRec>): SetRec => ({ id: 's', kind: 'stroke', label: 'smash', subLabel: '', expectedN: 5, tStartUs: 1_000_000, tEndUs: 9_000_000, tempo: 'off', status: 'ok', flags: [], packetFirst: 0, packetLast: 0, detectedN: 0, note: '', ...o });
const session = (id: string, day: string, over: Partial<SessionRec> = {}): SessionRec => ({ id, startedAt: `2026-01-${day}T10:00:00Z`, hand: 'left', withBall: true, gripNotes: '', notes: '', holdout: false, glove: { host: '', fw: '', build: '', bootId: 0 }, calibrationStart: {}, calibrationEnd: null, detector: cfg, classesVersion: 1, sets: [], events: [], packetCount: 0, ...over });
const ev = (setId: string, label: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${setId}-${label}-${i}`, setId, label, tPeakUs: i, source: 'auto' as const, status: 'ok' as const, peakEnergy: 1, detectorVersion: '1' }));

describe('dashboard statistics', () => {
  it('counts only ok events of kept sets, splits holdout, sums idle time', () => {
    const a = session('a', '01', { sets: [set({ id: 'a1' }), set({ id: 'a2', status: 'pending' }), set({ id: 'a3', status: 'discarded' }), set({ id: 'a4', kind: 'idle', label: 'idle', tStartUs: 0, tEndUs: 90e6 })], events: [...ev('a1', 'smash', 4), ...ev('a2', 'smash', 9), ...ev('a3', 'smash', 9)] });
    a.events[0].status = 'deleted';
    const h = session('h', '02', { holdout: true, sets: [set({ id: 'h1', label: 'push' })], events: ev('h1', 'push', 3) });
    const st = computeStats([a, h], cls);
    const smash = st.classes.find((c) => c.id === 'smash')!;
    expect(smash.total).toBe(3); expect(smash.train).toBe(3);
    expect(st.classes.find((c) => c.id === 'push')).toMatchObject({ total: 3, holdout: 3, train: 0 });
    expect(st.idleMinutes).toBeCloseTo(1.5);
  });
  it('warns when one session holds more than 40% of a class', () => {
    const big = session('big', '01', { sets: [set({ id: 'b1' })], events: ev('b1', 'smash', 30) });
    const small = session('small', '03', { sets: [set({ id: 's1' })], events: ev('s1', 'smash', 10) });
    expect(computeStats([big, small], cls).warnings.join(' ')).toMatch(/smash: session big holds 75%/);
    expect(computeStats([small, session('s2', '04', { sets: [set({ id: 'x' })], events: ev('x', 'smash', 12) }), session('s3', '05', { sets: [set({ id: 'y' })], events: ev('y', 'smash', 11) })], cls).warnings.filter((w) => w.startsWith('smash'))).toEqual([]);
  });
});

describe('event editing', () => {
  const imu = makeImuStream({ seconds: 10, strokesAtS: [2, 4, 6, 8] });
  it('re-running the detector replaces auto events and keeps manual ones; the tag changes with the parameters', () => {
    const s = session('x', '01'), st = set({ id: 'x1', tStartUs: 1_500_000, tEndUs: 9_500_000 });
    s.sets.push(st);
    rerunDetector(s, st, imu, cfg);
    expect(s.events.length).toBe(4); expect(st.detectedN).toBe(4);
    addManualEvent(s, st, 5_000_000, 0.9, cfg);
    rerunDetector(s, st, imu, { ...cfg, highThreshold: 5 }); // so strict nothing is found
    expect(s.events.map((e) => e.source)).toEqual(['manual']);
    expect(detectorTag(cfg)).not.toBe(detectorTag({ ...cfg, highThreshold: 0.5 }));
  });
  it('a manual event snaps to the energy maximum near the click', () => {
    const t = snapToPeak(cfg, imu, 4_000_000 + 1_000_000 + 40_000); // click 40 ms after the true peak at 4 s
    expect(Math.abs(t - 5_000_000)).toBeLessThan(45_000);
  });
});
