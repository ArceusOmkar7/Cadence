// The recorder's screens. DOM only: every decision lives in recorder.ts / events.ts / stats.ts.
import classesJson from '../config/classes.json';
import detectorJson from '../config/detector.json';
import { energyTrace, suggestThreshold, type DetectorConfig } from './detector';
import { addManualEvent, refreshSetFlags, rerunDetector, snapToPeak, trimSetBefore } from './events';
import { canWriteFolder, exportToFolder, exportToZip } from './exporter';
import { HandView } from './hand';
import { GloveLink } from './link';
import { parseAll } from './csv';
import type { ImuRec } from './protocol';
import { Recorder, missingCalibration, type SetRequest } from './recorder';
import { el, type Kid } from './dom';
import { UseScreen } from './useScreen';
import { PROTOCOL_HINTS, computeStats } from './stats';
import * as db from './storage';
import type { ClassesConfig, EventRec, SessionRec, SetRec } from './types';

type Screen = 'session' | 'record' | 'review' | 'dashboard' | 'settings';

const classes = classesJson as ClassesConfig;
const baseDetector = detectorJson as DetectorConfig;

const fmt = (n: number, d = 1) => n.toFixed(d);
const strokeKeys = (): { id: string; label: string; key: string }[] => classes.strokes.map((c, i) => ({ id: c.id, label: c.label, key: c.key ?? String(i + 1) }));

interface SetForm { mode: 'stroke' | 'idle' | 'cue'; label: string; n: number; tempo: string; sub: string; idleSeconds: number; cueCount: number }
interface ReviewState { setId: string; imu: ImuRec[]; trace: { tUs: number; e: number }[]; selected: string | null; loading: boolean; playing: boolean; speed: number }

export class App {
  private link = new GloveLink();
  private recorder!: Recorder;
  private hand = new HandView();
  private screen: Screen = 'session';
  private section: 'train' | 'use' = 'train';
  private use!: UseScreen;
  private root: HTMLElement;
  private main = el('main');
  private detectorCfg: DetectorConfig = baseDetector;
  private sessions: SessionRec[] = [];
  private setForm: SetForm = { mode: 'stroke', label: classes.strokes[0].id, n: classes.defaults.expectedReps, tempo: 'off', sub: classes.idle.subLabels[0], idleSeconds: classes.idle.defaultSeconds, cueCount: classes.defaults.cueCount };
  private msg = '';
  private msgBad = false;
  private glove: any = null;       // last status frame from the glove
  private pose: any = null;        // last pose frame (30 Hz, outside of sets)
  private seenResSeq = -1;
  private resText = '';
  private review: ReviewState | null = null;
  private audio: AudioContext | null = null;
  private renderQueued = false;
  private live: { big?: HTMLElement; small?: HTMLElement; bar?: HTMLElement; box?: HTMLElement; meta?: HTMLElement } = {};
  private replayTimer = 0;
  /** Typed values of the form fields, so a re-render (the screen is rebuilt on changes) never wipes what is being typed. */
  private fv: Record<string, string | boolean> = {};
  private relayKey = '';

  private constructor(root: HTMLElement) { this.root = root; }

  static async create(root: HTMLElement): Promise<App> {
    const app = new App(root);
    const saved = await db.getSetting<DetectorConfig>('detector').catch(() => undefined);
    if (saved) app.detectorCfg = { ...baseDetector, ...saved, version: baseDetector.version }; // keep the tuned values; parameters added since fall back to the defaults
    app.recorder = new Recorder(app.link, db, classes, app.detectorCfg, { change: () => app.schedule(), beep: (f, ms) => app.beep(f, ms), now: () => Date.now() });
    app.use = new UseScreen({ link: app.link, hand: app.hand, calibration: () => app.recorder.calibration, refreshCalibration: async () => { await app.recorder.refreshCalibration(); }, recording: () => !!app.recorder.active, gotoTrain: () => app.setSection('train') });
    app.use.setDetector(app.detectorCfg);
    app.link.onPacket = (b, rx) => { app.recorder.handlePacket(b, rx); if (app.section === 'use') app.use.feed(b); };
    app.link.onText = (m) => app.onGloveText(m);
    app.link.onRelay = (r) => {
      const k = `${r?.glove}|${r?.host}|${r?.streaming}`; // not on every 1 s heartbeat
      if (k === app.relayKey) return;
      app.relayKey = k;
      if (app.section === 'use') app.use.ensureStream(true);
      if (r?.host && r.glove === 'open') { app.fv.host = r.host; localStorage.setItem('gloveHost', r.host); } // show the glove the relay is really using
      if (r?.glove === 'open') { if (app.msg.startsWith('Connecting')) app.msg = ''; void app.pollCalibration(); }
      app.schedule();
    };
    app.sessions = await db.listSessions().catch(() => []);
    app.hand.setHanded((localStorage.getItem('hand') as 'left' | 'right') || 'left');
    void db.requestPersistence();
    const host = localStorage.getItem('gloveHost');
    if (host) app.link.connect(host);
    setInterval(() => { app.recorder.tick(); app.updateLive(); if (app.section === 'use') app.use.tick(); }, 100);
    setInterval(() => void app.pollCalibration(), 4000);
    addEventListener('keydown', (e) => app.onKey(e));
    app.mount();
    return app;
  }

  // ---------------------------------------------------------------- plumbing
  private beep(freq: number, ms: number): void {
    try {
      this.audio ??= new AudioContext();
      const o = this.audio.createOscillator(), g = this.audio.createGain();
      o.frequency.value = freq; g.gain.value = 0.15; o.connect(g); g.connect(this.audio.destination);
      o.start(); o.stop(this.audio.currentTime + ms / 1000);
    } catch { /* no audio: the on-screen cues still work */ }
  }
  /** Keeps a form control's value in this.fv across re-renders. */
  private bind<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(key: string, e: T): T {
    const box = e instanceof HTMLInputElement && e.type === 'checkbox';
    if (key in this.fv) { if (box) (e as HTMLInputElement).checked = this.fv[key] as boolean; else e.value = this.fv[key] as string; }
    const save = () => { this.fv[key] = box ? (e as HTMLInputElement).checked : e.value; };
    e.addEventListener('input', save); e.addEventListener('change', save); save();
    return e;
  }
  private schedule(): void { if (this.renderQueued) return; this.renderQueued = true; requestAnimationFrame(() => { this.renderQueued = false; this.render(); }); }
  private say(text: string, bad = false): void { this.msg = text; this.msgBad = bad; this.schedule(); }

