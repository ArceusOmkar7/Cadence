import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import detectorJson from '../config/detector.json';
import { parsePacket, unwrapUs, rollPitch } from '../src/protocol';
import { EventDetector, detectAll, cutWindow, energyTrace, suggestThreshold, type DetectorConfig } from '../src/detector';
import { assessSet, isRed } from '../src/quality';
import { buildSessionFiles, channelFingers, parseAll } from '../src/csv';
import type { SessionRec } from '../src/types';
import { makeImuStream, packetOf } from './helpers';

const cfg = detectorJson as DetectorConfig;

describe('protocol', () => {
  it('parses a packet written by the firmware structs (C++ make_packet), across the 32-bit time wrap', () => {
    const b = readFileSync(new URL('./fixtures/packet.bin', import.meta.url));
    const p = parsePacket(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    expect(p.header).toEqual({ packetSeq: 77, bootId: 0xcafef00d, dropped: 5, tBaseUs: 0x100000100, n: 2 });
    expect(p.imu[0].tUs).toBe(0xffffff00);
    expect(p.imu[0].seq).toBe(123456);
    expect(p.imu[0].raw).toEqual([-2048, 100, 32767, -32768, 7, 1640]);
    expect(p.imu[0].pressure).toBe(42.5);
    expect(p.adc[0]).toEqual({ tUs: 0x100000050, seq: 99, channel: 5, raw: -1234 });
  });
  it('unwraps times either side of the wrap', () => {
    expect(unwrapUs(0x100000100, 0xffffff00)).toBe(0xffffff00);
    expect(unwrapUs(0xffffff00, 0x50)).toBe(0x100000050);
  });
  it('rejects damaged packets', () => {
    const good = packetOf(makeImuStream({ seconds: 0.05 }), []);
    expect(() => parsePacket(good.slice(0, 40))).toThrow();
    const bad = new Uint8Array(good.slice(0)); bad[0] = 0;
    expect(() => parsePacket(bad.buffer)).toThrow();
  });
  it('roll and pitch ignore yaw', () => {
    const half = Math.PI / 8; // 45 deg about z
    const [r, p] = rollPitch([Math.cos(half), 0, 0, Math.sin(half)]);
    expect(Math.abs(r) + Math.abs(p)).toBeLessThan(1e-9);
  });
});

describe('event detector', () => {
  const strokes = [1.0, 2.2, 3.4, 4.6, 5.8];
  const stream = makeImuStream({ seconds: 8, strokesAtS: strokes });

  it('finds each stroke once; the peak lags the true peak by about half the 50 ms smoothing, consistently', () => {
    const ev = detectAll(cfg, stream);
    expect(ev.length).toBe(strokes.length);
    const lag = ev.map((e, i) => (e.tPeakUs - 1_000_000) / 1e6 - strokes[i]);
    lag.forEach((l) => { expect(l).toBeGreaterThanOrEqual(0); expect(l).toBeLessThan(0.04); });
    expect(Math.max(...lag) - Math.min(...lag)).toBeLessThan(0.005); // same lag every time, so windows stay aligned
    ev.forEach((e) => expect(e.tDetectUs).toBeGreaterThanOrEqual(e.tPeakUs));
  });
  it('is causal: events from any prefix are a prefix of the events from the whole recording', () => {
    const all = detectAll(cfg, stream);
    for (const cut of [300, 700, 1200, 1500]) {
      const part = detectAll(cfg, stream.slice(0, cut));
      expect(part).toEqual(all.slice(0, part.length));
    }
  });
  it('streaming sample by sample equals the batch run', () => {
    const d = new EventDetector(cfg);
    const live = stream.map((s) => d.push(s.tUs, s.gyroH, s.accH)).filter((e) => e);
    expect(live).toEqual(detectAll(cfg, stream));
  });
  it('ignores a second bump inside the refractory period', () => {
    const two = makeImuStream({ seconds: 4, strokesAtS: [1.0, 1.25] });
    expect(detectAll(cfg, two).length).toBe(1);
  });
  it('catches a soft push with a suitable threshold and stays quiet on idle noise', () => {
    const soft = makeImuStream({ seconds: 4, strokesAtS: [1, 2.5], strokeGyroDps: 250, strokeAccG: 0.6 });
    expect(detectAll({ ...cfg, highThreshold: 0.2 }, soft).length).toBe(2);
    expect(detectAll(cfg, makeImuStream({ seconds: 30, noiseDps: 20 })).length).toBe(0);
  });
  it('survives a data hole across a stroke', () => {
    const holed = stream.filter((s) => !(s.tUs > 2_150_000 && s.tUs < 2_300_000)); // 150 ms missing around 2.2 s
    expect(detectAll(cfg, holed).length).toBeGreaterThanOrEqual(strokes.length - 1);
  });
  it('cuts the 0.8 s window with the peak at 60%', () => {
    const w = cutWindow(cfg, stream, 3_400_000);
    const span = (w[w.length - 1].tUs - w[0].tUs) / 1e6;
    expect(span).toBeGreaterThan(0.78); expect(span).toBeLessThan(0.82);
    expect((3_400_000 - w[0].tUs) / (w[w.length - 1].tUs - w[0].tUs)).toBeCloseTo(0.6, 1);
  });
  it('suggests a threshold above idle movement', () => {
    const idle = energyTrace(cfg, makeImuStream({ seconds: 40, noiseDps: 25 })).map((x) => x.e);
    const s = suggestThreshold(idle)!;
    expect(s.suggested).toBeGreaterThan(s.p995);
  });
  it('matches the golden file (the same input and expected events let a Python port be checked)', () => {
    const path = new URL('./golden/detector_v1.json', import.meta.url);
    const input = stream.map((s) => [s.tUs, ...s.gyroH, ...s.accH]);
    const events = detectAll(cfg, stream).map((e) => ({ tPeakUs: e.tPeakUs, peakEnergy: Number(e.peakEnergy.toFixed(6)), tDetectUs: e.tDetectUs }));
    const golden = { description: 'Rows are [t_us, gyroH x,y,z (dps), accH x,y,z (g)]. Feed them in order to the detector with this config.', config: cfg, input, events };
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) { mkdirSync(new URL('./golden/', import.meta.url), { recursive: true }); writeFileSync(path, JSON.stringify(golden)); }
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.events).toEqual(JSON.parse(JSON.stringify(events)));
    expect(saved.config).toEqual(cfg);
  });
});

