// The Game section: a table-tennis rally against a robot, played with the glove (or keys 1-4 without it).
// The incoming ball tells you which stroke to play; the glove's stroke classifier says which one you played. Rules live in game/engine.ts,
// the picture in game/scene.ts; this file is the DOM around them (menu, scoreboard, popups) and the glove plumbing.
import detectorJson from '../config/detector.json';
import { el } from './dom';
import type { DetectorConfig } from './detector';
import { GameEngine, MATCH_POINTS, type GameEvent, type Swing } from './game/engine';
import { GameView, STROKE_CODE, STROKE_COLOR, STROKE_NAME } from './game/scene';
import { LEVELS, STROKES, type Stroke } from './game/shots';
import { isMuted, setMuted, sfx } from './game/sfx';
import { sensorToThree } from './hand';
import type { GloveLink } from './link';
import { LiveClassifier, type LiveResult, type Mode } from './ml/liveClassifier';
import { loadModel, type CompactModel } from './ml/xgb';
import { parsePacket } from './protocol';

const NAME = STROKE_NAME;
const KEYS: Record<string, Stroke> = { '1': 'forehand_drive', '2': 'backhand_drive', '3': 'smash', '4': 'push' };
const MIN_CONF = 0.45;     // below this the glove's answer is treated as "a swing, but unreadable" (a mishit)
const HEX = (n: number) => '#' + n.toString(16).padStart(6, '0');

const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };

export interface GameDeps {
  link: GloveLink;
  recording: () => boolean;
  gotoTrain: () => void;
}

export class GameScreen {
  readonly root = el('div', { class: 'game' });
  private view: GameView;
  private engine: GameEngine;
  private lc: LiveClassifier | null = null;
  private models: Record<Mode, CompactModel> | null = null;
  private loadError = '';
  private cfg: DetectorConfig = detectorJson as DetectorConfig;
  private active = false;
  private streamAsked = 0;
  private lastWall = 0;
  private energies: number[] = [];
  private levelIndex = Math.min(LEVELS.length - 1, Math.max(0, Number(stored('gameLevel', '0')) || 0));
  private best: Record<string, number> = (() => { try { return JSON.parse(stored('gameBest', '{}')); } catch { return {}; } })();
  private hand: 'left' | 'right' = 'left';
  private n: { score?: HTMLElement; combo?: HTMLElement; board?: HTMLElement; cue?: HTMLElement; pops?: HTMLElement; status?: HTMLElement; menu?: HTMLElement; stage?: HTMLElement } = {};
  private lastPhase = '';
  private overAt = 0;

