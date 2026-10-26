// The Use section: live stroke classification. DOM only; the classification itself lives in ml/liveClassifier.ts.
// Layout "rally tape": the latest answer owns the left, the tape of recent strokes runs down the right.
import detectorJson from '../config/detector.json';
import { el, type Kid } from './dom';
import type { DetectorConfig } from './detector';
import type { HandView } from './hand';
import type { GloveLink } from './link';
import { LiveClassifier, type LiveResult, type Mode } from './ml/liveClassifier';
import { loadModel, type CompactModel } from './ml/xgb';
import { parsePacket } from './protocol';

const STROKES: Record<string, { name: string; code: string; cls: string }> = {
  forehand_drive: { name: 'Forehand', code: 'FH', cls: 'fh' },
  backhand_drive: { name: 'Backhand', code: 'BH', cls: 'bh' },
  smash: { name: 'Smash', code: 'SM', cls: 'sm' },
  push: { name: 'Push', code: 'PU', cls: 'pu' },
  none: { name: 'Not a stroke', code: '–', cls: 'no' },
};
const ACCENT: Record<string, number> = { forehand_drive: 0x2766ad, backhand_drive: 0x0f766e, smash: 0xb4491f, push: 0x6b4fa3, none: 0x7d8da1 };
const TARGETS = ['forehand_drive', 'backhand_drive', 'smash', 'push'];
type Verdict = 'match' | 'wrong' | 'unsure' | null;
type Shown = LiveResult & { verdict: Verdict; confident: boolean; rank: number | null };
const MAX_KEPT = 120, SHOWN = 40, RECENT = 20;

const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window: the setting just is not remembered */ } };
function fill(p: Element, ...k: Kid[]): void { p.replaceChildren(...(k.filter(Boolean) as (Node | string)[])); }
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface UseDeps {
  link: GloveLink;
  /** the app's one 3D hand: its canvas moves into this screen while Use is open */
  hand: HandView;
  /** the glove's current calibration (GET /api/calibration), or null */
  calibration: () => any;
  refreshCalibration: () => Promise<void>;
  recording: () => boolean;
  gotoTrain: () => void;
}

const ICON = {
  match: 'M4 12.5l5 5L20 6.5', wrong: 'M6 6l12 12M18 6L6 18', unsure: 'M9.5 9a2.5 2.5 0 115 0c0 1.8-2.5 2-2.5 4M12 17.5v.5',
};
function icon(kind: keyof typeof ICON): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'uicon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON[kind]); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.4'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(p); return s;
}

export class UseScreen {
  readonly root = el('div', { class: 'use' });
  private models: Record<Mode, CompactModel> | null = null;
  private lc: LiveClassifier | null = null;
  private loadError = '';
  private cfg: DetectorConfig = detectorJson as DetectorConfig;
  private mode: 'free' | 'drill' = stored('useMode', 'free') === 'drill' ? 'drill' : 'free';
  private speed: Mode = stored('useSpeed', 'fast') === 'accurate' ? 'accurate' : 'fast';
  private unsure = Math.min(0.95, Math.max(0.3, Number(stored('useUnsure', '0.6')) || 0.6));
  private target = TARGETS.includes(stored('useTarget', '')) ? stored('useTarget', '') : TARGETS[0];
  private active = false;
  private results: Shown[] = [];
  private tally: Record<string, number> = {};
  private marks: Exclude<Verdict, null>[] = [];
  private lastWall = 0; private rateStamp = 0; private rateN = 0; private hz = 0;
  private streamAsked = 0;
  private energy = 0;
  private nodes: { answer?: HTMLElement; tape?: HTMLElement; tally?: HTMLElement; status?: HTMLElement; meter?: HTMLElement; drill?: HTMLElement } = {};

  constructor(private readonly d: UseDeps) { void this.init(); this.build(); }

  private async init(): Promise<void> {
    try {
      const [fast, accurate] = await Promise.all([loadModel('/models/stroke_live160.json'), loadModel('/models/stroke_live320.json')]);
      this.models = { fast, accurate };
      this.lc = new LiveClassifier(this.models, this.cfg);
      this.lc.mode = this.speed; this.lc.onResult = (r) => this.onResult(r);
    } catch (e) { this.loadError = `The model could not be loaded: ${String((e as Error).message)}. Run npm run build after ml/export_compact.py.`; }
    this.build();
  }

