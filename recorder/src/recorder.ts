// The recording controller: session, set flow (countdown, record, auto-end), live detection, quality, keep/discard.
// No DOM and no globals: the link, storage and clock are injected, so the whole flow is unit-tested with fakes.
import { EventDetector, type DetectedEvent, type DetectorConfig } from './detector';
import { channelFingers, fingerMapOf } from './csv';
import { detectorTag, labelEvents, nextEventId } from './events';
import { parsePacket, type AdcRec, type ImuRec, type PacketHeader } from './protocol';
import { assessSet, isRed } from './quality';
import type { ClassesConfig, EventRec, Flag, SessionRec, SetKind, SetRec, StoredPacket } from './types';

export interface LinkLike {
  ready: boolean;
  startStream(): void;
  stopStream(): void;
  http(path: string, method?: 'GET' | 'POST'): Promise<{ ok: boolean; status: number; body: any }>;
}
export interface Store {
  putSession(s: SessionRec): Promise<unknown>;
  addPackets(sid: string, first: number, rows: StoredPacket[]): Promise<void>;
}
export interface Hooks {
  change(): void;
  beep(freqHz: number, ms: number): void;
  now(): number;
}
export interface SessionForm { hand: 'left' | 'right'; withBall: boolean; gripNotes: string; notes: string; holdout: boolean; host: string }
export interface SetRequest { kind: SetKind; label: string; subLabel: string; expectedN: number | null; tempo: string; idleSeconds?: number; cueCount?: number }

export type Phase = 'countdown' | 'recording' | 'finishing' | 'done';
export interface ActiveSet {
  id: string;
  req: SetRequest;
  phase: Phase;
  t0: number; tRec: number; tFin: number;
  tStartUs: number; tEndUs: number;
  detector: EventDetector;
  events: DetectedEvent[];
  imu: ImuRec[]; adc: AdcRec[]; headers: PacketHeader[];
  packets: StoredPacket[];
  flushed: number; firstIdx: number;
  lastImuUs: number | null;
  lastEventWall: number; lastPacketWall: number; lastFlushWall: number;
  nextBeep: number;
  cues: string[]; cueIdx: number; cueAt: number;
  discard: boolean; endReason: string; calChanged: boolean;
}

/** Calibration steps the glove still needs before recording is allowed. */
export function missingCalibration(cal: any): string[] {
  const c = cal?.calibrated;
  if (!c) return ['calibration status unavailable'];
  const m: string[] = [];
  if (!c.gyro || !c.open) m.push('flat hand (step 1)');
  if (!c.mount) m.push('fingers up (step 2)');
  if (!c.fist) m.push('fist (step 3)');
  return m;
}
/** Everything that changes the derived signals: if it differs between two readings the calibration was redone. */
export function calibrationSignature(cal: any): string {
  return JSON.stringify([cal?.mount_q_wxyz, cal?.gyro_bias_dps, cal?.acc_offset_g, cal?.acc_scale, cal?.open_ohm_by_channel, cal?.fist_ohm_by_channel, cal?.force_full_v, cal?.finger_to_channel]);
}

