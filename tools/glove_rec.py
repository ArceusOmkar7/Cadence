"""Client for the glove's binary record stream, plus the Stage 1 hardware checks.

Pure standard library (raw-socket WebSocket client), Python 3.8+.

  python tools/glove_rec.py check  --host glove.local --seconds 300   # rates, gaps, seq/dup/drop counts, diag, calibration
  python tools/glove_rec.py noise  --host glove.local                  # resting noise at 128/250/475/860 SPS (keep the glove still)
  python tools/glove_rec.py swing  --host glove.local --seconds 20     # peak accel/gyro vs full scale during a hard swing
  python tools/glove_rec.py i2c    --host glove.local --hz 400000      # switch the I2C clock for A/B runs

The wire format is defined in lib/GloveRec/GloveRec.h; parse_packet() below mirrors it.
"""
import argparse, base64, json, os, socket, struct, sys, time, urllib.request

HEADER = struct.Struct("<BBBBIIIQHH")           # 28 bytes
IMU = struct.Struct("<BII6h4f3f3f5ff")          # 85 bytes
ADC = struct.Struct("<BIIBh")                   # 12 bytes
assert HEADER.size == 28 and IMU.size == 85 and ADC.size == 12
MAGIC, VERSION = 0xA5, 1


def unwrap(t_base_us, t32):
    """Full-width time of a 32-bit record time, relative to the packet's 64-bit base (exact within +-35 min)."""
    delta = (t32 - (t_base_us & 0xFFFFFFFF) + 2**31) % 2**32 - 2**31
    return t_base_us + delta


def parse_packet(buf):
    """Returns (header dict, [records]). Raises ValueError on a malformed packet."""
    if len(buf) < HEADER.size:
        raise ValueError("short packet")
    magic, ver, typ, flags, pseq, boot, dropped, base, n, plen = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or ver != VERSION or plen != len(buf) - HEADER.size:
        raise ValueError("bad header (magic %02x version %d payload %d of %d)" % (magic, ver, plen, len(buf) - HEADER.size))
    hdr = dict(packet_seq=pseq, boot_id=boot, dropped=dropped, t_base_us=base, n=n)
    recs, off = [], HEADER.size
    while off < len(buf):
        t = buf[off]
        if t == 1:
            v = IMU.unpack_from(buf, off); off += IMU.size
            recs.append(dict(kind="imu", t_us=unwrap(base, v[1]), seq=v[2], raw=v[3:9], q=v[9:13], acc_h=v[13:16],
                             gyro_h=v[16:19], curl=v[19:24], pressure=v[24]))
        elif t == 2:
            v = ADC.unpack_from(buf, off); off += ADC.size
            recs.append(dict(kind="adc", t_us=unwrap(base, v[1]), seq=v[2], channel=v[3], raw=v[4]))
        else:
            raise ValueError("unknown record type %d at offset %d" % (t, off))
    if len(recs) != n:
        raise ValueError("record count %d != header %d" % (len(recs), n))
    return hdr, recs


