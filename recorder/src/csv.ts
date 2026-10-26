// Session export: turns stored raw packets plus set/event metadata into the files of a session folder.
// Pure (no DOM): returns file contents as string parts so huge CSVs never become one giant string.
import { parsePacket, rollPitch, type AdcRec, type ImuRec } from './protocol';
import type { SessionRec, StoredPacket } from './types';

export type FileParts = string[];

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const f9 = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(9))) : '');
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Which finger each hardware ADC channel carries, from the calibration's finger_to_channel. */
export function channelFingers(fingerToChannel: number[] | undefined): string[] {
  const names = ['ch0', 'ch1', 'ch2', 'ch3', 'ch4', 'palm'];
  (fingerToChannel ?? [0, 1, 2, 3, 4]).forEach((ch, f) => (names[ch] = FINGERS[f]));
  return names;
}

export function fingerMapOf(calibration: unknown): number[] | undefined {
  const m = (calibration as { finger_to_channel?: number[] } | null)?.finger_to_channel;
  return Array.isArray(m) && m.length === 5 ? m : undefined;
}

/** setId and bootId label every row: the glove's clock restarts at power-up, so times from different runs overlap and a time
 *  window alone is ambiguous. */
export interface Parsed {
  imu: (ImuRec & { rxMs: number; setId: string; bootId: number })[];
  adc: (AdcRec & { rxMs: number; setId: string; bootId: number })[];
}

/** Parses packets (skipping any that fail) and returns time-ordered records. */
export function parseAll(packets: StoredPacket[], setId = ''): Parsed & { bad: number; bootIds: number[] } {
  const imu: Parsed['imu'] = [];
  const adc: Parsed['adc'] = [];
  const boots = new Set<number>();
  let bad = 0;
  for (const p of packets) {
    try {
      const r = parsePacket(p.buf);
      boots.add(r.header.bootId);
      for (const x of r.imu) imu.push({ ...x, rxMs: p.rxMs, setId, bootId: r.header.bootId });
      for (const x of r.adc) adc.push({ ...x, rxMs: p.rxMs, setId, bootId: r.header.bootId });
    } catch {
      bad++;
    }
  }
  imu.sort((a, b) => a.tUs - b.tUs);
  adc.sort((a, b) => a.tUs - b.tUs);
  return { imu, adc, bad, bootIds: [...boots] };
}

function chunked(header: string, n: number, row: (i: number) => string): FileParts {
  const parts: string[] = [header + '\n'];
  for (let i = 0; i < n; i += 20000) {
    const lines: string[] = [];
    for (let j = i; j < Math.min(n, i + 20000); j++) lines.push(row(j));
    parts.push(lines.join('\n') + '\n');
  }
  return parts;
}

export function motionCsv(imu: Parsed['imu']): FileParts {
  return chunked('t_us,seq,ax,ay,az,gx,gy,gz,t_rx_ms,set_id,boot_id', imu.length, (i) => {
    const r = imu[i];
    return `${r.tUs},${r.seq},${r.raw.join(',')},${r.rxMs},${r.setId},${r.bootId}`;
  });
}

/** One row per ADC conversion. The channels are converted one after another, so a wide table with a column per
 *  finger would have to invent timestamps; this long format keeps every conversion at its own time. */
export function analogCsv(adc: Parsed['adc'], names: string[]): FileParts {
  return chunked('t_us,seq,channel,finger,raw,set_id,boot_id', adc.length, (i) => {
    const r = adc[i];
    return `${r.tUs},${r.seq},${r.channel},${names[r.channel] ?? ''},${r.raw},${r.setId},${r.bootId}`;
  });
}

export function derivedCsv(imu: Parsed['imu']): FileParts {
  const head =
    't_us,seq,qw,qx,qy,qz,roll_deg,pitch_deg,acc_x_g,acc_y_g,acc_z_g,gyro_x_dps,gyro_y_dps,gyro_z_dps,' +
    'curl_thumb,curl_index,curl_middle,curl_ring,curl_little,pressure_pct,set_id,boot_id';
  return chunked(head, imu.length, (i) => {
    const r = imu[i];
    const [roll, pitch] = rollPitch(r.q);
    return [r.tUs, r.seq, ...r.q.map(f9), f9((roll * 180) / Math.PI), f9((pitch * 180) / Math.PI), ...r.accH.map(f9), ...r.gyroH.map(f9), ...r.curl.map(f9), f9(r.pressure), r.setId, r.bootId].join(',');
  });
}