  // ---------------------------------------------------------------- lifecycle and data
  activate(): void { this.active = true; this.d.hand.setPlay(true); this.ensureStream(true); void this.d.refreshCalibration(); this.build(); }
  deactivate(): void { this.active = false; this.d.hand.setPlay(false); if (!this.d.recording()) this.d.link.stopStream(); this.lc?.reset(); this.streamAsked = 0; }
  /** Called when the relay or the glove changes state, and from the tick. */
  ensureStream(force = false): void {
    if (!this.active || !this.d.link.ready || this.d.recording()) return;
    const streaming = this.d.link.relay?.streaming;
    if (!streaming && (force || Date.now() - this.streamAsked > 3000)) { this.streamAsked = Date.now(); this.d.link.startStream(); }
  }
  setDetector(cfg: DetectorConfig): void { this.cfg = cfg; this.lc?.setDetector(cfg); }

  feed(buf: ArrayBuffer): void {
    if (!this.active || !this.lc) return;
    let p; try { p = parsePacket(buf); } catch { return; }
    const now = Date.now();
    for (const rec of p.imu) this.lc.push(rec, p.header.bootId, now);
    const last = p.imu[p.imu.length - 1];
    if (last) this.d.hand.setPose(last.q, last.curl, last.pressure);
    this.energy = this.lc.energy; this.lastWall = now; this.rateN += p.imu.length;
    if (now - this.rateStamp >= 1000) { this.hz = (this.rateN * 1000) / (now - this.rateStamp || 1); this.rateN = 0; this.rateStamp = now; }
  }

  private onResult(r: LiveResult): void {
    const s: Shown = { ...r, verdict: null, confident: r.status === 'ok' && r.confidence >= this.unsure, rank: null };
    if (r.status === 'ok' && r.label !== 'none') {
      const past = this.results.filter((x) => x.status === 'ok' && x.label !== 'none').slice(0, RECENT).map((x) => x.peakEnergy);
      s.rank = past.length >= 5 ? past.filter((e) => e < r.peakEnergy).length / past.length : null;
    }
    if (this.mode === 'drill' && r.status === 'ok' && r.label !== 'none') s.verdict = !s.confident ? 'unsure' : r.label === this.target ? 'match' : 'wrong';
    if (s.verdict) this.marks.push(s.verdict);
    this.d.hand.setAccent(s.confident && r.label !== 'none' ? ACCENT[r.label!] ?? ACCENT.none : ACCENT.none);
    if (r.status === 'ok' && s.confident) this.tally[r.label!] = (this.tally[r.label!] ?? 0) + 1;
    this.results.unshift(s); if (this.results.length > MAX_KEPT) this.results.length = MAX_KEPT;
    this.paintAnswer(true); this.paintTape(); this.paintTally(); this.paintDrill();
  }

  private reset(): void { this.results = []; this.tally = {}; this.marks = []; this.paintAnswer(false); this.paintTape(); this.paintTally(); this.paintDrill(); }

  tick(): void {
    const n = this.nodes;
    if (n.meter) n.meter.style.width = Math.min(100, (this.energy / (detectorJson.highThreshold * 4)) * 100) + '%';
    this.ensureStream();
    if (n.status) this.paintStatus();
  }

  onKey(e: KeyboardEvent): void {
    if (!this.active || this.mode !== 'drill' || (e.target as HTMLElement)?.matches?.('input, select, textarea')) return;
    const i = Number(e.key);
    if (i >= 1 && i <= 4) { this.target = TARGETS[i - 1]; save('useTarget', this.target); this.build(); }
  }

  // ---------------------------------------------------------------- building
  private seg<T extends string>(label: string, opts: [T, string][], cur: T, set: (v: T) => void): HTMLElement {
    return el('div', { class: 'seg', role: 'group', 'aria-label': label }, ...opts.map(([v, t]) =>
      el('button', { class: 'chip' + (v === cur ? ' on' : ''), 'aria-pressed': String(v === cur), onclick: () => set(v) }, t)));
  }