describe('quality checks', () => {
  const base = (over = {}) => ({ kind: 'stroke' as const, imu: makeImuStream({ seconds: 5 }), adc: [], headers: [{ packetSeq: 0, bootId: 1, dropped: 0, tBaseUs: 0, n: 0 }], channelNames: ['thumb', 'index', 'middle', 'ring', 'little'], ...over });
  it('passes a clean set', () => expect(assessSet(base())).toEqual([]));
  it('flags a gap and loss', () => {
    const imu = makeImuStream({ seconds: 20 }).filter((r) => !(r.seq > 400 && r.seq < 460)); // 59 samples = ~300 ms in 20 s
    const f = assessSet(base({ imu }));
    expect(f.map((x) => x.code)).toEqual(expect.arrayContaining(['gap', 'loss']));
    expect(isRed(f)).toBe(false); // 1.5% loss and a 300 ms gap are amber
    expect(isRed(assessSet(base({ imu: makeImuStream({ seconds: 20 }).filter((r) => !(r.seq > 400 && r.seq < 560)) })))).toBe(true); // 800 ms gap
  });
  it('flags reboot, clipping, flat flex channel, no data', () => {
    const imu = makeImuStream({ seconds: 5 });
    expect(assessSet(base({ headers: [{ packetSeq: 0, bootId: 1, dropped: 0, tBaseUs: 0, n: 0 }, { packetSeq: 1, bootId: 2, dropped: 0, tBaseUs: 0, n: 0 }] })).map((x) => x.code)).toContain('reboot');
    const clipped = imu.map((r, i) => (i % 20 === 0 ? { ...r, raw: [32767, 0, 0, 0, 0, 0] } : r));
    expect(assessSet(base({ imu: clipped })).map((x) => x.code)).toContain('clipping');
    const adc = Array.from({ length: 300 }, (_, i) => ({ tUs: i * 1000, seq: i, channel: 1, raw: 5000 }));
    const flat = assessSet(base({ adc }));
    expect(flat.find((x) => x.code === 'flat_channel')?.detail).toContain('index');
    expect(assessSet(base({ imu: imu.slice(0, 10) }))[0].code).toBe('no_data');
  });
});

