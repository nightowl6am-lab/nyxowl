"""Probe: emit 4 MiB so the parent must truncate the captured output."""

import sys

chunk = "x" * (64 * 1024)
for _ in range(64):
    sys.stdout.write(chunk)
sys.stdout.write("\n")
sys.stdout.flush()
