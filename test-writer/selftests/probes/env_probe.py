"""Probe: report what the sandbox exposes about identity, paths and writes."""

import json
import os
import socket

report = {
    "if_nameindex": socket.if_nameindex(),
    "fake_secret": os.environ.get("FAKE_SECRET"),
    "home_exists": os.path.isdir("/home"),
    # The rootless store lives below the owner's home; the sandbox has no
    # usable HOME, so this must stay false unless the host home was leaked in.
    "store_exists": os.path.exists(
        os.path.join(os.path.expanduser("~"), ".nyxowl", "test-writer", "store")
    ),
    "root": sorted(os.listdir("/")),
}

try:
    with open("/work/src/x", "w", encoding="utf-8") as handle:
        handle.write("x")
    report["write"] = "allowed"
except OSError as exc:
    report["write"] = type(exc).__name__

print(json.dumps(report))