/** A shuffled list with the labels as evenly spread as possible. */
export function balancedShuffle(labels: string[], count: number, rand: () => number = Math.random): string[] {
  const out: string[] = [];
  while (out.length < count) out.push(...labels);
  out.length = count;
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export class Recorder {
  session: SessionRec | null = null;
  active: ActiveSet | null = null;
  calibration: any = null;
  lastError = '';
  badPackets = 0;
  live = { q: [1, 0, 0, 0], curl: [0, 0, 0, 0, 0], pressure: 0, energy: 0, lastAt: 0 };
  private calSig = '';
  private lastBoot: number | null = null; // glove run of the previous set

  constructor(
    private link: LinkLike,
    private store: Store,
    readonly classes: ClassesConfig,
    public detectorCfg: DetectorConfig,
    private hooks: Hooks,
    private rand: () => number = Math.random,
  ) {}

  // ---------------------------------------------------------------- session
  async startSession(form: SessionForm): Promise<SessionRec> {
    const r = await this.link.http('/api/calibration');
    if (!r.ok) throw new Error('Cannot read the glove calibration. Is the glove connected?');
    const d = new Date(this.hooks.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    const id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    this.calibration = r.body; this.calSig = calibrationSignature(r.body);
    this.session = {
      id, startedAt: d.toISOString(), hand: form.hand, withBall: form.withBall, gripNotes: form.gripNotes, notes: form.notes, holdout: form.holdout,
      glove: { host: form.host, fw: String(r.body.fw ?? ''), build: String(r.body.build ?? ''), bootId: r.body.boot_id ?? null },
      calibrationStart: r.body, calibrationEnd: null, detector: this.detectorCfg, classesVersion: this.classes.version, sets: [], events: [], packetCount: 0,
    };
    await this.store.putSession(this.session);
    this.hooks.change();
    return this.session;
  }

  openSession(s: SessionRec): void { this.session = s; this.calSig = calibrationSignature(s.calibrationStart); this.hooks.change(); }

  /** Re-reads the calibration; returns what is still missing and whether it differs from the session's start. */
  async refreshCalibration(): Promise<{ missing: string[]; changed: boolean }> {
    const r = await this.link.http('/api/calibration');
    if (!r.ok) return { missing: ['calibration status unavailable'], changed: false };
    this.calibration = r.body;
    const sig = calibrationSignature(r.body), s = this.session;
    if (s && !s.sets.length) { s.calibrationStart = r.body; this.calSig = sig; } // nothing recorded yet: the snapshot follows the calibration
    return { missing: missingCalibration(r.body), changed: sig !== this.calSig };
  }

  async endSession(): Promise<void> {
    const s = this.session; if (!s) return;
    const r = await this.link.http('/api/calibration');
    if (r.ok) s.calibrationEnd = r.body;
    await this.store.putSession(s);
  }

  // ---------------------------------------------------------------- set flow
  async startSet(req: SetRequest): Promise<void> {
    const s = this.session;
    if (!s) throw new Error('Start a session first.');
    if (this.active) throw new Error('A set is already running.');
    if (!this.link.ready) throw new Error('The glove is not connected.');
    const { missing, changed } = await this.refreshCalibration();
    if (missing.length) throw new Error('Calibrate first: ' + missing.join(', ') + '.');
    const now = this.hooks.now();
    const n = s.sets.length + 1;
    const cues = req.kind === 'cue' ? balancedShuffle(this.classes.strokes.map((c) => c.id), req.cueCount ?? this.classes.defaults.cueCount, this.rand) : [];
    this.active = {
      id: `${s.id}-s${n}`, req, phase: 'countdown', t0: now, tRec: 0, tFin: 0, tStartUs: 0, tEndUs: 0,
      detector: new EventDetector(this.detectorCfg), events: [], imu: [], adc: [], headers: [], packets: [], flushed: 0, firstIdx: s.packetCount,
      lastImuUs: null, lastEventWall: 0, lastPacketWall: 0, lastFlushWall: now, nextBeep: 0, cues, cueIdx: -1, cueAt: 0, discard: false, endReason: '', calChanged: changed,
    };
    this.lastError = '';
    this.link.startStream();
    this.hooks.change();
  }

  /** The set's label for the UI: the current cue in a mixed set. */
  get currentCue(): string | null {
    const a = this.active; return a && a.phase === 'recording' && a.cueIdx >= 0 ? a.cues[a.cueIdx] : null;
  }

  handlePacket(buf: ArrayBuffer, rxMs: number): void {
    const a = this.active;
    if (!a || a.phase === 'done') return;
    if (a.phase === 'finishing' && this.hooks.now() - a.tFin > 1500) return;
    let p;
    try { p = parsePacket(buf); } catch { this.badPackets++; return; }
    const now = this.hooks.now();
    a.packets.push({ rxMs, buf });
    a.headers.push(p.header);
    a.lastPacketWall = now;
    const recording = a.phase === 'recording' || a.phase === 'finishing';
    for (const r of p.imu) {
      a.lastImuUs = r.tUs;
      const ev = a.detector.push(r.tUs, r.gyroH, r.accH);
      this.live = { q: r.q, curl: r.curl, pressure: r.pressure, energy: a.detector.energy, lastAt: now };
      if (!recording) continue;
      a.imu.push(r);
      if (ev && ev.tPeakUs >= a.tStartUs) { a.events.push(ev); a.lastEventWall = now; }
    }
    if (recording) for (const r of p.adc) a.adc.push(r);
  }

  /** Call about every 100 ms. */
  tick(): void {
    const a = this.active;
    if (!a) return;
    const now = this.hooks.now(), cfg = this.classes.defaults;
    if (now - a.lastFlushWall >= 1000) void this.flush(a, now);
    if (a.phase === 'countdown') {
      if (now - a.t0 >= cfg.countdownSeconds * 1000 && a.lastImuUs !== null) {
        a.phase = 'recording'; a.tRec = now; a.tStartUs = a.lastImuUs; a.nextBeep = now + 1000; a.lastEventWall = now;
        a.cueAt = now + 1500; this.hooks.beep(880, 250); this.hooks.change();
      } else if (now - a.t0 > cfg.countdownSeconds * 1000 + 3000 && a.lastImuUs === null) {
        this.lastError = 'No data arrived from the glove.';
        this.link.stopStream(); this.active = null; this.hooks.change();
      }
      return;
    }
    if (a.phase === 'recording') {
      const t = this.tempoSeconds(a);
      if (t > 0 && a.req.kind === 'stroke' && now >= a.nextBeep) { this.hooks.beep(660, 60); a.nextBeep += t * 1000; }
      if (a.req.kind === 'cue') this.advanceCues(a, now);
      const reason = this.autoEndReason(a, now);
      if (reason) this.endSet(reason);
      return;
    }
    if (a.phase === 'finishing' && now - a.tFin >= 400) void this.finalize(a);
  }

  private tempoSeconds(a: ActiveSet): number { return this.classes.defaults.tempos[a.req.tempo] ?? 0; }

  private advanceCues(a: ActiveSet, now: number): void {
    if (now < a.cueAt || a.cueIdx >= a.cues.length - 1) return;
    a.cueIdx++;
    this.hooks.beep(990, 120);
    a.cueAt = now + 2200 + this.rand() * 1400;
    this.hooks.change();
  }

  private autoEndReason(a: ActiveSet, now: number): string {
    const c = this.classes.defaults;
    if (now - a.lastPacketWall > 5000) return 'no data from the glove';
    if (a.req.kind === 'idle') return now - a.tRec >= (a.req.idleSeconds ?? this.classes.idle.defaultSeconds) * 1000 ? 'duration reached' : '';
    if (a.req.kind === 'cue') return a.cueIdx >= a.cues.length - 1 && now >= a.cueAt ? 'all cues done' : ''; // one more interval after the last cue
    if (a.req.expectedN !== null && a.events.length >= a.req.expectedN && now - a.lastEventWall >= c.stillSecondsToAutoEnd * 1000 && a.detector.energy < this.detectorCfg.highThreshold * 0.5) return 'expected count reached';
    return now - a.tRec > 10 * 60_000 ? 'time limit' : '';
  }

  /** Ends the set (the user pressed Space, or an automatic condition). During the countdown it cancels. */
  endSet(reason = 'user'): void {
    const a = this.active;
    if (!a) return;
    if (a.phase === 'countdown') { this.link.stopStream(); this.active = null; this.hooks.change(); return; }
    if (a.phase !== 'recording') return;
    a.phase = 'finishing'; a.tFin = this.hooks.now(); a.endReason = reason; a.tEndUs = a.lastImuUs ?? a.tStartUs;
    this.link.stopStream(); this.hooks.change();
  }

  /** Backspace: end the set and mark it discarded (the data stays stored but is excluded from exports). */
  discardActive(): void {
    const a = this.active; if (!a) return;
    if (a.phase === 'countdown') { this.endSet(); return; }
    a.discard = true; this.endSet('discarded by user');
  }

  private async flush(a: ActiveSet, now: number): Promise<void> {
    a.lastFlushWall = now;
    const s = this.session; if (!s || a.flushed >= a.packets.length) return;
    const rows = a.packets.slice(a.flushed), first = a.firstIdx + a.flushed;
    a.flushed = a.packets.length;
    try { await this.store.addPackets(s.id, first, rows); } catch (e) { a.flushed -= rows.length; this.lastError = 'Saving to the browser database failed: ' + String(e); }
  }

  private async finalize(a: ActiveSet): Promise<void> {
    if (a.phase === 'done') return;
    a.phase = 'done';
    const s = this.session!;
    await this.flush(a, this.hooks.now());
    const names = channelFingers(fingerMapOf(this.calibration)).slice(0, 5);
    const flags: Flag[] = a.discard ? [] : assessSet({ kind: a.req.kind, imu: a.imu, adc: a.adc, headers: a.headers, channelNames: names });
    const boot = a.headers[0]?.bootId;
    if (!a.discard && boot !== undefined && this.lastBoot !== null && boot !== this.lastBoot)
      flags.push({ code: 'glove_restarted', severity: 'amber', detail: 'the glove restarted since the previous set (its clock began again from zero; rows are labelled with boot_id)' });
    if (boot !== undefined) this.lastBoot = boot;
    if (a.calChanged && !a.discard) flags.push({ code: 'calibration_changed', severity: 'red', detail: 'the glove calibration changed since the session started' });
    const set: SetRec = {
      id: a.id, kind: a.req.kind, label: a.req.kind === 'cue' ? 'mixed' : a.req.label, subLabel: a.req.subLabel, expectedN: a.req.expectedN,
      tStartUs: a.tStartUs, tEndUs: a.tEndUs, tempo: a.req.tempo, status: 'ok', flags, packetFirst: a.firstIdx, packetLast: a.firstIdx + a.packets.length - 1,
      detectedN: a.events.length, cues: a.req.kind === 'cue' ? a.cues.slice(0, Math.max(0, a.cueIdx + 1)) : undefined, note: a.endReason,
    };
    s.packetCount = a.firstIdx + a.packets.length;
    const tag = detectorTag(this.detectorCfg);
    let mismatch = false;
    if (a.req.kind === 'idle') {
      if (a.events.length) flags.push({ code: 'idle_triggers', severity: 'amber', detail: `${a.events.length} stroke-like movements during an idle set (raise the threshold or re-record)` });
    } else {
      const { labels, ordered } = labelEvents(set, a.events.length);
      mismatch = a.req.kind === 'stroke' ? a.req.expectedN !== null && a.events.length !== a.req.expectedN : !ordered;
      if (mismatch) flags.push({ code: 'count_mismatch', severity: 'amber', detail: a.req.kind === 'cue' ? `${a.events.length} events for ${set.cues?.length ?? 0} cues: labels cannot be matched in order` : `detected ${a.events.length}, expected ${a.req.expectedN}` });
      a.events.forEach((e, i) => {
        const rec: EventRec = { id: nextEventId(s, set.id), setId: set.id, label: labels[i], tPeakUs: e.tPeakUs, source: 'auto', status: a.req.kind === 'cue' && !ordered ? 'ambiguous' : 'ok', peakEnergy: e.peakEnergy, detectorVersion: tag };
        s.events.push(rec);
      });
    }
    set.status = a.discard ? 'discarded' : isRed(flags) || mismatch ? 'pending' : 'ok';
    if (a.discard) s.events.filter((e) => e.setId === set.id).forEach((e) => (e.status = 'deleted'));
    s.sets.push(set);
    this.active = null;
    try { await this.store.putSession(s); } catch (e) { this.lastError = 'Saving the session failed: ' + String(e); }
    this.hooks.change();
  }

  /** The user's decision for a pending set. */
  async resolveSet(setId: string, keep: boolean): Promise<void> {
    const s = this.session; const set = s?.sets.find((x) => x.id === setId);
    if (!s || !set) return;
    if (keep) set.status = isRed(set.flags) ? 'flagged' : 'ok';
    else { set.status = 'discarded'; s.events.filter((e) => e.setId === setId).forEach((e) => (e.status = 'deleted')); }
    await this.store.putSession(s);
    this.hooks.change();
  }

  get pendingSets(): SetRec[] { return this.session?.sets.filter((x) => x.status === 'pending') ?? []; }
}