  private onGloveText(m: { t: string; [k: string]: any }): void {
    if (m.t === 's') {
      this.glove = m;
      if (this.seenResSeq < 0) this.seenResSeq = m.res.seq;
      else if (m.res.seq !== this.seenResSeq) { this.seenResSeq = m.res.seq; this.resText = (m.res.ok ? 'OK: ' : 'FAILED: ') + m.res.msg; this.schedule(); void this.pollCalibration(); }
      if (m.cap?.stage !== 'none') this.schedule();
    } else if (m.t === 'p') this.pose = m;
  }

  private async pollCalibration(): Promise<void> {
    if (!this.link.ready || (this.section === 'train' && this.screen !== 'session' && this.screen !== 'record') || this.recorder.active) return;
    const before = JSON.stringify(this.recorder.calibration?.calibrated);
    await this.recorder.refreshCalibration();
    if (JSON.stringify(this.recorder.calibration?.calibrated) !== before) this.schedule();
  }

  private updateLive(): void {
    const r = this.recorder, now = Date.now();
    if (r.live.lastAt && now - r.live.lastAt < 400) this.hand.setPose(r.live.q, r.live.curl, r.live.pressure);
    else if (this.pose) { // outside of sets: the glove's 30 Hz pose frames (curl comes by hardware channel)
      const map: number[] = this.glove?.map ?? [0, 1, 2, 3, 4];
      this.hand.setPose(this.pose.q, map.map((ch) => this.pose.c[ch] ?? 0), (this.pose.p ?? 0) * 100);
    }
    if (this.screen === 'record') this.updateBigStatus();
  }

  // ---------------------------------------------------------------- shell
  private mount(): void {
    this.root.replaceChildren(el('div', { class: 'shell' }, this.main));
    this.render();
  }
  private setSection(s: 'train' | 'use'): void {
    if (s === this.section) return;
    if (s === 'use' && this.recorder.active) { this.say('A set is recording. Finish or discard it before opening Use.', true); return; }
    if (this.section === 'use') this.use.deactivate();
    this.section = s; this.msg = '';
    if (s === 'use') this.use.activate();
    this.schedule();
  }
  private go(s: Screen): void { this.screen = s; this.review = this.review && s === 'review' ? this.review : null; this.schedule(); }

  private header(): HTMLElement {
    const r = this.link.relay;
    const state = !r ? 'Recorder service not running (npm start)' : r.glove === 'open' ? 'Glove connected' : r.glove === 'connecting' ? 'Connecting to the glove…' : r.glove === 'closed' ? 'Glove connection lost, retrying' : 'No glove selected';
    const cls = r?.glove === 'open' ? 'ok' : r ? 'warn' : 'bad';
    const tabs: [Screen, string][] = [['session', 'Session'], ['record', 'Record'], ['review', 'Review'], ['dashboard', 'Dashboard'], ['settings', 'Settings']];
    const sec = (s: 'train' | 'use', t: string) => el('button', { class: 'tab sec' + (this.section === s ? ' on' : ''), 'aria-pressed': String(this.section === s), onclick: () => this.setSection(s) }, t);
    return el('header', {},
      el('h1', {}, 'Glove'),
      el('div', { class: 'seg secs', role: 'group', 'aria-label': 'Section' }, sec('train', 'Train'), sec('use', 'Use')),
      this.section === 'train' ? el('nav', {}, ...tabs.map(([s, t]) => el('button', { class: 'tab' + (this.screen === s ? ' on' : ''), onclick: () => this.go(s) }, t))) : null,
      el('div', { class: 'conn ' + cls, role: 'status' }, state, this.recorder.session ? ` · session ${this.recorder.session.id}` : ''),
    );
  }

