// The glove's 3D hand model, ported from the firmware's web/viewer.html as a module (Three.js from npm, works offline).
// The model is built as a LEFT hand (thumb on +x); a right hand is its mirror image. Units: metres.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const D2R = Math.PI / 180;
const JOINT = { finger: { mcp: 85, pip: 100, dip: 0.67 }, thumb: { yaw: [38, -20], pitch: [10, 40], mcp: 55, ip: 70 } };

function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
/** cylinder from z=0 to z=-len with radius r0 at the base */
function limb(len: number, r0: number, r1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, 16, 1);
  g.rotateX(-Math.PI / 2); g.translate(0, 0, -len / 2);
  return g;
}

export interface HandModel {
  root: THREE.Group; model: THREE.Group; fingers: THREE.Group[][]; thumbRoot: THREE.Group; thumb: THREE.Group[]; press: THREE.Mesh;
}

export function buildHand(): HandModel {
  const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const fabric = new THREE.MeshPhysicalMaterial({ color: 0x2f3742, roughness: 0.78, metalness: 0.02, sheen: 0.9, sheenRoughness: 0.45, sheenColor: new THREE.Color(0x7d8da1) });
  const shell = new THREE.MeshPhysicalMaterial({ color: 0x14171b, roughness: 0.4, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.25 });
  const M = { glove: fabric, box: shell, strip: new THREE.MeshStandardMaterial({ color: 0xe0873f, roughness: 0.4, metalness: 0.3, emissive: 0x7a3a10, emissiveIntensity: 0.35 }), cuff: std(0x20252c, 0.9), cable: std(0x0d0f12, 0.7), led: new THREE.MeshBasicMaterial({ color: 0x37d67a }) };
  const root = new THREE.Group(), model = new THREE.Group();
  root.add(model);
  const slab = new THREE.ExtrudeGeometry(roundRect(0.074, 0.084, 0.014), { depth: 0.014, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 3, curveSegments: 8 });
  slab.rotateX(-Math.PI / 2); slab.center();
  model.add(new THREE.Mesh(slab, M.glove));

  const chain = (parent: THREE.Object3D, lens: number[], r: number, strips: boolean): THREE.Group[] => {
    const js: THREE.Group[] = []; let p: THREE.Object3D = parent;
    lens.forEach((L, i) => {
      const j = new THREE.Group(); if (i > 0) j.position.z = -lens[i - 1];
      p.add(j); js.push(j);
      const r0 = r * (1 - 0.07 * i);
      j.add(new THREE.Mesh(limb(L, r0, r * (1 - 0.07 * (i + 1))), M.glove));
      j.add(new THREE.Mesh(new THREE.SphereGeometry(r0 * 1.02, 16, 12), M.glove));
      if (strips && i < 2) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.0062, 0.0016, L * 0.92), M.strip); s.position.set(0, r0 + 0.0004, -L / 2); j.add(s); }
      p = j;
    });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(r * (1 - 0.07 * lens.length), 16, 12), M.glove);
    tip.position.z = -lens[lens.length - 1]; p.add(tip);
    return js;
  };
  const fingers: THREE.Group[][] = [];
  [
    { x: 0.028, z: -0.044, l: [0.04, 0.023, 0.018], r: 0.0088, s: 5 }, { x: 0.0095, z: -0.047, l: [0.044, 0.027, 0.019], r: 0.009, s: 1 },
    { x: -0.0095, z: -0.045, l: [0.041, 0.025, 0.018], r: 0.0086, s: -3 }, { x: -0.027, z: -0.04, l: [0.032, 0.019, 0.016], r: 0.0075, s: -8 },
  ].forEach((d) => {
    const g = new THREE.Group(); g.position.set(d.x, 0.002, d.z); g.rotation.y = -d.s * D2R; model.add(g);
    fingers.push(chain(g, d.l, d.r, true));
  });
  const thumbRoot = new THREE.Group(); thumbRoot.position.set(0.037, -0.004, 0.014); thumbRoot.rotation.order = 'YXZ'; model.add(thumbRoot);
  const thumb = chain(thumbRoot, [0.04, 0.031, 0.025], 0.0105, false);
  [1, 2].forEach((i) => { const L = [0.04, 0.031, 0.025][i], s = new THREE.Mesh(new THREE.BoxGeometry(0.0062, 0.0016, L * 0.92), M.strip); s.position.set(0, 0.0105 * (1 - 0.07 * i) + 0.0004, -L / 2); thumb[i].add(s); });

  const hb = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.014, 0.036), M.box); hb.position.set(0, 0.019, -0.004); model.add(hb);
  [[-0.018, -0.014], [0.018, -0.014], [-0.018, 0.012], [0.018, 0.012]].forEach(([x, z]) => { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0027, 0.0027, 0.0012, 10), M.strip); s.position.set(x, 0.0266, -0.004 + z); model.add(s); });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 10, 8), M.led); led.position.set(0.014, 0.0265, -0.004); model.add(led);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.07, 28), M.cuff); cuff.rotation.x = Math.PI / 2; cuff.scale.set(1, 1, 0.72); cuff.position.set(0, 0, 0.082); model.add(cuff);
  const fb = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.014, 0.042), M.box); fb.position.set(0, 0.033, 0.085); model.add(fb);
  model.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.021, 0.014), new THREE.Vector3(0, 0.027, 0.036), new THREE.Vector3(0, 0.033, 0.058)]), 16, 0.003, 8), M.cable));
  const press = new THREE.Mesh(new THREE.CircleGeometry(0.017, 32), new THREE.MeshBasicMaterial({ color: 0x4a515c, side: THREE.DoubleSide }));
  press.rotation.x = Math.PI / 2; press.position.set(0, -0.0128, 0); model.add(press);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root, model, fingers, thumbRoot, thumb, press };
}