export function setsCsv(s: SessionRec, bootOf: Record<string, number> = {}): FileParts {
  const head = 'set_id,label,sub_label,kind,expected_n,detected_n,t_start_us,t_end_us,tempo,status,flags,boot_id';
  return chunked(head, s.sets.length, (i) => {
    const x = s.sets[i];
    const flags = x.flags.map((f) => `${f.severity}:${f.code}`).join(';');
    return [x.id, x.label, x.subLabel, x.kind, x.expectedN ?? '', x.detectedN, x.tStartUs, x.tEndUs, x.tempo, x.status, flags, bootOf[x.id] ?? ''].map((c) => csvCell(String(c))).join(',');
  });
}

export function eventsCsv(s: SessionRec): FileParts {
  const head = 'event_id,set_id,label,t_peak_us,source,status,peak_energy,detector_version';
  return chunked(head, s.events.length, (i) => {
    const e = s.events[i];
    return [e.id, e.setId, e.label, e.tPeakUs, e.source, e.status, f9(e.peakEnergy), e.detectorVersion].map((c) => csvCell(String(c))).join(',');
  });
}

const README = `Glove recorder session folder
==============================
motion.csv   raw MPU counts (ax ay az gx gy gz; +-16 g = 2048 counts/g, +-2000 dps = 16.4 counts/dps), glove clock t_us.
             set_id and boot_id label every row. The glove's clock restarts at power-up, so two runs can cover the same t_us
             range: always select by set_id (never by a time window alone) and never mix boot_ids in one time series.
             t_rx_ms is when the packet reached the browser: diagnostics only, never use it to align data.
analog.csv   one row per ADC conversion (long format): channel = hardware sensor index, finger = which finger it carries.
derived.csv  computed on the glove from the same sample as motion.csv: orientation, roll/pitch, gravity-removed hand-frame
             acceleration (g) and rate (deg/s), finger curl 0-1, palm pressure %. YAW IS NOT EXPORTED and must not be used as a
             feature: heading drifts and resets at power-up. Positive pitch = fingers pointing down.
sets.csv     one row per recorded set (status ok | flagged | discarded | pending; flags are severity:code).
events.csv   detected and manual stroke events (t_peak_us = time of the energy maximum). Only status ok is a training event.
meta.json    session info, firmware, detector parameters, class list version, holdout flag.
calibration.json  GET /api/calibration at session start and at export. Differences mean the calibration changed mid-session.
Discarded sets are not included in the data files. Times are the glove's micros() clock, unwrapped.
`;

export interface SessionFiles {
  files: Map<string, FileParts>;
  summary: { imu: number; adc: number; badPackets: number };
}

/** @param packets all packets of the session in index order */
export function buildSessionFiles(session: SessionRec, packets: StoredPacket[], appVersion: string): SessionFiles {
  const keep = session.sets.filter((s) => s.status !== 'discarded');
  const imu: Parsed['imu'] = [], adc: Parsed['adc'] = [], bootOf: Record<string, number> = {};
  let bad = 0;
  for (const s of keep) { // one set at a time, so each row can be labelled with its set and glove run
    const p = parseAll(packets.slice(s.packetFirst, s.packetLast + 1), s.id);
    imu.push(...p.imu); adc.push(...p.adc); bad += p.bad; bootOf[s.id] = p.bootIds[0] ?? 0;
  }
  const names = channelFingers(fingerMapOf(session.calibrationEnd ?? session.calibrationStart));
  const meta = {
    session_id: session.id,
    started_at: session.startedAt,
    exported_at: new Date().toISOString(),
    app_version: appVersion,
    hand: session.hand,
    with_ball: session.withBall,
    grip_notes: session.gripNotes,
    notes: session.notes,
    holdout: session.holdout,
    glove: session.glove,
    mpu: { accel_range_g: 16, gyro_range_dps: 2000, accel_lsb_per_g: 2048, gyro_lsb_per_dps: 16.4, rate_hz: 200 },
    adc: { channels: names },
    detector: session.detector,
    classes_version: session.classesVersion,
    sets: session.sets.length,
    events_ok: session.events.filter((e) => e.status === 'ok').length,
  };
  const files = new Map<string, FileParts>();
  files.set('meta.json', [JSON.stringify(meta, null, 2)]);
  files.set('calibration.json', [JSON.stringify({ start: session.calibrationStart, end: session.calibrationEnd }, null, 2)]);
  files.set('motion.csv', motionCsv(imu));
  files.set('analog.csv', analogCsv(adc, names));
  files.set('derived.csv', derivedCsv(imu));
  files.set('sets.csv', setsCsv(session, bootOf));
  files.set('events.csv', eventsCsv(session));
  files.set('README.txt', [README]);
  return { files, summary: { imu: imu.length, adc: adc.length, badPackets: bad } };
}
