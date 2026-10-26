import { describe, expect, it } from 'vitest';
import classes from '../config/classes.json';
import detectorJson from '../config/detector.json';
import type { DetectorConfig } from '../src/detector';
import { Recorder, balancedShuffle, missingCalibration, type Hooks, type LinkLike } from '../src/recorder';
import { parseAll } from '../src/csv';
import type { ClassesConfig, SessionRec, StoredPacket } from '../src/types';
import { packetOf } from './helpers';

const cfg = detectorJson as DetectorConfig;
const cal = (over: any = {}) => ({ fw: 'test', build: 'b', boot_id: 5, calibrated: { gyro: true, accel: false, mount: true, open: true, fist: true, force: false }, mount_q_wxyz: [1, 0, 0, 0], gyro_bias_dps: [0, 0, 0], finger_to_channel: [0, 1, 2, 3, 4], ...over });

/** Drives a Recorder with a fake clock and a fake glove that produces packets in step with it. */
class Harness {
  wall = 1_700_000_000_000;
  gloveUs = 5_000_000;
  seq = 0; pkt = 0; streaming = false; beeps = 0;
  stored = new Map<number, StoredPacket>();
  calibration: any = cal();
  strokesAtWall: number[] = [];     // wall times of stroke peaks
  lossFromWall = 0; lossToWall = 0; bootChangeAt = 0; boot = 5;
  link: LinkLike = {
    ready: true,
    startStream: () => { this.streaming = true; },
    stopStream: () => { this.streaming = false; },
    http: async () => ({ ok: true, status: 200, body: this.calibration }),
  };
  hooks: Hooks = { change: () => {}, beep: () => { this.beeps++; }, now: () => this.wall };
  rec = new Recorder(this.link, { putSession: async () => {}, addPackets: async (_s, first, rows) => { rows.forEach((r, i) => this.stored.set(first + i, r)); } }, classes as ClassesConfig, cfg, this.hooks, () => 0.5);

  /** advance 100 ms: 20 IMU samples and 11 ADC conversions, then tick */
  step(): void {
    this.wall += 100;
    if (this.streaming) {
      const imu = [], adc = [];
      for (let k = 0; k < 20; k++) {
        this.gloveUs += 5000;
        const wallAt = this.wall - 100 + (k + 1) * 5;
        let b = 0; for (const c of this.strokesAtWall) b += Math.exp(-(((wallAt - c) / 1000 / 0.04) ** 2));
        imu.push({ tUs: this.gloveUs, seq: this.seq++, raw: [0, 0, 2048, 0, 0, 0], q: [1, 0, 0, 0], accH: [4 * b, 0, 0], gyroH: [900 * b, 0, 0], curl: [0.1, 0.1, 0.1, 0.1, 0.1], pressure: 0 });
      }
      for (let k = 0; k < 11; k++) adc.push({ tUs: this.gloveUs - k * 1000, seq: this.pkt * 11 + k, channel: k % 5, raw: 6000 + ((this.wall + k * 7) % 17) * 3 });
      const dropIt = this.lossFromWall && this.wall >= this.lossFromWall && this.wall < this.lossToWall;
      const boot = this.bootChangeAt && this.wall >= this.bootChangeAt ? 9 : this.boot;
      if (!dropIt) this.rec.handlePacket(packetOf(imu, adc, this.pkt, boot), this.wall);
      this.pkt++;
    }
    this.rec.tick();
  }
  async until(cond: () => boolean, maxSteps = 4000): Promise<void> {
    for (let i = 0; i < maxSteps && !cond(); i++) { this.step(); if (i % 5 === 0) await Promise.resolve(); }
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
  strokes(count: number, startAfterMs: number, everyMs: number): void { this.strokesAtWall = Array.from({ length: count }, (_, i) => this.wall + startAfterMs + i * everyMs); }
  async newSession(): Promise<SessionRec> {
    return this.rec.startSession({ hand: 'left', withBall: true, gripNotes: '', notes: '', holdout: false, host: 'x' });
  }
}

describe('calibration gate', () => {
  it('lists missing steps', () => {
    expect(missingCalibration(cal())).toEqual([]);
    expect(missingCalibration(cal({ calibrated: { gyro: true, open: true, mount: false, fist: false } }))).toEqual(['fingers up (step 2)', 'fist (step 3)']);
  });
  it('blocks a set until the glove is calibrated', async () => {
    const h = new Harness(); h.calibration = cal({ calibrated: { gyro: true, open: true, mount: false, fist: true } });
    await h.newSession();
    await expect(h.rec.startSet({ kind: 'stroke', label: 'push', subLabel: '', expectedN: 5, tempo: 'off' })).rejects.toThrow(/fingers up/);
    expect(h.streaming).toBe(false);
  });
});

describe('stroke set', () => {
  it('counts down, records, detects, auto-ends when the expected count is reached and the hand is still', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'stroke', label: 'forehand_drive', subLabel: '', expectedN: 5, tempo: 'slow' });
    expect(h.streaming).toBe(true); expect(h.rec.active?.phase).toBe('countdown');
    h.strokes(5, 5200, 1200);
    await h.until(() => h.rec.active?.phase === 'recording');
    expect(h.rec.active?.phase).toBe('recording');
    await h.until(() => !h.rec.active);
    expect(h.streaming).toBe(false);
    const set = s.sets[0];
    expect(set.status).toBe('ok'); expect(set.detectedN).toBe(5); expect(set.note).toBe('expected count reached');
    expect(s.events.filter((e) => e.status === 'ok' && e.label === 'forehand_drive').length).toBe(5);
    expect(set.tEndUs).toBeGreaterThan(set.tStartUs);
    expect(set.flags.filter((f) => f.severity === 'red')).toEqual([]);
    expect(h.beeps).toBeGreaterThan(3);
    // the stored packets cover the set, are contiguous, and parse back to the records the glove sent
    expect(set.packetFirst).toBe(0); expect(h.stored.size).toBe(set.packetLast + 1); expect(s.packetCount).toBe(h.stored.size);
    expect(parseAll([...h.stored.values()]).imu.length).toBeGreaterThan(600);
  });
  it('flags a count mismatch and waits for a decision', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'stroke', label: 'push', subLabel: '', expectedN: 6, tempo: 'off' });
    h.strokes(5, 5200, 1200);
    await h.until(() => h.rec.active?.phase === 'recording');
    await h.until(() => h.wall - h.strokesAtWall[4] > 4000); // all five done, still short of six
    h.rec.endSet();
    await h.until(() => !h.rec.active);
    expect(s.sets[0].status).toBe('pending'); expect(s.sets[0].flags.map((f) => f.code)).toContain('count_mismatch');
    await h.rec.resolveSet(s.sets[0].id, true);
    expect(s.sets[0].status).toBe('ok');
  });
  it('Backspace discards: events deleted, status discarded', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'stroke', label: 'push', subLabel: '', expectedN: 5, tempo: 'off' });
    h.strokes(5, 5200, 1000);
    await h.until(() => h.rec.active?.phase === 'recording');
    await h.until(() => h.wall > h.strokesAtWall[2]);
    h.rec.discardActive();
    await h.until(() => !h.rec.active);
    expect(s.sets[0].status).toBe('discarded');
    expect(s.events.every((e) => e.status === 'deleted')).toBe(true);
  });
  it('cancels during the countdown without leaving a set', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'stroke', label: 'push', subLabel: '', expectedN: 5, tempo: 'off' });
    h.rec.endSet();
    expect(h.rec.active).toBeNull(); expect(s.sets.length).toBe(0); expect(h.streaming).toBe(false);
  });
});