  private build(): void {
    const d = this.d, fastMs = this.models?.fast ? this.models.fast.post_ms + 25 : 185, accMs = this.models?.accurate ? this.models.accurate.post_ms + 25 : 345;
    const speedSeg = this.seg('Speed', [['fast', 'Fast'], ['accurate', 'Accurate']] as [Mode, string][], this.speed, (v) => {
      this.speed = v; save('useSpeed', v); if (this.lc) this.lc.mode = v; this.build();
    });
    const modeSeg = this.seg('Mode', [['free', 'Free play'], ['drill', 'Drill']] as ['free' | 'drill', string][], this.mode, (v) => { this.mode = v; save('useMode', v); this.marks = []; this.build(); });
    const slider = el('input', { type: 'range', min: '30', max: '95', step: '5', value: String(Math.round(this.unsure * 100)), 'aria-label': 'Answer only when at least this sure' });
    const sliderVal = el('span', { class: 'num' }, pct(this.unsure));
    slider.oninput = () => { this.unsure = Number(slider.value) / 100; sliderVal.textContent = pct(this.unsure); save('useUnsure', String(this.unsure)); };
    const reset = el('button', { onclick: () => this.reset() }, 'Clear');

    this.nodes.answer = el('section', { class: 'uanswer', 'aria-label': 'Latest stroke' });
    this.nodes.tape = el('ol', { class: 'utape' });
    this.nodes.tally = el('div', { class: 'utally', 'aria-label': 'Strokes this run' });
    this.nodes.status = el('p', { class: 'ustatus', role: 'status' });
    this.nodes.meter = el('div', { class: 'fill' });
    this.nodes.drill = el('div', { class: 'udrill' });

    const targetSeg = this.mode === 'drill'
      ? this.seg('Target stroke', TARGETS.map((t, i) => [t, `${i + 1} ${STROKES[t].name}`] as [string, string]), this.target, (v) => { this.target = v; save('useTarget', v); this.build(); })
      : null;

    fill(this.root,
      el('div', { class: 'ustrip' }, modeSeg, targetSeg, speedSeg, el('span', { class: 'sub' }, `${this.speed === 'fast' ? fastMs : accMs} ms after the swing peak`),
        el('label', { class: 'uthresh' }, 'Answer when at least ', slider, ' ', sliderVal, ' sure'), reset),
      el('div', { class: 'ustatusrow' }, this.nodes.status, this.nodes.tally),
      el('div', { class: 'ugrid' },
        el('div', { class: 'ucol' }, this.nodes.answer, this.mode === 'drill' ? this.nodes.drill : null,
          el('div', { class: 'umove' }, el('span', {}, 'Movement'), el('div', { class: 'meter', 'aria-label': 'Live movement energy' }, this.nodes.meter)),
          el('section', { class: 'upanel' }, el('h2', {}, 'Recent strokes'), this.nodes.tape)),
        el('div', { class: 'ucol uhandcol' },
          el('section', { class: 'upanel uhand' }, el('div', { class: 'row' }, el('h2', {}, 'Live hand'), ...(['back', 'palm', 'side'] as const).map((v) => el('button', { onclick: () => d.hand.setView(v) }, v))), d.hand.el))),
      this.evidence(), this.loadError ? el('p', { class: 'banner bad', role: 'alert' }, this.loadError) : null);
    this.paintStatus(); this.paintAnswer(false); this.paintTape(); this.paintTally(); this.paintDrill();
    void d;
  }

  private evidence(): HTMLElement {
    const m = this.models?.[this.speed], ev = m?.evidence;
    const body = ev
      ? el('div', {},
          el('p', {}, `Measured on sets the model had not seen: ${pct(ev.accuracy)} of ${ev.windows} detector triggers classified correctly (95% interval ${pct(ev.interval[0])} to ${pct(ev.interval[1])}, ${ev.sets} sets).`),
          el('p', {}, 'Right answers per kind: ', ...Object.entries(ev.recall).map(([k, v]) => `${STROKES[k]?.name ?? k} ${pct(v)}`).join(' · ')),
          el('p', { class: 'sub' }, 'One player, two sessions (shadow play and with a ball). Smash is the weakest: it was mostly trained on shadow smashes, which look like forehands. Hold the paddle and calibrate as you did when recording, because hand pitch carries much of the answer.'))
      : el('p', { class: 'sub' }, 'Loading…');
    return el('details', { class: 'uevidence' }, el('summary', {}, 'How reliable is this?'), body);
  }

