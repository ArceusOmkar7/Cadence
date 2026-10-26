// The game's 3D view: arena (the Blender model, or a plain stand-in if it cannot load), ball, your gloved hand and paddle, the opponent.
// Reads the engine every frame and reacts to its events; contains no rules.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GRIP, PADDLE_CENTER, applyCurl, attachPaddle, buildHand, buildPaddle, readyQuat } from '../hand';
import { BALL_R, TABLE } from './physics';
import type { GameEngine, GameEvent } from './engine';
import type { Stroke } from './shots';

export const STROKE_COLOR: Record<Stroke, number> = { forehand_drive: 0x4f9dff, backhand_drive: 0x2dd4bf, smash: 0xff7a45, push: 0xb396ff };
export const STROKE_CODE: Record<Stroke, string> = { forehand_drive: 'FH', backhand_drive: 'BH', smash: 'SM', push: 'PU' };
export const STROKE_NAME: Record<Stroke, string> = { forehand_drive: 'Forehand', backhand_drive: 'Backhand', smash: 'Smash', push: 'Push' };
const BALL_VIS = 1.7;      // the real ball is 40 mm: drawn bigger so it can be followed from the back of the room
const IDLE_POS = new THREE.Vector3(0, 1.02, 1.85);
const TRAIL = 28;

const basis = (x: number[], y: number[], z: number[]) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)));
/** hand frame -> world for the handshake grip: blade up, red forehand face looking at the opponent (see hand.ts). A right hand is the mirrored model. */
const READY_LEFT = readyQuat(false);
const READY_RIGHT = readyQuat(true);
const ease = (u: number) => u * u * (3 - 2 * u);

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }
/** the name of the stroke to play, as a pill that floats over the landing spot (the full word, not a code) */
function label(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 400; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b1622f2'; g.beginPath(); g.roundRect(8, 8, 384, 112, 56); g.fill();
  g.lineWidth = 8; g.strokeStyle = hex(color); g.shadowColor = hex(color); g.shadowBlur = 18; g.stroke();
  g.shadowBlur = 0; g.fillStyle = hex(color); g.font = '800 62px "Segoe UI", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 200, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); s.scale.set(0.5, 0.16, 1); s.renderOrder = 10;
  return s;
}
let glowTexture: THREE.CanvasTexture | null = null;
/** a soft round glow (additive), tinted per use: the cheap way to get a bloom look around the shot circles */
function glow(): THREE.Sprite {
  if (!glowTexture) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    glowTexture = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })); s.renderOrder = 7; s.visible = false;
  return s;
}

interface Pulse { mesh: THREE.Mesh; t0: number; dur: number; from: number; to: number }

