"""Parses the packet written by make_packet.cpp with tools/glove_rec.py and checks every field.
   python test/host/check_packet.py packet.bin"""
import math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
import glove_rec

hdr, recs = glove_rec.parse_packet(open(sys.argv[1], "rb").read())
imu, adc = recs
def close(a, b): return all(math.isclose(x, y, rel_tol=1e-6, abs_tol=1e-6) for x, y in zip(a, b))
checks = {
    "header": hdr == dict(packet_seq=77, boot_id=0xCAFEF00D, dropped=5, t_base_us=0x100000100, n=2),
    "imu seq/time (unwrapped across the 32-bit wrap)": imu["seq"] == 123456 and imu["t_us"] == 0xFFFFFF00,
    "imu raw": imu["raw"] == (-2048, 100, 32767, -32768, 7, 1640),
    "imu q": close(imu["q"], (0.25, 0.5, 0.75, 1.0)),
    "imu accH": close(imu["acc_h"], (-1.5, -3.0, -4.5)),
    "imu gyroH": close(imu["gyro_h"], (100, 200, 300)),
    "imu curl": close(imu["curl"], (0.0, 0.1, 0.2, 0.3, 0.4)),
    "imu pressure": imu["pressure"] == 42.5,
    "adc": adc["seq"] == 99 and adc["channel"] == 5 and adc["raw"] == -1234 and adc["t_us"] == 0x100000050,
}
for k, v in checks.items():
    print("ok  " if v else "FAIL", k)
sys.exit(0 if all(checks.values()) else 1)