  // ---------------------------------------------------------------- painting
  private paintStatus(): void {
    const n = this.nodes.status; if (!n) return;
    const r = this.d.link.relay, now = Date.now(), cal = this.d.calibration();
    let text = '', cls = 'sub', action: HTMLElement | null = null;
    if (this.loadError) { text = 'Model not loaded.'; cls = 'bad'; }
    else if (!r) { text = 'The recorder service is not running (npm start).'; cls = 'bad'; }
    else if (r.glove !== 'open') { text = 'The glove is not connected.'; cls = 'warn'; action = el('button', { onclick: () => this.d.gotoTrain() }, 'Connect in Train'); }
    else if (cal && !(cal.calibrated?.gyro && cal.calibrated?.mount && cal.calibrated?.open && cal.calibrated?.fist)) { text = 'The glove is not calibrated, so the answers will be wrong.'; cls = 'warn'; action = el('button', { onclick: () => this.d.gotoTrain() }, 'Calibrate in Train'); }
    else if (!this.lastWall || now - this.lastWall > 2000) { text = this.d.recording() ? 'A set is recording in Train; finish it first.' : 'Waiting for data from the glove…'; cls = 'warn'; }
    else {
      text = `Listening · ${Math.round(this.hz)} samples/s`; cls = 'ok';
      const trained = this.models?.fast.trained_mount_q_wxyz, q = cal?.mount_q_wxyz as number[] | undefined;
      if (trained && q) {
        const dot = Math.abs(trained.reduce((s, v, i) => s + v * q[i], 0)), deg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
        if (deg > 8) { text += ` · calibration differs from the model's by ${Math.round(deg)}°, answers may be off`; cls = 'warn'; }
      }
    }
    n.className = 'ustatus ' + cls; fill(n, text, action ? ' ' : '', action);
  }

  private paintTally(): void {
    const n = this.nodes.tally; if (!n) return;
    n.replaceChildren(...TARGETS.map((t) => el('span', { class: `tchip ${STROKES[t].cls}` }, el('b', {}, STROKES[t].code), ` ${STROKES[t].name} `, el('span', { class: 'num' }, String(this.tally[t] ?? 0)))));
  }