describe('export', () => {
  it('writes the session files with the agreed columns and excludes discarded sets', () => {
    const imu = makeImuStream({ seconds: 2 });
    const adc = Array.from({ length: 60 }, (_, i) => ({ tUs: 1_000_000 + i * 1300, seq: i, channel: i % 6, raw: 100 + i }));
    const packets = [
      { rxMs: 5, buf: packetOf(imu.slice(0, 200), adc.slice(0, 30), 0) },
      { rxMs: 6, buf: packetOf(imu.slice(200), adc.slice(30), 1) },
    ];
    const session = {
      id: 's1', startedAt: '2026-01-01T00:00:00Z', hand: 'left', withBall: true, gripNotes: '', notes: '', holdout: false,
      glove: { host: 'x', fw: 'fw', build: 'b', bootId: 7 }, calibrationStart: { finger_to_channel: [2, 0, 4, 1, 3] }, calibrationEnd: null,
      detector: cfg, classesVersion: 1, packetCount: 2,
      sets: [
        { id: 'a', kind: 'stroke', label: 'push', subLabel: '', expectedN: 5, tStartUs: 0, tEndUs: 1, tempo: 'off', status: 'ok', flags: [], packetFirst: 0, packetLast: 0, detectedN: 5, note: '' },
        { id: 'b', kind: 'idle', label: 'idle', subLabel: 'rest', expectedN: null, tStartUs: 0, tEndUs: 1, tempo: 'off', status: 'discarded', flags: [{ code: 'gap', severity: 'amber', detail: 'x' }], packetFirst: 1, packetLast: 1, detectedN: 0, note: '' },
      ],
      events: [{ id: 'e1', setId: 'a', label: 'push', tPeakUs: 1_500_000, source: 'auto', status: 'ok', peakEnergy: 1.25, detectorVersion: '1' }],
    } as unknown as SessionRec;
    const { files, summary } = buildSessionFiles(session, packets, 'test');
    const text = (n: string) => files.get(n)!.join('');
    expect(summary.imu).toBe(200);
    expect(text('motion.csv').split('\n')[0]).toBe('t_us,seq,ax,ay,az,gx,gy,gz,t_rx_ms,set_id,boot_id');
    expect(text('motion.csv').trim().split('\n').length).toBe(201);
    expect(text('analog.csv').split('\n')[1]).toMatch(/^1000000,0,0,index,100,a,7$/); // channel 0 carries the index finger in this map
    expect(text('derived.csv').split('\n')[0]).toContain('curl_thumb');
    expect(text('derived.csv')).not.toMatch(/yaw/i);
    expect(text('sets.csv')).toContain('a,push,,stroke,5,5');
    expect(text('events.csv')).toContain('e1,a,push,1500000,auto,ok,1.25,1');
    expect(channelFingers([2, 0, 4, 1, 3])).toEqual(['index', 'ring', 'thumb', 'little', 'middle', 'palm']);
    expect(parseAll(packets).imu.length).toBe(400);
    expect(text('motion.csv').split(String.fromCharCode(10))[1]).toMatch(/,a,7$/); // every row names its set and glove run
  });
  it('keeps two glove runs with overlapping clocks apart (the glove restarts and its clock begins again from zero)', () => {
    const run1 = makeImuStream({ seconds: 1, t0Us: 5_000_000, seed: 1 }), run2 = makeImuStream({ seconds: 1, t0Us: 5_000_000, seed: 2 }); // same times, different data
    const packets = [{ rxMs: 1, buf: packetOf(run1, [], 0, 111) }, { rxMs: 99999, buf: packetOf(run2, [], 0, 222) }];
    const mk = (id: string, i: number) => ({ id, kind: 'idle', label: 'idle', subLabel: 'rest', expectedN: null, tStartUs: 5_000_000, tEndUs: 6_000_000, tempo: 'off', status: 'ok', flags: [], packetFirst: i, packetLast: i, detectedN: 0, note: '' });
    const session = { id: 's', startedAt: '2026-01-01T00:00:00Z', hand: 'left', withBall: false, gripNotes: '', notes: '', holdout: false, glove: { host: '', fw: '', build: '', bootId: 0 }, calibrationStart: {}, calibrationEnd: null, detector: cfg, classesVersion: 1, packetCount: 2, sets: [mk('a', 0), mk('b', 1)], events: [] } as unknown as SessionRec;
    const rows = buildSessionFiles(session, packets, 't').files.get('motion.csv')!.join('').trim().split(String.fromCharCode(10)).slice(1).map((l) => l.split(','));
    expect(rows.length).toBe(400);
    expect(new Set(rows.filter((r) => r[9] === 'a').map((r) => r[10]))).toEqual(new Set(['111'])); // set a only ever carries run 111
    expect(new Set(rows.filter((r) => r[9] === 'b').map((r) => r[10]))).toEqual(new Set(['222']));
    expect(buildSessionFiles(session, packets, 't').files.get('sets.csv')!.join('')).toMatch(/a,idle,rest,idle,,0,5000000,6000000,off,ok,,111/);
  });
});