class WS:
    """Minimal WebSocket client: text/binary frames, answers pings. Server frames are unmasked, ours are masked."""
    def __init__(self, host, port=81, timeout=5):
        self.s = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(("GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (host, port, key)).encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self._recv()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))
        self.s.settimeout(timeout)

    def _recv(self):
        d = self.s.recv(65536)
        if not d:
            raise ConnectionError("closed")
        return d

    def _need(self, n):
        while len(self.buf) < n:
            self.buf += self._recv()

    def send(self, opcode, payload=b""):
        mask = os.urandom(4)
        hdr = bytes([0x80 | opcode])
        n = len(payload)
        hdr += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        """Next (opcode, payload) for text/binary; pings are answered, pongs ignored."""
        while True:
            self._need(2)
            op, ln = self.buf[0] & 0x0F, self.buf[1] & 0x7F
            off = 2
            if ln == 126:
                self._need(4); ln = struct.unpack(">H", self.buf[2:4])[0]; off = 4
            elif ln == 127:
                self._need(10); ln = struct.unpack(">Q", self.buf[2:10])[0]; off = 10
            if ln > 1 << 20:
                raise ConnectionError("absurd frame length %d: stream out of sync" % ln)
            self._need(off + ln)
            payload, self.buf = self.buf[off:off + ln], self.buf[off + ln:]
            if op == 9:
                self.send(10, payload)
            elif op == 8:
                raise ConnectionError("closed by glove")
            elif op in (1, 2):
                return op, payload


def http(host, path, method="GET"):
    req = urllib.request.Request("http://%s%s" % (host, path), method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    try:
        return json.loads(body)
    except ValueError:
        return body


def record(host, seconds, transport="udp"):
    """Runs the record stream for `seconds`; returns (records, headers, parse error count).
    transport "udp": the WebSocket is only the control channel and the glove sends one packet per datagram to a UDP
    socket here (a lost datagram costs a few samples, never a TCP stall). transport "ws": records come back over the
    WebSocket. The receive loop does no parsing: packets are stored raw and parsed after the run."""
    ws = WS(host)
    sock = None
    if transport == "udp":
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        sock.bind(("", 0)); sock.settimeout(0.02)
        ws.send(1, b"rec:start:%d" % sock.getsockname()[1])
    else:
        ws.send(1, b"rec:start")
    ws.s.settimeout(0.001)
    raw, t_end, last_k = [], time.time() + seconds, 0.0
    while time.time() < t_end:
        if time.time() - last_k >= 0.1:
            ws.send(1, b"k"); last_k = time.time()  # 1-byte frame, ignored by the glove; keeps some downlink traffic going
        if sock:
            try:
                raw.append(sock.recv(2048))
            except socket.timeout:
                pass
            try:
                ws.recv()                              # control replies, pings
            except (socket.timeout, OSError):
                pass
        else:
            try:
                op, p = ws.recv()
            except socket.timeout:
                continue
            if op == 2:
                raw.append(p)
    ws.send(1, b"rec:stop")
    time.sleep(0.2)
    recs, hdrs, errors = [], [], 0
    for p in raw:
        try:
            h, r = parse_packet(p)
        except ValueError as e:
            errors += 1; print("bad packet:", e); continue
        hdrs.append(h); recs.extend(r)
    return recs, hdrs, errors


def analyse(recs, hdrs, parse_errors, seconds):
    out = {}
    boots = sorted({h["boot_id"] for h in hdrs})
    out["boot_ids_seen"] = len(boots)
    out["packets"] = len(hdrs)
    out["packet_seq_gaps"] = sum(1 for a, b in zip(hdrs, hdrs[1:]) if b["packet_seq"] != a["packet_seq"] + 1)
    out["packets_lost"] = (hdrs[-1]["packet_seq"] - hdrs[0]["packet_seq"] + 1 - len(hdrs)) if hdrs else None   # datagrams that never arrived
    out["packets_out_of_order"] = sum(1 for a, b in zip(hdrs, hdrs[1:]) if b["packet_seq"] < a["packet_seq"])
    out["parse_errors"] = parse_errors
    out["dropped_records_final"] = hdrs[-1]["dropped"] if hdrs else None
    imu = [r for r in recs if r["kind"] == "imu"]
    out["imu"] = stream_stats(imu, 5000)
    out["imu"]["accel_norm_g_median"] = None
    if imu:
        norms = sorted((sum((x / 2048.0) ** 2 for x in r["raw"][:3])) ** 0.5 for r in imu)
        out["imu"]["accel_norm_g_median"] = round(norms[len(norms) // 2], 3)
        out["imu"]["peak_raw_accel"] = max(max(abs(x) for x in r["raw"][:3]) for r in imu)
        out["imu"]["peak_raw_gyro"] = max(max(abs(x) for x in r["raw"][3:]) for r in imu)
    adc = [r for r in recs if r["kind"] == "adc"]
    out["adc"] = {}
    for ch in range(6):
        out["adc"][ch] = stream_stats([r for r in adc if r["channel"] == ch], 1e6 / 100, check_seq=False)
    out["adc_all_channels_seq"] = stream_stats(adc, 0)  # the ADC sequence counts conversions over all channels
    return out


def stream_stats(rs, nominal_us, check_seq=True):
    if len(rs) < 2:
        return dict(n=len(rs))
    t = [r["t_us"] for r in rs]; s = [r["seq"] for r in rs]
    gaps = [b - a for a, b in zip(t, t[1:])]
    span = (t[-1] - t[0]) / 1e6
    lost = (s[-1] - s[0] + 1 - len(rs)) if check_seq else None
    return dict(n=len(rs), lost=lost, loss_pct=round(100.0 * lost / (s[-1] - s[0] + 1), 2) if check_seq else None, rate_hz=round((len(rs) - 1) / span, 2) if span else None,
                max_gap_ms=round(max(gaps) / 1000, 2), median_gap_ms=round(sorted(gaps)[len(gaps) // 2] / 1000, 3),
                gaps_over_50ms=sum(1 for g in gaps if g > 50000),
                big_gaps_s=[(round((t[i] - t[0]) / 1e6, 2), round(g / 1000)) for i, g in enumerate(gaps) if g > 50000],  # (start s, length ms)
                seq_jumps=sum(1 for a, b in zip(s, s[1:]) if b != a + 1) if check_seq else None,
                duplicate_or_backwards_seq=sum(1 for a, b in zip(s, s[1:]) if b <= a) if check_seq else None,
                time_backwards=sum(1 for g in gaps if g <= 0))


def cmd_check(a):
    cal = http(a.host, "/api/calibration")   # fetched first: an HTTP request stalls the loop for ~20 ms
    json.dump(cal, open("calibration_snapshot.json", "w"), indent=1)
    http(a.host, "/api/diag/reset", "POST")
    print("firmware %s, MPU %s g / %s dps, ADC %s SPS, I2C %s Hz" % (cal["fw"], cal["imu"]["accel_range_g"], cal["imu"]["gyro_range_dps"], cal["adc"]["sps"], cal["i2c_hz"]))
    print("recording %d s ..." % a.seconds)
    recs, hdrs, errs = record(a.host, a.seconds, a.transport)
    print(json.dumps(analyse(recs, hdrs, errs, a.seconds), indent=1))
    d = http(a.host, "/api/diag")
    w = d["wifi"]
    print("WiFi: %s ch%d, RSSI now %d dBm, avg %.1f, worst %d (about -50 excellent, -67 good, -75 marginal)" % (w["ssid"], w["channel"], w["rssi_dbm"], w["rssi_avg_dbm"], w["rssi_min_dbm"]))
    print("device diagnostics:"); print(json.dumps(d, indent=1))


def cmd_noise(a):
    print(http(a.host, "/api/diag/noise?ms=%d" % a.ms, "POST"))
    time.sleep(4 * a.ms / 1000 + 1.5)
    r = http(a.host, "/api/diag/noise")
    if not r.get("done"):
        print("not finished:", r); return
    print("sps   | per-channel sd (counts) ch0..5            | per-channel rate Hz")
    for row in r["results"]:
        print("%4d  | %s | %s" % (row["sps"], " ".join("%6.2f" % x for x in row["sd_counts"]), " ".join("%5.1f" % x for x in row["rate_hz"])))
    print("range (max-min counts):"); [print("%4d  | %s" % (row["sps"], " ".join("%6d" % x for x in row["range_counts"]))) for row in r["results"]]


def cmd_swing(a):
    http(a.host, "/api/diag/reset", "POST")
    print("swing hard now for %d s ..." % a.seconds); time.sleep(a.seconds)
    d = http(a.host, "/api/diag")["imu"]
    print("peak accel %.2f g of 16 g (%d / 32768 counts), peak gyro %.0f dps of 2000 (%d counts)" % (d["peak_accel_g"], d["peak_accel_counts"], d["peak_gyro_dps"], d["peak_gyro_counts"]))


def cmd_i2c(a):
    print(http(a.host, "/api/diag/i2c?hz=%d" % a.hz, "POST"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("check", cmd_check), ("noise", cmd_noise), ("swing", cmd_swing), ("i2c", cmd_i2c)):
        p = sub.add_parser(name); p.add_argument("--host", default="glove.local"); p.set_defaults(fn=fn)
        if name in ("check", "swing"): p.add_argument("--seconds", type=int, default=300 if name == "check" else 20)
        if name == "check": p.add_argument("--transport", choices=["udp", "ws"], default="udp")
        if name == "noise": p.add_argument("--ms", type=int, default=3000)
        if name == "i2c": p.add_argument("--hz", type=int, default=400000)
    args = ap.parse_args(); args.fn(args)