  private paintAnswer(flash: boolean): void {
    const n = this.nodes.answer; if (!n) return;
    const r = this.results[0];
    n.className = 'uanswer';
    if (!r) {
      n.replaceChildren(el('div', { class: 'uname idle' }, this.d.link.ready ? 'Play a stroke' : 'No glove yet'),
        el('p', { class: 'usub' }, this.d.link.ready ? 'The answer shows about 0.2 s after the swing.' : 'Connect and calibrate the glove in Train.'));
      return;
    }
    let name: string, cls: string, sub: HTMLElement | string, conf: HTMLElement | null = null;
    if (r.status !== 'ok') { name = 'Missed it'; cls = 'no'; sub = r.status === 'gap' ? 'Packets were lost around that swing, so it was skipped.' : 'That swing came too early after connecting.'; }
    else if (r.label === 'none') { name = 'Not a stroke'; cls = 'no'; sub = `Movement the detector caught (${pct(r.confidence)} sure it is not a stroke).`; }
    else if (!r.confident) { name = 'Unsure'; cls = 'unsure'; sub = `Leaning ${STROKES[r.label!].name} · ${pct(r.confidence)}`; }
    else { name = STROKES[r.label!].name; cls = STROKES[r.label!].cls; sub = `${pct(r.confidence)} sure`; }
    if (r.status === 'ok' && r.label !== 'none') {
      conf = el('div', { class: 'cbar', 'aria-hidden': 'true' }, el('i', { style: `width:${r.confidence * 100}%` }), el('u', { style: `left:${this.unsure * 100}%` }));
    }
    const verdict = r.verdict ? el('div', { class: `uverdict ${r.verdict}` }, icon(r.verdict === 'match' ? 'match' : r.verdict === 'wrong' ? 'wrong' : 'unsure'),
      r.verdict === 'match' ? 'Match' : r.verdict === 'wrong' ? `Wrong stroke · aimed for ${STROKES[this.target].name}` : 'Too unsure to score') : null;
    const intensity = r.status === 'ok' && r.label !== 'none'
      ? el('div', { class: 'uint' }, el('span', {}, 'Swing intensity '), el('span', { class: 'num' }, r.rank === null ? r.peakEnergy.toFixed(2) : `harder than ${pct(r.rank)} of your last ${Math.min(RECENT, this.results.filter((x) => x.status === 'ok' && x.label !== 'none').length - 1)}`),
          el('div', { class: 'ibar', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.min(100, (r.peakEnergy / Math.max(r.peakEnergy, ...this.results.slice(0, RECENT).filter((x) => x.status === 'ok' && x.label !== 'none').map((x) => x.peakEnergy))) * 100)}%` })))
      : null;
    n.className = `uanswer ${cls}`;
    fill(n, el('div', { class: 'uname', role: 'status' }, name), el('p', { class: 'usub' }, sub), conf, verdict, intensity);
    if (flash) { n.classList.remove('land'); void n.offsetWidth; n.classList.add('land'); }
  }

  private paintTape(): void {
    const n = this.nodes.tape; if (!n) return;
    if (!this.results.length) { n.replaceChildren(el('li', { class: 'tape-empty' }, 'Strokes appear here, newest first.')); return; }
    const maxE = Math.max(0.5, ...this.results.slice(0, SHOWN).filter((x) => x.status === 'ok' && x.label !== 'none').map((x) => x.peakEnergy));
    n.replaceChildren(...this.results.slice(0, SHOWN).map((r) => {
      const known = r.status === 'ok';
      const key = known ? (r.confident || r.label === 'none' ? r.label! : 'unsure') : 'none', meta = STROKES[known && r.confident ? r.label! : 'none'];
      const label = !known ? 'Missed (data gap)' : r.label === 'none' ? 'Not a stroke' : r.confident ? meta.name : `Unsure, maybe ${STROKES[r.label!].name}`;
      return el('li', { class: `trow ${key === 'unsure' ? 'unsure' : STROKES[key].cls}` },
        el('span', { class: 'ttime num' }, new Date(r.wallMs).toLocaleTimeString([], { hour12: false })),
        el('span', { class: 'tcode' }, known && r.label !== 'none' ? (r.confident ? STROKES[r.label!].code : '?') : '–'),
        el('span', { class: 'tname' }, label),
        el('span', { class: 'tconf num' }, known && r.label !== 'none' ? pct(r.confidence) : ''),
        el('span', { class: 'tint', 'aria-hidden': 'true' }, known && r.label !== 'none' ? el('i', { style: `width:${Math.min(100, (r.peakEnergy / maxE) * 100)}%` }) : null),
        r.verdict ? el('span', { class: `tverdict ${r.verdict}`, title: r.verdict }, icon(r.verdict === 'match' ? 'match' : r.verdict === 'wrong' ? 'wrong' : 'unsure')) : el('span', { class: 'tverdict' }));
    }));
  }

  private paintDrill(): void {
    const n = this.nodes.drill; if (!n || this.mode !== 'drill') return;
    const m = this.marks, hits = m.filter((v) => v === 'match').length;
    n.replaceChildren(
      el('div', { class: 'uhit' }, el('b', { class: 'num' }, m.length ? pct(hits / m.length) : '–'), el('span', {}, ` hit rate · ${hits} of ${m.length} strokes matched ${STROKES[this.target].name}`)),
      el('div', { class: 'umarks', 'aria-label': 'Drill results, oldest first' }, ...m.slice(-40).map((v) => el('span', { class: `mk ${v}`, title: v }, icon(v === 'match' ? 'match' : v === 'wrong' ? 'wrong' : 'unsure')))),
      el('p', { class: 'sub' }, `Aim for ${STROKES[this.target].name}. Keys 1 to 4 change the target. Strokes below your “sure” level count as unsure, not as a hit.`));
  }
}
