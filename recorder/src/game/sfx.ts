// Small synthesized sounds for the game (no audio files). Everything fails quietly if the browser has no audio.
let ctx: AudioContext | null = null;
let muted = false;
try { muted = localStorage.getItem('gameMute') === '1'; } catch { /* private window */ }

export const isMuted = (): boolean => muted;
export function setMuted(m: boolean): void { muted = m; try { localStorage.setItem('gameMute', m ? '1' : '0'); } catch { /* not remembered */ } }

function tone(freq: number, ms: number, type: OscillatorType, gain: number, slideTo?: number, delayMs = 0): void {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime + delayMs / 1000, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + ms / 1000);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
  } catch { /* no audio */ }
}

export const sfx = {
  unlock(): void { try { ctx ??= new AudioContext(); void ctx.resume(); } catch { /* no audio */ } },
  bounce: () => tone(900, 45, 'triangle', 0.12, 500),
  hit: (smash: boolean) => { tone(smash ? 220 : 340, 110, 'square', smash ? 0.16 : 0.1, 90); tone(1400, 30, 'sine', 0.08); },
  perfect: () => { tone(880, 90, 'sine', 0.08, undefined, 40); tone(1320, 140, 'sine', 0.08, undefined, 110); },
  fault: () => tone(160, 260, 'sawtooth', 0.09, 70),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 160, 'triangle', 0.1, undefined, i * 90)),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 200, 'triangle', 0.09, undefined, i * 110)),
  point: () => { tone(660, 120, 'triangle', 0.09); tone(990, 160, 'triangle', 0.09, undefined, 90); },
  lost: () => tone(200, 300, 'triangle', 0.09, 110),
};