/**
 * A shakehand table-tennis paddle in its own frame: the handle's centre is the origin, the handle runs along z, the blade lies towards -z,
 * the faces point along +x (red, forehand) and -x (black, backhand).
 */
export function buildPaddle(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshPhysicalMaterial({ color: 0xcf9f66, roughness: 0.5, clearcoat: 0.3 });
  const red = new THREE.MeshPhysicalMaterial({ color: 0xc8232c, roughness: 0.62, clearcoat: 0.25 });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x17191d, roughness: 0.66, clearcoat: 0.25 });
  const blade = (depth: number, rx: number, ry: number) => { const s = new THREE.Shape(); s.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0); const e = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 40 }); e.rotateY(Math.PI / 2); e.translate(-depth / 2, 0, 0); return e; };
  const cz = -PADDLE_BLADE_Z;
  const core = new THREE.Mesh(blade(0.0062, 0.079, 0.074), wood); core.position.set(0, 0, cz); g.add(core);
  const fh = new THREE.Mesh(blade(0.0021, 0.0775, 0.0725), red); fh.position.set(0.0041, 0, cz); g.add(fh);
  const bh = new THREE.Mesh(blade(0.0021, 0.0775, 0.0725), black); bh.position.set(-0.0041, 0, cz); g.add(bh);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0118, 0.0135, 0.108, 20), wood); handle.rotation.x = Math.PI / 2; g.add(handle);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0158, 0.0158, 0.008, 20), wood); cap.rotation.x = Math.PI / 2; cap.position.set(0, 0, 0.058); g.add(cap);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}
const PADDLE_BLADE_Z = 0.135; // handle centre to blade centre

/**
 * The handshake (shakehand) grip, in hand coordinates (palm faces -y, fingers point -z, thumb +x on this left-hand model): the handle lies across
 * the palm on the diagonal, the fingers wrap it, the blade stands out beyond the thumb and index finger, and its faces are parallel to the palm:
 * the red forehand face on the palm side (the thumb rests on it), the black backhand face behind (the index finger lies against it).
 */