describe('recovery bump', () => {
  // the hand returning to the ready position makes a small second bump about 0.5 s after each stroke
  const withRecovery = (strokes: number[], bump: number, delay = 0.52) => {
    const main = makeImuStream({ seconds: 12, strokesAtS: strokes, strokeGyroDps: 900, strokeAccG: 4 });
    const back = makeImuStream({ seconds: 12, strokesAtS: strokes.map((s) => s + delay), strokeGyroDps: 900 * bump, strokeAccG: 4 * bump, seed: 5 });
    return main.map((r, i) => ({ ...r, gyroH: [r.gyroH[0] + back[i].gyroH[0], r.gyroH[1], r.gyroH[2]], accH: [r.accH[0] + back[i].accH[0], r.accH[1], r.accH[2]] }));
  };
  it('counts one event per stroke, not two', () => {
    const s = withRecovery([2, 4, 6, 8, 10], 0.3);
    expect(detectAll({ ...cfg, recoveryMs: 0 }, s).length).toBe(10); // without the rule: the bug seen on the first real set
    expect(detectAll(cfg, s).length).toBe(5);
  });
  it('still counts two genuine strokes of similar strength in quick succession', () => {
    expect(detectAll(cfg, makeImuStream({ seconds: 6, strokesAtS: [2, 2.6] })).length).toBe(2);
    expect(detectAll(cfg, withRecovery([2], 0.8)).length).toBe(2); // a bump nearly as strong as the stroke is a stroke
  });
  it('does not drop a soft stroke that comes long after a hard one', () => {
    const hard = makeImuStream({ seconds: 8, strokesAtS: [2], strokeGyroDps: 900 }), soft = makeImuStream({ seconds: 8, strokesAtS: [4], strokeGyroDps: 250, strokeAccG: 0.7, seed: 3 });
    const mix = hard.map((r, i) => ({ ...r, gyroH: [r.gyroH[0] + soft[i].gyroH[0], 0, 0], accH: [r.accH[0] + soft[i].accH[0], 0, 0] }));
    expect(detectAll({ ...cfg, highThreshold: 0.2 }, mix).length).toBe(2);
  });
});

describe('recovery bump direction', () => {
  // x-axis strokes; a return swing has the opposite sign
  const pair = (second: { atS: number; sign: number; strength: number }) => {
    const a = makeImuStream({ seconds: 8, strokesAtS: [2], strokeGyroDps: 900, strokeAccG: 4 });
    const b = makeImuStream({ seconds: 8, strokesAtS: [second.atS], strokeGyroDps: 900 * second.strength, strokeAccG: 4 * second.strength, seed: 7 });
    return a.map((r, i) => ({ ...r, gyroH: [r.gyroH[0] + second.sign * b[i].gyroH[0], r.gyroH[1], r.gyroH[2]], accH: [r.accH[0] + second.sign * b[i].accH[0], r.accH[1], r.accH[2]] }));
  };
  it('drops a return swing that is nearly as strong as the stroke (the ratio rule alone let 50-63% bumps through)', () => {
    expect(detectAll(cfg, pair({ atS: 2.55, sign: -1, strength: 0.7 })).length).toBe(1);
    expect(detectAll({ ...cfg, recoveryCos: -2 }, pair({ atS: 2.55, sign: -1, strength: 0.7 })).length).toBe(2); // direction rule off: counted twice
  });
  it('drops a return swing that is stronger than a soft stroke', () => {
    expect(detectAll(cfg, pair({ atS: 2.5, sign: -1, strength: 1.2 })).length).toBe(1);
  });
  it('keeps a second stroke in the same direction, and an opposite one after the recovery window', () => {
    expect(detectAll(cfg, pair({ atS: 2.55, sign: 1, strength: 0.8 })).length).toBe(2);
    expect(detectAll(cfg, pair({ atS: 3.5, sign: -1, strength: 0.8 })).length).toBe(2);
  });
});
