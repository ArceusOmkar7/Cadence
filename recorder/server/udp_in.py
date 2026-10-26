"""UDP receiver helper for the relay. Receives the glove's datagrams and forwards them over loopback to the relay.

Why: on some Windows machines the firewall blocks inbound UDP for node.exe (a "Block" rule from an old prompt) while Python is
allowed. Loopback traffic is not filtered, so this keeps the relay working without changing any firewall setting.
Usage (started by relay.mjs): python udp_in.py <relay loopback port>. Prints "PORT <n>" once bound; exits when the relay closes stdin.
"""
import os, socket, sys, threading

fwd = ("127.0.0.1", int(sys.argv[1]))
rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
rx.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
rx.bind(("0.0.0.0", 0))
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()  # relay gone: stop
print("PORT", rx.getsockname()[1], flush=True)
while True:
    tx.sendto(rx.recv(2048), fwd)