const GRIP_AXIS = new THREE.Vector3(0.8, 0, -0.6); // from the handle towards the blade tip
export const PADDLE_HAND_POS = new THREE.Vector3(0, -0.032, 0);
const PADDLE_HAND_Q = (() => { // paddle frame -> hand frame: -z (blade) -> GRIP_AXIS, +x (red face) -> +y (palm side)
  const zb = GRIP_AXIS.clone().negate(), xb = new THREE.Vector3(0, 1, 0), yb = new THREE.Vector3().crossVectors(zb, xb);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xb, yb, zb));
})();
/** the blade's centre and its far tip in hand coordinates */
export const PADDLE_CENTER = PADDLE_HAND_POS.clone().addScaledVector(GRIP_AXIS, PADDLE_BLADE_Z);
export const PADDLE_TIP = PADDLE_CENTER.clone().addScaledVector(GRIP_AXIS, 0.075);
export function attachPaddle(model: THREE.Object3D, paddle: THREE.Object3D): void { paddle.position.copy(PADDLE_HAND_POS); paddle.quaternion.copy(PADDLE_HAND_Q); model.add(paddle); }
/** where the hand frame must be turned so the blade stands up and the red face looks along -z (at the opponent); mirrored = a right hand */
export function readyQuat(mirrored: boolean): THREE.Quaternion {
  const a = GRIP_AXIS.clone(); if (mirrored) a.x = -a.x;
  const up = new THREE.Vector3(0, 1, 0), e2 = up, e3 = new THREE.Vector3().crossVectors(a, e2);
  const H = new THREE.Matrix4().makeBasis(a, e2, e3), W = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0));
  return new THREE.Quaternion().setFromRotationMatrix(W.multiply(H.transpose()));
}

/** Bends the model's fingers to the given curls (thumb..little, 0..1). */
export function applyCurl(h: HandModel, curl: number[]): void {
  for (let i = 0; i < 4; i++) { const a = fingerAngles(i + 1, curl[i + 1]), j = h.fingers[i]; j[0].rotation.x = -a[0] * D2R; j[1].rotation.x = -a[1] * D2R; j[2].rotation.x = -a[2] * D2R; }
  const a = fingerAngles(0, curl[0]), t = JOINT.thumb;
  h.thumbRoot.rotation.y = -a[0] * D2R;
  h.thumbRoot.rotation.x = -(t.pitch[0] + (t.pitch[1] - t.pitch[0]) * curl[0]) * D2R;
  h.thumb[1].rotation.x = -a[1] * D2R; h.thumb[2].rotation.x = -a[2] * D2R;
}

/** The glove's quaternion (w,x,y,z; sensor world X forward, Y left, Z up) as a three.js quaternion (vector part x,y,z -> -y,z,-x). */
export function sensorToThree(q: number[], out = new THREE.Quaternion()): THREE.Quaternion { return out.set(-q[2], q[3], -q[1], q[0]); }

/** Joint angles in degrees: fingers [mcp, pip, dip]; thumb [cmc yaw, mcp, ip]. One sensor per finger, fixed coupling. */
export function fingerAngles(finger: number, c: number): number[] {
  if (finger === 0) { const t = JOINT.thumb; return [t.yaw[0] + (t.yaw[1] - t.yaw[0]) * c, t.mcp * c, t.ip * c]; }
  const f = JOINT.finger;
  return [f.mcp * c, f.pip * c, f.pip * c * f.dip];
}

const TRAIL = 36;
export const GRIP = [0.12, 0.56, 0.78, 0.84, 0.86]; // thumb lies along the face, the other fingers wrap the handle
export type ViewName = 'back' | 'palm' | 'side';
const VIEWS: Record<ViewName, [number, number, number]> = { back: [0.1, 0.3, 0.34], palm: [0.1, -0.3, 0.34], side: [0.42, 0.04, 0.02] };
const PLAY_VIEWS: Record<ViewName, [number, number, number]> = { back: [0.36, 0.3, 0.44], palm: [0.36, -0.24, 0.44], side: [0.62, 0.06, 0.06] }; // oblique, so the paddle face shows