describe('quality gate', () => {
  it('a long data hole is red: the set is pending, and keeping it records the flag', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'stroke', label: 'push', subLabel: '', expectedN: 4, tempo: 'off' });
    h.strokes(4, 5200, 1500);
    await h.until(() => h.rec.active?.phase === 'recording');
    h.lossFromWall = h.wall + 1500; h.lossToWall = h.wall + 2500; // 1 s with no packets at all (it swallows a stroke)
    await h.until(() => h.wall - h.strokesAtWall[3] > 3000);
    h.rec.endSet();
    await h.until(() => !h.rec.active);
    const set = s.sets[0];
    expect(set.flags.map((f) => f.code)).toContain('gap');
    expect(set.status).toBe('pending');
    await h.rec.resolveSet(set.id, true);
    expect(set.status).toBe('flagged');
  });
  it('a reboot during the set is red', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'idle', label: 'idle', subLabel: 'rest', expectedN: null, tempo: 'off', idleSeconds: 8 });
    await h.until(() => h.rec.active?.phase === 'recording');
    h.bootChangeAt = h.wall + 3000;
    await h.until(() => !h.rec.active);
    expect(s.sets[0].flags.map((f) => f.code)).toContain('reboot');
    expect(s.sets[0].status).toBe('pending');
  });
  it('flags a calibration change since the session started', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'idle', label: 'idle', subLabel: 'rest', expectedN: null, tempo: 'off', idleSeconds: 6 });
    await h.until(() => !h.rec.active);
    expect(s.sets[0].status).toBe('ok');
    h.calibration = cal({ mount_q_wxyz: [0.9, 0.1, 0, 0] });
    await h.rec.startSet({ kind: 'idle', label: 'idle', subLabel: 'rest', expectedN: null, tempo: 'off', idleSeconds: 6 });
    await h.until(() => !h.rec.active);
    expect(s.sets[1].flags.map((f) => f.code)).toContain('calibration_changed');
  });
});

describe('idle and cue sets', () => {
  it('an idle set ends after its duration and creates no events', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'idle', label: 'idle', subLabel: 'walking', expectedN: null, tempo: 'off', idleSeconds: 10 });
    await h.until(() => !h.rec.active);
    const set = s.sets[0];
    expect(set.kind).toBe('idle'); expect(set.subLabel).toBe('walking'); expect(set.status).toBe('ok'); expect(s.events.length).toBe(0);
    expect((set.tEndUs - set.tStartUs) / 1e6).toBeGreaterThan(9.5);
  });
  it('mixed cues: labels are assigned in cue order', async () => {
    const h = new Harness(); const s = await h.newSession();
    await h.rec.startSet({ kind: 'cue', label: 'mixed', subLabel: '', expectedN: null, tempo: 'off', cueCount: 4 });
    let lastCue = -1; const fired: number[] = [];
    await h.until(() => {
      const a = h.rec.active; if (!a) return true;
      if (a.phase === 'recording' && a.cueIdx !== lastCue) { lastCue = a.cueIdx; fired.push(h.wall + 700); h.strokesAtWall = [...fired]; } // a stroke 700 ms after each cue
      return false;
    });
    const set = s.sets[0];
    expect(set.label).toBe('mixed'); expect(set.cues?.length).toBe(4);
    expect(s.events.map((e) => e.label)).toEqual(set.cues);
    expect(set.status).toBe('ok');
  });
  it('balancedShuffle spreads labels evenly', () => {
    const r = balancedShuffle(['a', 'b', 'c', 'd'], 12, Math.random);
    for (const l of ['a', 'b', 'c', 'd']) expect(r.filter((x) => x === l).length).toBe(3);
  });
});