  private render(): void {
    const kids: Kid[] = [this.header()];
    if (this.msg) kids.push(el('p', { class: 'banner ' + (this.msgBad ? 'bad' : 'info'), role: 'alert' }, this.msg));
    if (this.recorder.lastError) kids.push(el('p', { class: 'banner bad', role: 'alert' }, this.recorder.lastError));
    if (this.section === 'train' && this.recorder.pendingSets.length && this.screen !== 'review') kids.push(el('p', { class: 'banner warn' }, `${this.recorder.pendingSets.length} set(s) need a decision (keep, discard or review): see the list on the Record screen.`));
    this.live = {};
    const body = this.section === 'use' ? this.use.root : { session: () => this.sessionScreen(), record: () => this.recordScreen(), review: () => this.reviewScreen(), dashboard: () => this.dashboardScreen(), settings: () => this.settingsScreen() }[this.screen]();
    kids.push(body);
    this.main.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  // ---------------------------------------------------------------- session screen
  private sessionScreen(): HTMLElement {
    const r = this.recorder, s = r.session;
    this.fv.host ??= localStorage.getItem('gloveHost') ?? 'glove.local';
    const host = this.bind('host', el('input', { type: 'text', size: 22, 'aria-label': 'Glove address' }));
    const connect = el('button', { class: 'primary', onclick: () => { localStorage.setItem('gloveHost', host.value.trim()); this.link.connect(host.value.trim()); this.say('Connecting to ' + host.value.trim() + '…'); } }, 'Connect');
    const conn = el('section', { class: 'panel' }, el('h2', {}, '1 · Glove'),
      el('p', { class: 'sub' }, 'Name or IP of the glove (for the simulator use localhost:9100). The recorder service relays its UDP stream to this page.'),
      el('div', { class: 'row' }, host, connect));

    const cal = r.calibration, missing = cal ? missingCalibration(cal) : ['not connected'];
    const stage = this.glove?.cap?.stage as string | undefined;
    const step = (id: string, title: string, bit: boolean | undefined) => el('button', { disabled: !this.link.ready || (stage && stage !== 'none'), onclick: () => void this.runCalibration(id) }, `${bit ? '✓ ' : ''}${title}`);
    const calPanel = el('section', { class: 'panel' }, el('h2', {}, '2 · Calibration'),
      el('p', { class: 'sub' }, 'Each step starts after a 3 s countdown and holds for 3 s. Do all three, and repeat them every time you put the glove on.'),
      el('div', { class: 'row' }, step('flat', '1 Flat hand', cal?.calibrated?.open), step('up', '2 Fingers up', cal?.calibrated?.mount), step('fist', '3 Fist', cal?.calibrated?.fist), step('press', 'Palm press (optional)', cal?.calibrated?.force)),
      el('p', { class: missing.length ? 'warn' : 'ok' }, missing.length ? 'Recording is blocked until: ' + missing.join(', ') : 'Calibration complete. The snapshot is saved with each session.'),
      stage && stage !== 'none' ? el('p', { class: 'sub' }, `Capturing “${stage}”: hold the pose still…`) : null,
      this.resText ? el('p', { class: 'sub' }, 'Last result: ' + this.resText) : null);

    this.fv.hand ??= localStorage.getItem('hand') ?? 'left';
    // one finger at a time: for sensors whose swing is too small for the whole-hand fist to accept
    const map: number[] = this.glove?.map ?? [0, 1, 2, 3, 4], gflags: number = this.glove?.flags ?? 0, busy = !this.link.ready || (!!stage && stage !== 'none');
    const fingerRow = (fi: number) => {
      const ch = map[fi], open = !!(gflags & (1 << (6 + ch))), flex = !!(gflags & (1 << (11 + ch)));
      const btn = (pose: 'open' | 'flex', done: boolean, text: string) => el('button', { disabled: busy, onclick: () => void this.runCalibration(`finger?f=${fi}&pose=${pose}`) }, (done ? '✓ ' : '') + text);
      return el('tr', {}, el('td', {}, ['Thumb', 'Index', 'Middle', 'Ring', 'Little'][fi]), el('td', {}, btn('open', open, 'Open')), el('td', {}, btn('flex', flex, 'Flexed')),
        el('td', { class: 'sub' }, open && flex ? 'ready' : open ? 'now bend it fully' : 'start with open'));
    };
    const fingerPanel = el('section', { class: 'panel' }, el('h2', {}, '2b · One finger at a time'),
      el('p', { class: 'sub' }, 'Use this when the whole-hand fist says a finger changed too little. Open: that finger straight. Flexed: bend only that finger as far as you will in play, the others relaxed. Each capture waits 3 s, then holds 3 s. The result shows the change and how far it is above the sensor noise.'),
      el('table', {}, el('tbody', {}, ...[0, 1, 2, 3, 4].map(fingerRow))));
    const f = {
      hand: this.bind('hand', el('select', {}, el('option', { value: 'left' }, 'Left'), el('option', { value: 'right' }, 'Right'))),
      ball: this.bind('ball', el('select', { 'aria-label': 'Ball' }, el('option', { value: '' }, 'choose…'), el('option', { value: 'yes' }, 'with a ball'), el('option', { value: 'no' }, 'no ball (shadow play)'))),
      grip: this.bind('grip', el('input', { type: 'text', placeholder: 'e.g. shakehand, loose index finger' })),
      notes: this.bind('notes', el('textarea', { rows: 2, placeholder: 'Free text: table, ball, mood, anything unusual' })),
      hold: this.bind('hold', el('input', { type: 'checkbox' })),
    };
    const start = el('button', { class: 'primary', disabled: !this.link.ready, onclick: async () => {
      try {
        if (!f.ball.value) throw new Error('Choose whether this session is with a ball or without (shadow play).');
        localStorage.setItem('hand', f.hand.value); this.hand.setHanded(f.hand.value as 'left' | 'right');
        await r.startSession({ hand: f.hand.value as 'left' | 'right', withBall: f.ball.value === 'yes', gripNotes: f.grip.value, notes: f.notes.value, holdout: f.hold.checked, host: host.value.trim() });
        this.sessions = await db.listSessions(); this.say('Session started. Go to Record.'); this.go('record');
      } catch (e) { this.say(String((e as Error).message), true); }
    } }, 'Start session');
    const form = el('section', { class: 'panel' }, el('h2', {}, '3 · New session'),
      el('div', { class: 'grid2' }, el('label', {}, 'Glove hand ', f.hand), el('label', {}, 'Ball ', f.ball), el('label', {}, 'Grip ', f.grip), el('label', {}, f.hold, ' holdout session (keep untouched for testing)')),
      el('label', { class: 'block' }, 'Notes', f.notes), start);

    const past = el('select', { 'aria-label': 'Open a session' }, el('option', { value: '' }, 'Open a previous session…'), ...this.sessions.map((x) => el('option', { value: x.id }, `${x.id} · ${x.sets.length} sets`)));
    past.onchange = () => { const x = this.sessions.find((y) => y.id === past.value); if (x) { r.openSession(x); this.say('Opened ' + x.id + ' (review and export only; start a new session to record).'); } };
    const cur = s ? this.sessionSummary(s) : el('p', { class: 'sub' }, 'No session open.');
    const sess = el('section', { class: 'panel' }, el('h2', {}, 'Current session'), cur, el('div', { class: 'row' }, past));
    return el('div', { class: 'cols' }, el('div', {}, conn, calPanel, fingerPanel), el('div', {}, form, sess));
  }

  private sessionSummary(s: SessionRec): HTMLElement {
    const ok = s.events.filter((e) => e.status === 'ok').length;
    const exportBtn = (zip: boolean) => el('button', { onclick: () => void this.exportSession(s, zip) }, zip ? 'Export as zip' : 'Export to folder…');
    return el('div', {},
      el('p', {}, `${s.id} · ${s.hand} hand · ${s.sets.length} sets · ${ok} valid events${s.holdout ? ' · HOLDOUT' : ''}`),
      el('div', { class: 'row' }, canWriteFolder() ? exportBtn(false) : null, exportBtn(true)),
      el('div', { class: 'row' }, el('label', {}, 'Ball ', (() => { const b = el('select', { 'aria-label': 'Ball for this session' }, el('option', { value: 'yes' }, 'with a ball'), el('option', { value: 'no' }, 'no ball (shadow play)')); b.value = s.withBall ? 'yes' : 'no'; b.onchange = () => { s.withBall = b.value === 'yes'; void db.putSession(s); }; return b; })()),
        el('label', {}, 'Notes ', (() => { const t = el('input', { type: 'text', size: 34, value: s.notes }); t.onchange = () => { s.notes = t.value; void db.putSession(s); }; return t; })())),
      el('p', { class: 'sub' }, 'Data is saved in this browser as you record. Export writes the session folder; then copy the folder to a second drive: git does not hold recordings.'));
  }

  private async runCalibration(id: string): Promise<void> {
    for (let n = 3; n > 0; n--) { this.say(`Get into position… ${n}`); await new Promise((r) => setTimeout(r, 1000)); }
    const r = await this.link.http('/api/cal/' + id, 'POST');
    this.say(r.ok ? `Capturing “${id.split('?')[0]}”: hold still for 3 s.` : 'The glove refused: ' + String(r.body), !r.ok);
    setTimeout(() => this.say(''), 4500);
  }

  private async exportSession(s: SessionRec, zip: boolean): Promise<void> {
    try {
      this.say('Preparing the export…');
      if (this.recorder.session?.id === s.id) await this.recorder.endSession();
      const packets = await db.readPackets(s.id);
      const res = zip || !canWriteFolder() ? await exportToZip(s, packets) : await exportToFolder(s, packets);
      this.say(`Exported ${res.files} files (${res.summary.imu} motion samples, ${res.summary.adc} analog) to ${res.where}. Now copy it to a second drive.`);
    } catch (e) { this.say('Export failed: ' + String((e as Error).message), true); }
  }

  // ---------------------------------------------------------------- record screen
  private currentRequest(): SetRequest {
    const f = this.setForm;
    if (f.mode === 'idle') return { kind: 'idle', label: classes.idle.id, subLabel: f.sub, expectedN: null, tempo: 'off', idleSeconds: f.idleSeconds };
    if (f.mode === 'cue') return { kind: 'cue', label: 'mixed', subLabel: '', expectedN: null, tempo: 'off', cueCount: f.cueCount };
    return { kind: 'stroke', label: f.label, subLabel: '', expectedN: f.n, tempo: f.tempo };
  }
  private async startSet(): Promise<void> {
    this.audio ??= new AudioContext();
    try { await this.recorder.startSet(this.currentRequest()); this.say(''); } catch (e) { this.say(String((e as Error).message), true); }
  }
  private onKey(e: KeyboardEvent): void {
    if (this.section === 'use') { this.use.onKey(e); return; }
    if (this.screen !== 'record' || (e.target as HTMLElement)?.matches?.('input, select, textarea')) return;
    const a = this.recorder.active;
    if (e.code === 'Space') { e.preventDefault(); if (!a) void this.startSet(); else this.recorder.endSet('user'); }
    else if (e.key === 'Backspace') { e.preventDefault(); this.recorder.discardActive(); }
    else if (!a && /^[0-9]$/.test(e.key)) {
      if (e.key === '0') this.setForm.mode = 'idle';
      else { const c = strokeKeys().find((k) => k.key === e.key); if (c) { this.setForm.mode = 'stroke'; this.setForm.label = c.id; } }
      this.schedule();
    }
  }

  private bigStatus(): { big: string; small: string; cls: string } {
    const r = this.recorder, a = r.active, s = r.session, now = Date.now();
    if (!s) return { big: 'No session', small: 'Open the Session tab, connect and start one.', cls: 'warn' };
    if (!this.link.ready && !a) return { big: 'Glove not connected', small: 'Connect it on the Session tab.', cls: 'bad' };
    if (!a) {
      const miss = r.calibration ? missingCalibration(r.calibration) : ['calibration'];
      if (miss.length) return { big: 'Calibrate first', small: 'Missing: ' + miss.join(', '), cls: 'bad' };
      if (r.pendingSets.length) return { big: 'Decide on the flagged set', small: 'Keep, discard or review it below. Space still starts a new set.', cls: 'warn' };
      return { big: 'READY', small: 'Space starts the set. Keys: ' + strokeKeys().map((k) => `${k.key} ${k.label}`).join(' · ') + ' · 0 idle', cls: 'ok' };
    }
    if (a.phase === 'countdown') { const left = Math.max(1, Math.ceil((classes.defaults.countdownSeconds * 1000 - (now - a.t0)) / 1000)); return { big: String(left), small: 'Hold the ready position. Space cancels.', cls: 'warn' }; }
    if (a.phase === 'finishing') return { big: 'Saving…', small: a.endReason, cls: 'info' };
    const n = a.events.length;
    if (a.req.kind === 'idle') { const left = Math.max(0, Math.ceil(((a.req.idleSeconds ?? 60) * 1000 - (now - a.tRec)) / 1000)); return { big: `${left} s`, small: `Idle · ${a.req.subLabel} · Space ends it`, cls: 'rec' }; }
    if (a.req.kind === 'cue') return { big: (r.currentCue ?? '…').replace(/_/g, ' ').toUpperCase(), small: `Cue ${Math.max(0, a.cueIdx + 1)} of ${a.cues.length} · detected ${n}`, cls: 'rec' };
    return { big: `${n} / ${a.req.expectedN}`, small: `RECORDING ${a.req.label.replace(/_/g, ' ')} · Space ends · Backspace discards`, cls: 'rec' };
  }
  private updateBigStatus(): void {
    const { big, small, cls } = this.bigStatus();
    if (this.live.big) { this.live.big.textContent = big; this.live.small!.textContent = small; this.live.box!.className = 'status ' + cls; }
    const e = this.recorder.live.energy;
    if (this.live.bar) this.live.bar.style.width = Math.min(100, (e / (this.detectorCfg.highThreshold * 4)) * 100) + '%';
    const a = this.recorder.active;
    if (this.live.meta) this.live.meta.textContent = a ? `${a.imu.length} motion · ${a.adc.length} analog · age ${a.lastPacketWall ? Date.now() - a.lastPacketWall : '–'} ms` : '';
  }

  private recordScreen(): HTMLElement {
    const r = this.recorder, a = r.active, f = this.setForm, s = r.session;
    const big = el('div', { class: 'big' }), small = el('div', { class: 'sub' }), box = el('div', { class: 'status' }, big, small);
    const bar = el('div', { class: 'fill' }), meta = el('div', { class: 'sub num' });
    this.live = { big, small, bar, box, meta };
    const disabled = !!a;
    const modeBtn = (m: SetForm['mode'], t: string) => el('button', { class: 'chip' + (f.mode === m ? ' on' : ''), disabled, onclick: () => { f.mode = m; this.schedule(); } }, t);
    const classBtns = strokeKeys().map((k) => el('button', { class: 'chip' + (f.mode === 'stroke' && f.label === k.id ? ' on' : ''), disabled, onclick: () => { f.mode = 'stroke'; f.label = k.id; this.schedule(); } }, `${k.key} · ${k.label}`));
    const num = (v: number, set: (n: number) => void, min = 1, max = 200) => el('input', { type: 'number', value: String(v), min, max, disabled, onchange: (e: Event) => set(Math.max(min, Math.min(max, Number((e.target as HTMLInputElement).value)))) });
    const opts = (vals: string[], cur: string, set: (v: string) => void) => { const x = el('select', { disabled }, ...vals.map((v) => el('option', { value: v }, v.replace(/_/g, ' ')))); x.value = cur; x.onchange = () => set(x.value); return x; };
    const ctl = f.mode === 'stroke'
      ? el('div', { class: 'row' }, el('label', {}, 'Reps ', num(f.n, (n) => (f.n = n))), el('label', {}, 'Tempo beep ', opts(Object.keys(classes.defaults.tempos), f.tempo, (v) => (f.tempo = v))))
      : f.mode === 'idle'
        ? el('div', { class: 'row' }, el('label', {}, 'What ', opts(classes.idle.subLabels, f.sub, (v) => (f.sub = v))), el('label', {}, 'Seconds ', num(f.idleSeconds, (n) => (f.idleSeconds = n), 5, 600)))
        : el('div', { class: 'row' }, el('label', {}, 'Cues ', num(f.cueCount, (n) => (f.cueCount = n), 4, 200)), el('span', { class: 'sub' }, 'Perform each cued stroke when you hear the beep; labels follow the cue order.'));
    const go = a
      ? el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => r.endSet('user') }, 'End set (Space)'), el('button', { onclick: () => r.discardActive() }, 'Discard (Backspace)'))
      : el('div', { class: 'row' }, el('button', { class: 'primary', disabled: !s, onclick: () => void this.startSet() }, 'Start set (Space)'));
    const left = el('div', {}, box, el('div', { class: 'meter', 'aria-label': 'Live movement energy' }, bar), meta,
      el('section', { class: 'panel' }, el('div', { class: 'row' }, modeBtn('stroke', 'Strokes'), modeBtn('idle', '0 · Idle'), modeBtn('cue', 'Mixed cues')), el('div', { class: 'row' }, ...(f.mode === 'stroke' ? classBtns : [])), ctl, go),
      this.setList(s));
    const right = el('div', {}, el('section', { class: 'panel' }, el('h2', {}, 'Live hand'), this.hand.el,
      el('div', { class: 'row' }, ...(['back', 'palm', 'side'] as const).map((v) => el('button', { onclick: () => this.hand.setView(v) }, v)))), this.protocolPanel());
    this.updateBigStatus();
    return el('div', { class: 'cols wide' }, left, right);
  }

  private protocolPanel(): HTMLElement {
    return el('section', { class: 'panel' }, el('h2', {}, 'Protocol'), el('ul', {}, ...PROTOCOL_HINTS.map((h) => el('li', {}, h))));
  }

  private flagChips(set: SetRec): Kid[] {
    return set.flags.map((f) => el('span', { class: 'flag ' + f.severity, title: f.detail }, f.code));
  }

  private setList(s: SessionRec | null): HTMLElement {
    if (!s || !s.sets.length) return el('section', { class: 'panel' }, el('h2', {}, 'Sets'), el('p', { class: 'sub' }, 'None yet.'));
    const rows = [...s.sets].reverse().map((x) => {
      const events = s.events.filter((e) => e.setId === x.id && e.status === 'ok').length;
      const btns = x.status === 'pending'
        ? [el('button', { class: 'primary', onclick: () => void this.recorder.resolveSet(x.id, true) }, 'Keep'), el('button', { onclick: () => void this.recorder.resolveSet(x.id, false) }, 'Discard'), el('button', { onclick: () => void this.openReview(x.id) }, 'Review')]
        : [el('button', { onclick: () => void this.openReview(x.id) }, 'Review')];
      return el('tr', { class: 'st-' + x.status }, el('td', {}, x.id.split('-').pop()), el('td', {}, x.kind === 'idle' ? `idle · ${x.subLabel}` : x.label.replace(/_/g, ' ')), el('td', { class: 'num' }, x.kind === 'idle' ? '–' : `${events}${x.expectedN ? ' / ' + x.expectedN : ''}`),
        el('td', {}, el('span', { class: 'status-pill ' + x.status }, x.status), ...this.flagChips(x)), el('td', {}, ...btns));
    });
    return el('section', { class: 'panel' }, el('h2', {}, 'Sets'), el('table', {}, el('thead', {}, el('tr', {}, ...['Set', 'Class', 'Events', 'Status / flags', ''].map((t) => el('th', {}, t)))), el('tbody', {}, ...rows)));
  }

  // ---------------------------------------------------------------- review screen
  private async openReview(setId: string): Promise<void> {
    const s = this.recorder.session, set = s?.sets.find((x) => x.id === setId);
    if (!s || !set) return;
    this.review = { setId, imu: [], trace: [], selected: null, loading: true, playing: false, speed: 1 };
    this.go('review');
    const packets = await db.readPackets(s.id, set.packetFirst, set.packetLast);
    const imu = parseAll(packets).imu.filter((r) => r.tUs >= set.tStartUs - 500_000 && r.tUs <= set.tEndUs + 200_000);
    this.review = { ...this.review!, imu, trace: energyTrace(this.detectorCfg, imu), loading: false };
    this.schedule();
  }

  private reviewScreen(): HTMLElement {
    const s = this.recorder.session;
    if (!s || !s.sets.length) return el('section', { class: 'panel' }, el('p', {}, 'Record a set first, then review it here.'));
    const rv = this.review ?? null;
    const pick = el('select', { 'aria-label': 'Set to review' }, ...s.sets.map((x) => el('option', { value: x.id }, `${x.id.split('-').pop()} · ${x.kind === 'idle' ? 'idle' : x.label} · ${x.status}`)));
    pick.value = rv?.setId ?? s.sets[s.sets.length - 1].id;
    pick.onchange = () => void this.openReview(pick.value);
    if (!rv) { void this.openReview(pick.value); return el('section', { class: 'panel' }, el('p', {}, 'Loading…')); }
    const set = s.sets.find((x) => x.id === rv.setId)!;
    const evs = s.events.filter((e) => e.setId === set.id);
    const canvas = el('canvas', { class: 'plot', role: 'img', 'aria-label': 'Movement energy of the set with detected strokes marked' });
    canvas.onclick = (ev) => void this.plotClick(ev, canvas, set);
    requestAnimationFrame(() => this.drawPlot(canvas, set, evs, rv));
    const sel = evs.find((e) => e.id === rv.selected);
    const addLabel = el('select', { 'aria-label': 'Label for a new event' }, ...strokeKeys().map((k) => el('option', { value: k.id }, k.label)));
    addLabel.value = set.kind === 'stroke' ? set.label : strokeKeys()[0].id;
    (canvas as any)._label = addLabel;
    const row = (e: EventRec, i: number) => el('tr', { class: (rv.selected === e.id ? 'sel ' : '') + 'ev-' + e.status, onclick: () => { rv.selected = e.id; this.schedule(); } },
      el('td', {}, String(i + 1)), el('td', {}, e.label.replace(/_/g, ' ')), el('td', { class: 'num' }, fmt((e.tPeakUs - set.tStartUs) / 1e6, 2) + ' s'), el('td', { class: 'num' }, fmt(e.peakEnergy, 2)), el('td', {}, e.source + ' · ' + e.status));
    const edit = async (fn: () => void) => { fn(); refreshSetFlags(s, set); await db.putSession(s); this.schedule(); };
    const selBtns = sel ? el('div', { class: 'row' },
      el('button', { onclick: () => void edit(() => (sel.status = 'deleted')) }, 'Delete'),
      el('button', { onclick: () => void edit(() => (sel.status = sel.status === 'ambiguous' ? 'ok' : 'ambiguous')) }, sel.status === 'ambiguous' ? 'Mark clear' : 'Mark ambiguous'),
      sel.status === 'deleted' ? el('button', { onclick: () => void edit(() => (sel.status = 'ok')) }, 'Restore') : null,
      el('button', { class: 'primary', onclick: () => this.replay(set, sel, rv) }, rv.playing ? 'Playing…' : '▶ Replay on the 3D hand'),
      set.kind === 'idle' ? el('button', { onclick: () => void edit(() => trimSetBefore(s, set, sel.tPeakUs)) }, 'Cut the set 1 s before this event') : null,
      opts2(['1', '0.5', '0.25'], String(rv.speed), (v) => (rv.speed = Number(v)))) : el('p', { class: 'sub' }, 'Click an event (in the plot or the table) to edit or replay it. Click empty plot area to add a missed event.');
    return el('div', { class: 'cols wide' },
      el('div', {},
        el('section', { class: 'panel' }, el('h2', {}, 'Review'), el('div', { class: 'row' }, pick, el('span', { class: 'sub' }, set.flags.length ? 'Flags: ' + set.flags.map((f) => `${f.code} (${f.detail})`).join('; ') : 'No quality flags.')),
          rv.loading ? el('p', {}, 'Loading samples…') : canvas,
          el('div', { class: 'row' }, el('label', {}, 'Add as ', addLabel), el('button', { onclick: () => void this.rerun(set, rv) }, 'Re-run detector with current settings'))),
        el('section', { class: 'panel' }, selBtns,
          el('div', { class: 'row' }, set.status === 'discarded' ? el('span', { class: 'sub' }, 'This set is discarded.') : el('button', { onclick: () => { if (confirm('Discard this whole set? Its data stays stored but is left out of exports and counts.')) void edit(() => { set.status = 'discarded'; s.events.filter((e) => e.setId === set.id).forEach((e) => (e.status = 'deleted')); }); } }, 'Discard this set')),
          el('table', {}, el('thead', {}, el('tr', {}, ...['#', 'Label', 'Time', 'Energy', 'Source · status'].map((t) => el('th', {}, t)))), el('tbody', {}, ...evs.map(row))))),
      el('div', {}, el('section', { class: 'panel' }, el('h2', {}, 'Hand'), this.hand.el), this.protocolPanel()));
  }

  private async rerun(set: SetRec, rv: ReviewState): Promise<void> {
    const s = this.recorder.session!;
    if (!confirm('Replace the automatic events of this set with a fresh detector run? Manual events are kept.')) return;
    rerunDetector(s, set, rv.imu, this.detectorCfg); await db.putSession(s); this.schedule();
  }

  private async plotClick(ev: MouseEvent, canvas: HTMLCanvasElement, set: SetRec): Promise<void> {
    const rv = this.review, s = this.recorder.session; if (!rv || !s || !rv.imu.length) return;
    const rect = canvas.getBoundingClientRect(), t0 = rv.imu[0].tUs, t1 = rv.imu[rv.imu.length - 1].tUs;
    const t = t0 + ((ev.clientX - rect.left) / rect.width) * (t1 - t0);
    const evs = s.events.filter((e) => e.setId === set.id && e.status !== 'deleted');
    const near = evs.find((e) => Math.abs(e.tPeakUs - t) < ((t1 - t0) * 8) / rect.width);
    if (near) { rv.selected = near.id; this.schedule(); return; }
    const tp = snapToPeak(this.detectorCfg, rv.imu, t), lab = ((canvas as any)._label as HTMLSelectElement)?.value;
    const e = rv.trace.reduce((best, x) => (Math.abs(x.tUs - tp) < Math.abs(best.tUs - tp) ? x : best), rv.trace[0]);
    const created = addManualEvent(s, set, tp, e.e, this.detectorCfg, set.kind === 'stroke' ? undefined : lab);
    rv.selected = created.id; await db.putSession(s); this.schedule();
  }

  private drawPlot(canvas: HTMLCanvasElement, set: SetRec, evs: EventRec[], rv: ReviewState): void {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth || 800, h = 220;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + 'px';
    const g = canvas.getContext('2d'); if (!g || !rv.trace.length) return;
    g.scale(dpr, dpr);
    const t0 = rv.trace[0].tUs, t1 = rv.trace[rv.trace.length - 1].tUs, emax = Math.max(this.detectorCfg.highThreshold * 2, ...rv.trace.map((x) => x.e)) * 1.1;
    const X = (t: number) => ((t - t0) / (t1 - t0)) * w, Y = (e: number) => h - 18 - (e / emax) * (h - 28);
    g.fillStyle = '#f6f9fc'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e8eef4'; g.fillRect(X(set.tStartUs), 0, X(set.tEndUs) - X(set.tStartUs), h);
    g.strokeStyle = '#c9a227'; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(0, Y(this.detectorCfg.highThreshold)); g.lineTo(w, Y(this.detectorCfg.highThreshold)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#2766ad'; g.lineWidth = 1.6; g.beginPath();
    rv.trace.forEach((p, i) => (i ? g.lineTo(X(p.tUs), Y(p.e)) : g.moveTo(X(p.tUs), Y(p.e)))); g.stroke();
    evs.forEach((e) => {
      const x = X(e.tPeakUs), col = e.status === 'deleted' ? '#aaa' : e.status === 'ambiguous' ? '#d08a00' : e.source === 'manual' ? '#7a3fb0' : '#1a8f4d';
      g.strokeStyle = col; g.lineWidth = rv.selected === e.id ? 3 : 1.5; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 18); g.stroke();
      g.fillStyle = col; g.font = '11px sans-serif'; g.fillText(e.label.slice(0, 2).toUpperCase() + (e.status !== 'ok' ? '?' : ''), x + 3, 14);
    });
    g.fillStyle = '#53677c'; g.font = '11px sans-serif'; g.fillText(`${fmt((t1 - t0) / 1e6, 1)} s · shaded = the set · dashed = detector threshold`, 6, h - 4);
  }

  private replay(set: SetRec, ev: EventRec, rv: ReviewState): void {
    clearInterval(this.replayTimer);
    const w = rv.imu.filter((r) => r.tUs >= ev.tPeakUs - this.detectorCfg.windowPreMs * 1000 && r.tUs <= ev.tPeakUs + this.detectorCfg.windowPostMs * 1000);
    if (!w.length) return;
    rv.playing = true; this.schedule();
    const start = performance.now(), t0 = w[0].tUs; let i = 0;
    this.replayTimer = window.setInterval(() => {
      const t = t0 + (performance.now() - start) * 1000 * rv.speed;
      while (i < w.length - 1 && w[i + 1].tUs <= t) i++;
      this.hand.setPose(w[i].q, w[i].curl, w[i].pressure, true);
      if (t > w[w.length - 1].tUs + 300_000) { clearInterval(this.replayTimer); rv.playing = false; this.schedule(); }
    }, 16);
    void set;
  }

  // ---------------------------------------------------------------- dashboard
  private dashboardScreen(): HTMLElement {
    const all = this.sessions.filter((x) => x.id !== this.recorder.session?.id);
    if (this.recorder.session) all.push(this.recorder.session);
    const st = computeStats(all, classes), t = classes.targets;
    const row = (c: (typeof st.classes)[number]) => el('tr', {}, el('td', {}, c.id.replace(/_/g, ' ')), el('td', { class: 'num' }, String(c.total)), el('td', { class: 'num' }, `${c.train} / ${c.holdout}`),
      el('td', { class: 'barcell' }, el('div', { class: 'meter' }, el('div', { class: 'fill', style: `width:${Math.min(100, (100 * c.train) / t.eventsPerClass)}%` })), el('span', { class: 'sub num' }, `${c.train} of ${t.eventsPerClass}`)));
    return el('div', { class: 'cols wide' }, el('div', {},
      el('section', { class: 'panel' }, el('h2', {}, 'Valid events'), el('table', {}, el('thead', {}, el('tr', {}, ...['Class', 'Total', 'Train / holdout', 'Progress to target'].map((x) => el('th', {}, x)))), el('tbody', {}, ...st.classes.map(row))),
        el('p', {}, `Idle: ${fmt(st.idleMinutes, 1)} of ${t.idleMinutes} min`), el('div', { class: 'meter' }, el('div', { class: 'fill', style: `width:${Math.min(100, (100 * st.idleMinutes) / t.idleMinutes)}%` })),
        el('p', { class: 'sub' }, `${all.length} session(s) in this browser. Valid = an “ok” event in a set you kept.`)),
      el('section', { class: 'panel' }, el('h2', {}, 'Per session'), el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Session'), ...st.classes.map((c) => el('th', {}, c.id.replace(/_/g, ' '))), el('th', {}, 'Idle min'))),
        el('tbody', {}, ...all.map((x) => el('tr', {}, el('td', {}, x.id + (x.holdout ? ' (holdout)' : '')), ...st.classes.map((c) => el('td', { class: 'num' }, String(c.bySession[x.id] ?? 0))),
          el('td', { class: 'num' }, fmt(x.sets.filter((y) => y.kind === 'idle' && (y.status === 'ok' || y.status === 'flagged')).reduce((m, y) => m + (y.tEndUs - y.tStartUs), 0) / 6e7, 1))))))),
      st.warnings.length ? el('section', { class: 'panel' }, el('h2', {}, 'Warnings'), el('ul', {}, ...st.warnings.map((w) => el('li', { class: 'warn' }, w)))) : null),
      el('div', {}, this.protocolPanel()));
  }

  // ---------------------------------------------------------------- settings
  private settingsScreen(): HTMLElement {
    const c = this.detectorCfg;
    const fields: [keyof DetectorConfig, string, string][] = [['highThreshold', 'Start threshold (energy)', 'Higher ignores softer movements'], ['endFraction', 'End at fraction of the peak', ''], ['smoothingMs', 'Smoothing (ms)', ''], ['maxAfterPeakMs', 'Max time after the peak (ms)', ''], ['refractoryMs', 'Refractory period (ms)', 'Ignore new events this long after a peak'], ['recoveryMs', 'Recovery window (ms)', 'After a stroke, a smaller bump this soon is the hand returning'], ['recoveryRatio', 'Recovery bump limit (fraction of the stroke peak)', 'Bumps below this fraction are dropped'], ['recoveryCos', 'Recovery direction limit (cosine)', 'A bump swinging against the stroke (below this) is dropped; -1 is exactly opposite']];
    const inputs = fields.map(([k, label, help]) => { const i = el('input', { type: 'number', step: 'any', value: String(c[k]) }); (i as any)._k = k; return { i, label, help, k }; });
    const out = el('p', { class: 'sub' });
    const save = el('button', { class: 'primary', onclick: async () => {
      const next = { ...c } as any;
      inputs.forEach(({ i, k }) => { const v = Number(i.value); if (Number.isFinite(v) && (k === 'recoveryCos' ? v >= -1 && v <= 1 : v > 0)) next[k] = v; });
      this.detectorCfg = next; this.recorder.detectorCfg = next; this.use.setDetector(next); await db.putSetting('detector', next); out.textContent = 'Saved. New sets use these parameters; the session records them.';
    } }, 'Save');
    const reset = el('button', { onclick: async () => { this.detectorCfg = baseDetector; this.recorder.detectorCfg = baseDetector; this.use.setDetector(baseDetector); await db.putSetting('detector', baseDetector); this.schedule(); } }, 'Reset to defaults');
    const suggest = el('button', { onclick: async () => {
      const s = this.recorder.session; const idle = s?.sets.filter((x) => x.kind === 'idle' && x.status !== 'discarded') ?? [];
      if (!s || !idle.length) { out.textContent = 'Record some idle sets first (walking, adjusting the grip, half swings): the threshold is suggested from them.'; return; }
      const energies: number[] = [];
      for (const x of idle) { const imu = parseAll(await db.readPackets(s.id, x.packetFirst, x.packetLast)).imu.filter((r) => r.tUs >= x.tStartUs && r.tUs <= x.tEndUs); energies.push(...energyTrace(this.detectorCfg, imu).map((t) => t.e)); }
      const r = suggestThreshold(energies);
      out.textContent = r ? `Idle energy: 99th percentile ${fmt(r.p99, 2)}, 99.5th ${fmt(r.p995, 2)}, maximum ${fmt(r.max, 2)}. Suggested start threshold: ${r.suggested}.` : 'Not enough idle data yet.';
      if (r) { (inputs.find((x) => x.k === 'highThreshold')!.i as HTMLInputElement).value = String(r.suggested); }
    } }, 'Suggest threshold from idle sets');
    return el('div', { class: 'cols' }, el('section', { class: 'panel' }, el('h2', {}, 'Stroke detector'),
      el('p', { class: 'sub' }, `Version ${c.version}. Energy = smoothed √((gyro/${c.gyroScaleDps} °/s)² + (accel/${c.accelScaleG} g)²). The same module runs live and in review.`),
      ...inputs.map(({ i, label, help }) => el('label', { class: 'block' }, label + ' ', i, help ? el('span', { class: 'sub' }, ' ' + help) : null)),
      el('div', { class: 'row' }, save, reset, suggest), out),
    el('section', { class: 'panel' }, el('h2', {}, 'Data'), el('p', { class: 'sub' }, 'Recordings live in this browser (IndexedDB) until you export them. Classes come from config/classes.json: add serve, loop or chop there and rebuild.')));
  }
}

function opts2(vals: string[], cur: string, set: (v: string) => void): HTMLSelectElement {
  const x = el('select', { 'aria-label': 'Replay speed' }, ...vals.map((v) => el('option', { value: v }, v + '×')));
  x.value = cur; x.onchange = () => set(x.value);
  return x;
}