export class HandView {
  readonly el: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 5);
  private controls: OrbitControls;
  private hand = buildHand();
  private target = new THREE.Quaternion();
  private cur = new THREE.Quaternion();
  private curl = [0, 0, 0, 0, 0];
  private tCurl = [0, 0, 0, 0, 0];
  private pressure = 0;
  private tPressure = 0;
  private snapNext = true;
  private gotPose = false;
  private paddle = buildPaddle();
  private play = false;
  private floor!: THREE.Mesh;
  private ring!: THREE.Mesh;
  private disc!: THREE.Mesh;
  private accent = new THREE.Color(0x9fb2c5);
  private accentTarget = new THREE.Color(0x9fb2c5);
  private pulseAt = 0;
  private trail!: THREE.InstancedMesh;
  private trailPts: THREE.Vector3[] = [];
  private tmp = new THREE.Object3D();
  private raf = 0;
  private last = performance.now();
  private ro: ResizeObserver;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'handview';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.el.appendChild(this.renderer.domElement);
    const pm = new THREE.PMREMGenerator(this.renderer); // studio reflections for the fabric, shell and wood
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; this.scene.environmentIntensity = 0.7; pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb0c4, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(0.5, 1.1, 0.8); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -0.35; key.shadow.camera.right = 0.35; key.shadow.camera.top = 0.35; key.shadow.camera.bottom = -0.35; key.shadow.camera.near = 0.2; key.shadow.camera.far = 3; key.shadow.bias = -0.0004; key.shadow.radius = 5;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd6ee, 1.4); rim.position.set(-0.8, 0.4, -0.6); this.scene.add(rim);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.ShadowMaterial({ opacity: 0.22 })); this.floor.rotation.x = -Math.PI / 2; this.floor.receiveShadow = true; this.scene.add(this.floor);
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.2, 72), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })); this.disc.rotation.x = -Math.PI / 2; this.scene.add(this.disc);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.19, 0.2, 96), new THREE.MeshBasicMaterial({ color: 0x9fb2c5, transparent: true, opacity: 0.95, side: THREE.DoubleSide })); this.ring.rotation.x = -Math.PI / 2; this.scene.add(this.ring);
    this.trail = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0042, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), TRAIL); this.trail.visible = false; this.trail.frustumCulled = false; this.scene.add(this.trail);
    attachPaddle(this.hand.model, this.paddle); this.paddle.visible = false;
    this.scene.add(this.hand.root);
    this.placeStage();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.minDistance = 0.12; this.controls.maxDistance = 1.2;
    this.setView('back');
    if (typeof location !== 'undefined' && /[?&]debug/.test(location.search)) (window as unknown as { __hand?: HandView }).__hand = this; // for screenshots of the model from fixed angles
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    const loop = (now: number) => { this.raf = requestAnimationFrame(loop); this.frame(now); };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(): void {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  setHanded(hand: 'left' | 'right'): void { this.hand.model.scale.x = hand === 'right' ? -1 : 1; }
  private viewName: ViewName = 'back';
  setView(v: ViewName): void {
    this.viewName = v; const p = (this.play ? PLAY_VIEWS : VIEWS)[v];
    this.camera.position.set(p[0], p[1], p[2]); this.controls.target.set(0, this.play ? 0.03 : 0, this.play ? -0.06 : -0.02); this.controls.maxDistance = this.play ? 1.4 : 1.2; this.controls.update();
  }
  private placeStage(): void {
    const y = this.play ? -0.2 : -0.1;
    this.floor.position.y = y; this.disc.position.y = y + 0.0005; this.ring.position.y = y + 0.001;
    const s = this.play ? 0.78 : 1; this.disc.scale.setScalar(s); this.ring.scale.setScalar(s);
  }
  /** Play style (the Use screen): the paddle in hand, a swing trail, the stage floor lower. Off = plain lab view (Train). */
  setPlay(on: boolean): void {
    if (on === this.play) return;
    this.play = on; this.paddle.visible = on; this.trail.visible = on; this.trailPts = []; this.placeStage(); this.setView(this.viewName);
  }
  /** Colours the stage ring and the swing trail, and pulses the ring once (a stroke has just been classified). */
  setAccent(hex: number): void { this.accentTarget.set(hex); this.pulseAt = performance.now(); }

  /** q: the glove's hand quaternion (w,x,y,z; world X forward, Y left, Z up). snap skips smoothing (used for replay). */
  setPose(q: number[], curl: number[], pressurePct: number, snap = false): void {
    const [w, x, y, z] = q; // sensor world frame to three.js: vector part (x,y,z) -> (-y,z,-x)
    this.gotPose = true;
    this.target.set(-y, z, -x, w);
    if (this.cur.dot(this.target) < 0) this.target.set(-this.target.x, -this.target.y, -this.target.z, -this.target.w);
    this.tCurl = curl.slice(0, 5);
    this.tPressure = Math.max(0, Math.min(1, pressurePct / 100));
    if (snap || this.snapNext) { this.cur.copy(this.target); this.curl = this.tCurl.slice(); this.pressure = this.tPressure; this.snapNext = false; }
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    const k = 1 - Math.exp(-dt / 0.03);
    if (this.play && !this.gotPose) { // no glove data yet: hold the paddle up and sway a little, instead of lying flat at the sensor's zero pose
      this.target.setFromEuler(new THREE.Euler((72 + 5 * Math.sin(now / 1100)) * D2R, 12 * D2R * Math.sin(now / 1700), 0));
    }
    this.cur.slerp(this.target, this.gotPose ? k : 1 - Math.exp(-dt / 0.15));
    this.hand.root.quaternion.copy(this.cur);
    const want = this.play ? GRIP : this.tCurl; // with the paddle in hand the fingers hold it; the flex sensors are too coarse to animate a grip
    for (let i = 0; i < 5; i++) this.curl[i] += (want[i] - this.curl[i]) * k;
    this.pressure += (this.tPressure - this.pressure) * k;
    applyCurl(this.hand, this.curl);
    const p = this.pressure;
    (this.hand.press.material as THREE.MeshBasicMaterial).color.setRGB(0.29 + 0.71 * p, 0.32 + 0.1 * p - 0.12 * p * p, 0.36 - 0.22 * p);
    this.accent.lerp(this.accentTarget, 1 - Math.exp(-dt / 0.12));
    (this.ring.material as THREE.MeshBasicMaterial).color.copy(this.accent);
    const since = (now - this.pulseAt) / 1000, pulse = this.pulseAt ? 0.16 * Math.exp(-since * 4.5) * Math.cos(since * 9) : 0, base = this.play ? 0.78 : 1;
    this.ring.scale.setScalar(base * (1 + pulse));
    if (this.play) this.updateTrail();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updateTrail(): void {
    const tip = PADDLE_TIP.clone(); tip.x *= this.hand.model.scale.x; tip.applyQuaternion(this.hand.root.quaternion);
    this.trailPts.unshift(tip); if (this.trailPts.length > TRAIL) this.trailPts.length = TRAIL;
    const bg = new THREE.Color(0xe6edf5), c = new THREE.Color();
    for (let i = 0; i < TRAIL; i++) {
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)], a = i / TRAIL;
      this.tmp.position.copy(p); this.tmp.scale.setScalar(Math.max(0.15, 1 - a * 0.85)); this.tmp.updateMatrix(); this.trail.setMatrixAt(i, this.tmp.matrix);
      c.copy(this.accent).lerp(bg, Math.min(1, a * 1.15)); this.trail.setColorAt(i, c);
    }
    this.trail.instanceMatrix.needsUpdate = true; if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
  }

  dispose(): void { cancelAnimationFrame(this.raf); this.ro.disconnect(); this.renderer.dispose(); this.el.remove(); }
}