export class GameView {
  readonly el = document.createElement('div');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.05, 40);
  private ro: ResizeObserver;
  private raf = 0;
  private last = performance.now();
  private running = false;
  private ball: THREE.Mesh;
  private blob: THREE.Mesh;
  private trail: THREE.InstancedMesh;
  private trailPts: THREE.Vector3[] = [];
  private tmp = new THREE.Object3D();
  private trailColor = new THREE.Color(0xffffff);
  private player = buildHand();
  private playerPaddle = buildPaddle();
  private playerPos = IDLE_POS.clone();
  private ready = READY_LEFT;
  private glove: THREE.Quaternion | null = null;
  private gloveAt = 0;
  private ref = new THREE.Quaternion();
  private haveRef = false;
  private cur = new THREE.Quaternion();
  private kb: { t0: number; stroke: Stroke } | null = null;
  private opp = new THREE.Group();
  private oppArm = new THREE.Group();
  private oppSwing = -10;
  private oppX = 0;
  private landing: THREE.Mesh;
  private landingLabels: Record<Stroke, THREE.Sprite>;
  private strikeRing: THREE.Mesh;
  private approach: THREE.Mesh;
  private strikeGlow = glow();
  private landGlow = glow();
  private pulses: Pulse[] = [];
  private shake = 0;
  private fov = 48;
  private cueStroke: Stroke | null = null;
  private cueLanded = false;
  private arena = new THREE.Group();
  arenaSource: 'loading' | 'blender' | 'stand-in' = 'loading';

  constructor(private fhSign: number) {
    this.el.className = 'gamecanvas';
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0a121c); this.scene.fog = new THREE.Fog(0x0a121c, 9, 22);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; this.scene.environmentIntensity = 0.55; pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x1a2a3a, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1.5, 4.2, 2.2); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3.5, bottom: -3.5, near: 0.5, far: 12 }); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.scene.add(this.arena);
    void this.loadArena();

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * BALL_VIS, 24, 16), new THREE.MeshStandardMaterial({ color: 0xfff6e8, roughness: 0.35, emissive: 0x6b5a3a, emissiveIntensity: 0.6 }));
    this.ball.castShadow = true; this.ball.visible = false; this.scene.add(this.ball);
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.035, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; this.blob.visible = false; this.scene.add(this.blob);
    this.trail = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }), TRAIL);
    this.trail.frustumCulled = false; this.trail.visible = false; this.scene.add(this.trail);

    this.landing = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.11, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    this.landing.rotation.x = -Math.PI / 2; this.landing.visible = false; this.scene.add(this.landing);
    this.landingLabels = Object.fromEntries((Object.keys(STROKE_COLOR) as Stroke[]).map((s) => { const l = label(STROKE_NAME[s], STROKE_COLOR[s]); l.visible = false; this.scene.add(l); return [s, l]; })) as Record<Stroke, THREE.Sprite>;
    this.strikeRing = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.17, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
    this.strikeRing.renderOrder = 9; this.scene.add(this.strikeRing);
    this.approach = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.162, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
    this.approach.renderOrder = 9; this.approach.visible = false; this.scene.add(this.approach, this.strikeGlow, this.landGlow);

    this.buildPlayer(); this.buildOpponent();
    this.setHanded(fhSign > 0 ? 'right' : 'left');
    this.placeCamera();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.el);
  }

  // ---------------------------------------------------------------- building
  private async loadArena(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync('/models/arena.glb');
      const root = gltf.scene;
      const tint: Record<string, number> = { Carpet: 0x123a47, FloorTeal: 0x0b2630, Wall: 0x2b3747, Ceiling: 0x1d2632 }; // the room is a backdrop: darker than the Blender export so the table and ball pop
      root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return;
        for (const mat of ([] as THREE.Material[]).concat(m.material)) { const t = tint[mat.name]; if (t !== undefined && (mat as THREE.MeshStandardMaterial).color) (mat as THREE.MeshStandardMaterial).color.setHex(t); } m.castShadow = !/^(Floor|Carpet|Wall|Ceiling|LightBar)/.test(m.name); m.receiveShadow = true; });
      const top = root.getObjectByName('Table_Top'), box = top ? new THREE.Box3().setFromObject(top) : null;
      if (box && Math.abs(box.max.y - TABLE.top) > 0.003) root.position.y += TABLE.top - box.max.y; // the physics owns the table height
      this.arena.add(root); this.arenaSource = 'blender';
    } catch (e) {
      console.warn('arena.glb not loaded, using the stand-in arena:', e);
      this.arena.add(this.standIn()); this.arenaSource = 'stand-in';
    }
  }

  private standIn(): THREE.Group {
    const g = new THREE.Group(), std = (c: number, r = 0.6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 16), std(0x1d3b4a, 0.9)); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);
    box(TABLE.hw * 2, 0.025, TABLE.hl * 2, std(0x0b3a78, 0.4), 0, TABLE.top - 0.0125, 0);
    box(TABLE.hw * 2, 0.0005, 0.02, std(0xffffff), 0, TABLE.top + 0.0005, TABLE.hl - 0.01); box(TABLE.hw * 2, 0.0005, 0.02, std(0xffffff), 0, TABLE.top + 0.0005, -TABLE.hl + 0.01);
    box(0.003, 0.0005, TABLE.hl * 2, std(0xffffff), 0, TABLE.top + 0.0005, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.05, TABLE.top - 0.03, 0.05, std(0x333a44, 0.5, 0.8), sx * 0.68, (TABLE.top - 0.03) / 2, sz * 1.25);
    box(1.83, 0.1525, 0.004, new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.6 }), 0, TABLE.top + 0.0762, 0);
    box(1.83, 0.012, 0.006, std(0xffffff), 0, TABLE.netTop, 0);
    for (const s of [-1, 1]) box(0.03, 0.18, 0.03, std(0x111111), s * 0.93, TABLE.top + 0.09, 0);
    return g;
  }

  private buildPlayer(): void {
    const h = this.player;
    attachPaddle(h.model, this.playerPaddle); applyCurl(h, GRIP);
    this.scene.add(h.root);
  }

  private buildOpponent(): void {
    const body = new THREE.MeshPhysicalMaterial({ color: 0x1b2a3d, roughness: 0.45, metalness: 0.5, clearcoat: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: 0x35e0ff });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 6, 16), body); torso.position.y = 1.0;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 16), new THREE.MeshPhysicalMaterial({ color: 0xe9eef5, roughness: 0.3, clearcoat: 0.8 })); head.position.y = 1.52;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.04, 0.05), glow); visor.position.set(0, 1.54, 0.1);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.12, 24), body); base.position.y = 0.06;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.02), glow); chest.position.set(0, 1.1, 0.165);
    this.oppArm.position.set(0.22, 1.2, 0.02);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.34, 4, 10), body); arm.rotation.x = Math.PI / 2; arm.position.set(0, 0, 0.2);
    const paddle = buildPaddle(); paddle.scale.setScalar(1.15);
    // hand frame -> arm frame: blade up, face to the player (+z)
    paddle.quaternion.copy(basis([0, 0, 1], [-1, 0, 0], [0, -1, 0])); paddle.position.set(0, -0.02, 0.4); // blade up, red face towards the player
    this.oppArm.add(arm, paddle);
    this.opp.add(torso, head, visor, base, chest, this.oppArm);
    this.opp.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    this.opp.position.set(0, 0, -2.2);
    this.scene.add(this.opp);
  }

  setHanded(hand: 'left' | 'right'): void { this.fhSign = hand === 'right' ? 1 : -1; this.player.model.scale.x = hand === 'right' ? -1 : 1; this.ready = hand === 'right' ? READY_RIGHT : READY_LEFT; }

  // ---------------------------------------------------------------- input from the glove
  /** q: the glove's sensor quaternion as a three.js quaternion (see sensorToThree). */
  setGlove(q: THREE.Quaternion, nowMs: number): void { this.glove = q.clone(); this.gloveAt = nowMs; if (!this.haveRef) this.recenter(); }
  /** The pose you are in right now becomes "paddle up, face to the opponent". */
  recenter(): void { if (this.glove) { this.ref.copy(this.glove).invert(); this.haveRef = true; } }
  get hasGlove(): boolean { return this.glove !== null && performance.now() - this.gloveAt < 1500; }
  /** a swing animated for keyboard play (no glove) */
  keySwing(stroke: Stroke): void { this.kb = { t0: performance.now(), stroke }; }

  // ---------------------------------------------------------------- loop
  start(): void { if (this.running) return; this.running = true; this.last = performance.now(); const loop = (n: number) => { if (!this.running) return; this.raf = requestAnimationFrame(loop); this.frame(n); }; this.raf = requestAnimationFrame(loop); }
  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }
  dispose(): void { this.stop(); this.ro.disconnect(); this.renderer.dispose(); this.el.remove(); }

  private resize(): void {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  private placeCamera(): void { this.camera.position.set(0, 1.62, 3.35); this.camera.lookAt(0, 0.78, -0.45); }

  private engine: GameEngine | null = null;
  /** called at the start of every frame: the screen advances the engine and hands events back through onEvent */
  onFrame: ((now: number) => void) | null = null;
  bind(e: GameEngine): void { this.engine = e; }

  /** React to an engine event: the 3D side of it (rings, camera, opponent swing). */
  onEvent(ev: GameEvent, now: number): void {
    const e = this.engine; if (!e) return;
    switch (ev.t) {
      case 'incoming': {
        this.cueStroke = ev.inc.required; this.cueLanded = false; this.oppSwing = now; this.oppX = ev.inc.ball.x;
        this.trailColor.set(0xdfe6ee);
        break;
      }
      case 'bounce': this.pulse(ev.x, TABLE.top + 0.002, ev.z, 0xffffff, 0.05, 0.16, 0.35, true); if (ev.side === 'player') this.cueLanded = true; break;
      case 'player-hit': {
        const p = e.contactPos ?? { x: 0, y: 1, z: 1.6 };
        this.trailColor.set(STROKE_COLOR[ev.stroke]); this.cueStroke = null;
        this.pulse(p.x, p.y, p.z, STROKE_COLOR[ev.stroke], 0.04, ev.grade === 'perfect' ? 0.55 : 0.38, 0.45, false);
        this.shake = ev.stroke === 'smash' ? 0.03 : ev.grade === 'perfect' ? 0.012 : 0.006; this.fov = 48 - (ev.stroke === 'smash' ? 6 : 3);
        break;
      }
      case 'fault': case 'point': this.cueStroke = null; if (ev.t === 'point') this.shake = ev.winner === 'opp' ? 0.02 : 0.008; break;
      default: break;
    }
  }

  private pulse(x: number, y: number, z: number, color: number, from: number, to: number, dur: number, flat: boolean): void {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.position.set(x, y, z); if (flat) m.rotation.x = -Math.PI / 2; else m.renderOrder = 8;
    m.scale.setScalar(from); this.scene.add(m); this.pulses.push({ mesh: m, t0: performance.now(), dur: dur * 1000, from, to });
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    this.onFrame?.(now);
    const e = this.engine;
    if (e) { this.updateBall(e, dt); this.updatePlayer(e, now, dt); this.updateOpponent(e, now, dt); this.updateCue(e, now); }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i], u = (now - p.t0) / p.dur;
      if (u >= 1) { this.scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); this.pulses.splice(i, 1); continue; }
      p.mesh.scale.setScalar(p.from + (p.to - p.from) * (1 - (1 - u) * (1 - u))); (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - u);
      if (!(p.mesh.rotation.x === -Math.PI / 2)) p.mesh.lookAt(this.camera.position);
    }
    // camera: a little parallax towards the ball, a shake and an FOV punch on hits
    this.shake *= Math.exp(-dt / 0.12); this.fov += (48 - this.fov) * (1 - Math.exp(-dt / 0.15));
    const bx = e?.ball ? e.ball.x : 0;
    this.camera.position.set(this.camera.position.x + (bx * 0.22 - this.camera.position.x) * (1 - Math.exp(-dt / 0.4)) + (Math.random() - 0.5) * this.shake, 1.62 + (Math.random() - 0.5) * this.shake, 3.35);
    this.camera.lookAt(this.camera.position.x * 0.5, 0.78, -0.45);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
    this.renderer.render(this.scene, this.camera);
  }

  private updateBall(e: GameEngine, dt: number): void {
    const b = e.ball;
    this.ball.visible = !!b && e.phase !== 'serving' && e.phase !== 'over'; this.trail.visible = this.ball.visible;
    if (!b || !this.ball.visible) { this.blob.visible = false; this.trailPts = []; return; }
    this.ball.position.set(b.x, b.y, b.z);
    const over = Math.abs(b.x) < TABLE.hw && Math.abs(b.z) < TABLE.hl && b.y > TABLE.top;
    this.blob.visible = over; if (over) { this.blob.position.set(b.x, TABLE.top + 0.002, b.z); (this.blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.1, 0.45 - (b.y - TABLE.top) * 0.25); this.blob.scale.setScalar(1 + (b.y - TABLE.top) * 0.4); }
    if (!e.frozen) { this.trailPts.unshift(new THREE.Vector3(b.x, b.y, b.z)); if (this.trailPts.length > TRAIL) this.trailPts.length = TRAIL; }
    const bg = new THREE.Color(0x0a121c), c = new THREE.Color();
    for (let i = 0; i < TRAIL; i++) {
      const p = this.trailPts[Math.min(i, Math.max(0, this.trailPts.length - 1))] ?? this.ball.position, a = i / TRAIL;
      this.tmp.position.copy(p); this.tmp.scale.setScalar(Math.max(0.1, 1 - a)); this.tmp.updateMatrix(); this.trail.setMatrixAt(i, this.tmp.matrix);
      c.copy(this.trailColor).lerp(bg, Math.min(1, a * 1.1)); this.trail.setColorAt(i, c);
    }
    this.trail.instanceMatrix.needsUpdate = true; if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
    void dt;
  }

  private updatePlayer(e: GameEngine, now: number, dt: number): void {
    // where the paddle waits: at the strike point of the incoming ball, or at rest
    let target = IDLE_POS;
    if (e.phase === 'contact' && e.contactPos) target = new THREE.Vector3(e.contactPos.x, e.contactPos.y, e.contactPos.z);
    else if (e.incoming && e.hitter === 'opp' && e.phase === 'rally') target = new THREE.Vector3(e.incoming.strike.x, e.incoming.strike.y, e.incoming.strike.z);
    this.playerPos.lerp(target, 1 - Math.exp(-dt / (e.incoming ? 0.12 : 0.3)));
    // orientation: the glove, relative to the pose you recentred in; or a canned swing for keyboard play
    const want = new THREE.Quaternion();
    if (this.hasGlove && this.haveRef) want.copy(this.glove!).multiply(this.ref).multiply(this.ready);
    else {
      want.copy(this.ready);
      if (this.kb) {
        const u = (now - this.kb.t0) / 700;
        if (u >= 1) this.kb = null;
        else {
          const k = u < 0.35 ? ease(u / 0.35) : 1 - ease((u - 0.35) / 0.65); // out fast, back slowly
          const s = this.kb.stroke, sign = s === 'forehand_drive' ? this.fhSign : s === 'backhand_drive' ? -this.fhSign : 0;
          if (s === 'backhand_drive') want.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * ease(Math.min(1, u / 0.12)) * (u < 0.55 ? 1 : 1 - ease((u - 0.55) / 0.45)))); // wrist turn: the black face goes to the front
          const swing = s === 'smash' ? new THREE.Euler(-1.1 + 2.1 * k, 0, 0) : s === 'push' ? new THREE.Euler(-0.1 + 0.55 * k, 0, 0) : new THREE.Euler(0.15, sign * (0.9 - 1.7 * k), 0);
          want.premultiply(new THREE.Quaternion().setFromEuler(swing));
        }
      }
    }
    this.cur.slerp(want, 1 - Math.exp(-dt / 0.03));
    const h = this.player.root; h.quaternion.copy(this.cur);
    h.position.copy(this.playerPos).sub(PADDLE_CENTER.clone().applyQuaternion(this.cur));
  }

  private updateOpponent(e: GameEngine, now: number, dt: number): void {
    const b = e.ball, chase = b && e.hitter === 'player' ? b.x : (e.phase === 'serving' || !b ? 0 : this.oppX);
    const maxStep = (2.4 + e.levelIndex * 0.5) * dt;
    const goal = Math.max(-1.0, Math.min(1.0, chase * 0.95));
    this.opp.position.x += Math.max(-maxStep, Math.min(maxStep, goal - this.opp.position.x));
    const u = (now - this.oppSwing) / 380;
    this.oppArm.rotation.set(u >= 0 && u < 1 ? -0.9 * Math.sin(u * Math.PI) : 0, u >= 0 && u < 1 ? 0.7 - 1.4 * ease(u) : -0.15, 0);
    this.opp.rotation.y = Math.sin(now / 900) * 0.04;
    void e;
  }

  private updateCue(e: GameEngine, now: number): void {
    const inc = e.incoming, show = !!inc && e.hitter === 'opp' && !!this.cueStroke && (e.phase === 'rally' || e.phase === 'contact');
    const lm = this.landing.material as THREE.MeshBasicMaterial, sm = this.strikeRing.material as THREE.MeshBasicMaterial, am = this.approach.material as THREE.MeshBasicMaterial;
    for (const s of Object.keys(this.landingLabels) as Stroke[]) this.landingLabels[s].visible = false;
    if (!show || !inc) { this.landing.visible = false; sm.opacity = 0; this.approach.visible = false; this.strikeGlow.visible = false; this.landGlow.visible = false; return; }
    const col = STROKE_COLOR[inc.required];
    // where the ball will bounce: a pulsing ring, a glow and the stroke's name
    this.landing.visible = !this.cueLanded; this.landing.position.set(inc.landing.x, TABLE.top + 0.003, inc.landing.z); lm.color.setHex(col);
    this.landing.scale.setScalar(1 + 0.08 * Math.sin(now / 120));
    const lg = this.landGlow.material as THREE.SpriteMaterial;
    this.landGlow.visible = !this.cueLanded; this.landGlow.position.set(inc.landing.x, TABLE.top + 0.02, inc.landing.z); this.landGlow.scale.setScalar(0.36 + 0.04 * Math.sin(now / 120)); lg.color.setHex(col); lg.opacity = 0.7;
    const l = this.landingLabels[inc.required]; l.visible = true; l.position.set(inc.landing.x, TABLE.top + 0.2 + (this.cueLanded ? 0.05 : 0), inc.landing.z);
    // where you will meet it: the target circle with a glow, and (like osu) a bigger circle closing in on it; they meet at the moment to swing
    this.strikeRing.position.set(inc.strike.x, inc.strike.y, inc.strike.z); this.strikeRing.lookAt(this.camera.position);
    this.approach.position.copy(this.strikeRing.position); this.approach.quaternion.copy(this.strikeRing.quaternion);
    const left = Math.max(0, inc.strike.t - e.flightT), k = e.frozen ? 0 : Math.min(1, left / 0.9);
    const beat = e.frozen ? 1 + 0.12 * Math.sin(now / 45) : 1;
    sm.color.setHex(col); sm.opacity = e.frozen ? 1 : 0.55 + 0.15 * Math.sin(now / 150); this.strikeRing.scale.setScalar(beat);
    this.approach.visible = !e.frozen; am.color.setHex(col); am.opacity = 0.25 + 0.7 * (1 - k); this.approach.scale.setScalar(1 + 2.4 * k * k);
    const sg = this.strikeGlow.material as THREE.SpriteMaterial;
    this.strikeGlow.visible = true; this.strikeGlow.position.copy(this.strikeRing.position); sg.color.setHex(col);
    sg.opacity = e.frozen ? 0.95 : 0.35 + 0.35 * (1 - k); this.strikeGlow.scale.setScalar((e.frozen ? 0.8 : 0.55) * beat);
  }
}