  constructor(private readonly d: GameDeps) {
    this.hand = stored('hand', 'left') === 'right' ? 'right' : 'left';
    this.engine = new GameEngine(this.hand === 'right' ? 1 : -1);
    this.view = new GameView(this.hand === 'right' ? 1 : -1);
    this.view.bind(this.engine);
    this.view.onFrame = (now) => this.frame(now);
    this.build();
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const [fast, accurate] = await Promise.all([loadModel('/models/stroke_live160.json'), loadModel('/models/stroke_live320.json')]);
      this.models = { fast, accurate };
      this.lc = new LiveClassifier(this.models, this.cfg);
      this.lc.mode = stored('useSpeed', 'fast') === 'accurate' ? 'accurate' : 'fast';
      this.lc.onResult = (r) => this.onResult(r);
    } catch (e) { this.loadError = `The stroke model could not be loaded (${String((e as Error).message)}). Keys 1 to 4 still work.`; }
    this.paintStatus();
  }

  // ---------------------------------------------------------------- lifecycle
  activate(): void {
    this.active = true;
    const h = stored('hand', 'left') === 'right' ? 'right' : 'left';
    if (h !== this.hand) { this.hand = h; this.view.setHanded(h); }
    this.engine = new GameEngine(this.hand === 'right' ? 1 : -1); this.view.bind(this.engine);
    this.lastPhase = ''; this.energies = [];
    this.view.start(); this.ensureStream(true); this.build();
  }
  deactivate(): void { this.active = false; this.view.stop(); if (!this.d.recording()) this.d.link.stopStream(); this.lc?.reset(); this.streamAsked = 0; }
  ensureStream(force = false): void {
    if (!this.active || !this.d.link.ready || this.d.recording()) return;
    if (!this.d.link.relay?.streaming && (force || Date.now() - this.streamAsked > 3000)) { this.streamAsked = Date.now(); this.d.link.startStream(); }
  }
  tick(): void { this.ensureStream(); this.paintStatus(); }

  feed(buf: ArrayBuffer): void {
    if (!this.active) return;
    let p; try { p = parsePacket(buf); } catch { return; }
    const now = Date.now();
    if (this.lc) for (const rec of p.imu) this.lc.push(rec, p.header.bootId, now);
    const last = p.imu[p.imu.length - 1];
    if (last) { this.view.setGlove(sensorToThree(last.q), performance.now()); this.lastWall = now; }
  }

  onKey(e: KeyboardEvent): void {
    if (!this.active || (e.target as HTMLElement)?.matches?.('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { this.engine.phase = 'ready'; this.build(); return; }
    if (k === 'c') { this.view.recenter(); this.pop('Recentred', 'info'); return; }
    if (k === 'm') { setMuted(!isMuted()); this.paintStatus(); return; }
    if (e.code === 'Space' || k === 'enter') { if (this.engine.phase === 'ready' || this.engine.phase === 'over') { e.preventDefault(); this.startMatch(); } return; }
    const s = KEYS[k];
    if (s && !e.repeat) this.keyStroke(s);
  }

  // ---------------------------------------------------------------- input
  private keyStroke(stroke: Stroke): void {
    const now = performance.now();
    this.view.keySwing(stroke);
    // a key press is the classifier's answer; the swing is taken to peak at the press
    this.engine.swing({ peakMs: now, stroke, confidence: 0.9, power: 0.55, aim: { dx: 0, dz: 0 } }, now);
  }

  private onResult(r: LiveResult): void {
    if (!this.active) return;
    const wallNow = Date.now(), perfNow = performance.now();
    const peakWall = r.wallMs - (r.tClassUs - r.tPeakUs) / 1000;
    const peakMs = peakWall - wallNow + perfNow;
    let power = 0.5;
    if (r.status === 'ok' && r.label !== 'none') {
      const past = this.energies.slice(0, 20); if (past.length >= 5) power = past.filter((x) => x < r.peakEnergy).length / past.length;
      this.energies.unshift(r.peakEnergy);
    }
    const readable = r.status === 'ok' && r.label !== 'none' && r.confidence >= MIN_CONF && STROKES.includes(r.label as Stroke);
    const e = this.engine;
    if ((e.phase === 'ready' || (e.phase === 'over' && perfNow - this.overAt > 2500)) && readable) { this.startMatch(); return; } // swing to start: no keyboard or mouse needed with the glove
    const s: Swing = { peakMs, stroke: readable ? (r.label as Stroke) : null, confidence: readable ? r.confidence : 0, power: Math.min(1, Math.max(0, power)), aim: { dx: 0, dz: 0 } };
    this.engine.swing(s, perfNow);
  }

  // ---------------------------------------------------------------- the frame
  private frame(now: number): void {
    const e = this.engine;
    e.update(now);
    for (const ev of e.drain()) { this.view.onEvent(ev, now); this.react(ev); }
    if (e.phase !== this.lastPhase) { this.lastPhase = e.phase; this.paintMenu(); }
    this.paintHud();
  }

  private react(ev: GameEvent): void {
    switch (ev.t) {
      case 'serve-wait': this.pop(this.engine.score.you + this.engine.score.opp === 0 ? 'Get ready' : 'Next ball', 'info'); break;
      case 'incoming': if (!ev.faulty) this.paintCue(ev.inc.required); break;
      case 'bounce': sfx.bounce(); break;
      case 'contact-open': this.pop('SWING!', 'now'); break;
      case 'player-hit': {
        sfx.hit(ev.stroke === 'smash'); if (ev.grade === 'perfect') sfx.perfect();
        const t = ev.mishit ? 'MISHIT' : ev.grade === 'perfect' ? 'PERFECT' : ev.grade === 'great' ? 'GREAT' : ev.grade === 'ok' ? 'GOOD' : ev.grade === 'early' ? 'EARLY' : 'LATE';
        this.pop(`${t}  +${ev.points}`, ev.mishit ? 'bad' : ev.grade === 'perfect' ? 'gold' : 'ok');
        if (ev.match < 1 && !ev.mishit) this.pop(`${NAME[ev.required]} was called`, 'sub');
        this.paintCue(null); break;
      }
      case 'fault': sfx.fault(); this.pop(`${ev.who === 'opp' ? 'Opponent: ' : ''}${ev.why === 'net' ? 'NET' : ev.why === 'out' ? 'OUT' : 'SHORT'}!`, ev.who === 'opp' ? 'ok' : 'bad'); break;
      case 'point':
        if (ev.winner === 'player') sfx.point(); else sfx.lost();
        this.pop(ev.winner === 'player' ? `POINT  +${ev.bonus}` : ev.why === 'late' ? 'TOO LATE' : ev.why === 'player-miss' ? 'MISSED' : 'POINT TO THEM', ev.winner === 'player' ? 'gold' : 'bad'); this.paintCue(null); break;
      case 'match-over': this.overAt = performance.now(); if (ev.won) sfx.win(); else sfx.lose(); this.finish(); break;
      case 'swing-wasted': this.pop('swing outside the window', 'sub'); break;
    }
  }

  private finish(): void {
    const e = this.engine, key = String(this.levelIndex);
    if (e.arcade > (this.best[key] ?? 0)) { this.best[key] = e.arcade; save('gameBest', JSON.stringify(this.best)); }
  }

  // ---------------------------------------------------------------- DOM
  private pop(text: string, cls: string): void {
    const p = this.n.pops; if (!p) return;
    const d = el('div', { class: `gpop ${cls}` }, text); p.append(d);
    while (p.children.length > 4) p.firstElementChild?.remove();
    setTimeout(() => d.remove(), cls === 'sub' ? 1400 : 1100);
  }

  private build(): void {
    this.n.score = el('div', { class: 'gscore' });
    this.n.combo = el('div', { class: 'gcombo' });
    this.n.board = el('div', { class: 'gboard' });
    this.n.cue = el('div', { class: 'gcue' });
    this.n.pops = el('div', { class: 'gpops', 'aria-live': 'polite' });
    this.n.status = el('div', { class: 'gstatus' });
    this.n.menu = el('div', { class: 'gmenu' });
    this.n.stage = el('div', { class: 'gstage' }, this.view.el,
      el('div', { class: 'ghud' }, this.n.board, this.n.cue, this.n.score, this.n.combo), this.n.pops, this.n.menu, this.n.status);
    this.root.replaceChildren(this.n.stage);
    this.paintMenu(); this.paintHud(); this.paintStatus();
  }

  private startMatch(): void {
    sfx.unlock(); save('gameLevel', String(this.levelIndex));
    this.engine = new GameEngine(this.hand === 'right' ? 1 : -1); this.view.bind(this.engine);
    this.view.recenter(); this.energies = [];
    this.engine.start(this.levelIndex, performance.now());
    this.lastPhase = ''; this.paintMenu();
  }

  private paintMenu(): void {
    const m = this.n.menu; if (!m) return;
    const e = this.engine, show = e.phase === 'ready' || e.phase === 'over';
    m.hidden = !show; if (!show) return;
    const over = e.phase === 'over';
    const lv = LEVELS.map((l, i) => el('button', { class: 'glevel' + (i === this.levelIndex ? ' on' : ''), 'aria-pressed': String(i === this.levelIndex), onclick: () => { this.levelIndex = i; this.paintMenu(); } },
      el('b', {}, `${i + 1} · ${l.name}`), el('span', {}, l.blurb), el('em', {}, this.best[String(i)] ? `best ${this.best[String(i)]}` : 'not played')));
    const won = e.score.you > e.score.opp;
    const acc = e.hits ? Math.round((100 * e.right) / e.hits) : 0;
    m.replaceChildren(el('div', { class: 'gcard' },
      over
        ? el('div', { class: 'gresult' }, el('h2', {}, won ? 'You win!' : 'You lose'), el('p', { class: 'gbig' }, `${e.score.you} – ${e.score.opp}`),
            el('p', {}, `Score ${e.arcade} · best combo ${e.bestCombo} · right stroke ${acc}% of ${e.hits} returns`),
            won && this.levelIndex < LEVELS.length - 1 ? el('button', { class: 'primary', onclick: () => { this.levelIndex++; this.startMatch(); } }, `Next: ${LEVELS[this.levelIndex + 1].name}`) : null)
        : el('div', {}, el('h2', {}, 'Table tennis'), el('p', {}, `First to ${MATCH_POINTS} points. The ball shows which stroke to play: `, ...STROKES.map((s) => el('b', { style: `color:${HEX(STROKE_COLOR[s])};margin-right:.5em` }, `${STROKE_CODE[s]} ${NAME[s]}`)),
            '. Swing as the ball reaches your paddle; the ball waits a moment for the glove to read your stroke. The right stroke on time scores most.')),
      el('div', { class: 'glevels' }, ...lv),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => this.startMatch() }, over ? 'Play again (Space)' : 'Start (Space)'),
        el('button', { onclick: () => { this.view.recenter(); this.pop('Recentred', 'info'); } }, 'Recentre paddle (C)')),
      el('p', { class: 'sub' }, 'With the glove: hold the paddle up facing the opponent and swing any stroke to start; press C to recentre. No glove (testing): Space starts, keys 1 to 4 play Forehand, Backhand, Smash, Push.')));
  }

  private paintCue(s: Stroke | null): void {
    const c = this.n.cue; if (!c) return;
    c.replaceChildren(...(s ? [el('span', { class: 'gchip', style: `--c:${HEX(STROKE_COLOR[s])}` }, el('b', {}, STROKE_CODE[s]), ' ', NAME[s])] : []));
  }

  private paintHud(): void {
    const e = this.engine;
    if (this.n.board) {
      const h = `<b>You</b> <span class="gnum">${e.score.you} – ${e.score.opp}</span> <b>${LEVELS[this.levelIndex].name}</b>`;
      if (this.n.board.dataset.h !== h) { this.n.board.dataset.h = h; this.n.board.innerHTML = h; }
    }
    if (this.n.score) this.n.score.textContent = `${e.arcade} pts`;
    if (this.n.combo) this.n.combo.textContent = e.combo >= 2 ? `combo ×${e.combo}` : '';
  }

  private paintStatus(): void {
    const n = this.n.status; if (!n) return;
    const r = this.d.link.relay, now = Date.now();
    let t = '', cls = 'sub';
    if (this.loadError) { t = this.loadError; cls = 'warn'; }
    else if (!r || r.glove !== 'open') { t = 'No glove: play with keys 1 2 3 4'; cls = 'warn'; }
    else if (!this.lastWall || now - this.lastWall > 2000) { t = 'Glove connected, waiting for data…'; cls = 'warn'; }
    else t = `Glove live · ${this.view.arenaSource === 'stand-in' ? 'plain arena · ' : ''}C recentres the paddle`;
    t += isMuted() ? ' · muted (M)' : ' · M mutes';
    if (n.textContent !== t) n.textContent = t;
    n.className = 'gstatus ' + cls;
  }
}
