"""Probe: one connection attempt, no retries, no host names."""

import socket

try:
    socket.create_connection(("1.1.1.1", 80), timeout=1)
except OSError as exc:
    print("NETWORK_FAIL", exc.errno)
else:
    print("NETWORK_OK")
