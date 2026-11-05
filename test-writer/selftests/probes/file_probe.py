"""Probe: write 64 MiB into the sandbox tmpfs and report the first failure."""

import errno

chunk = b"x" * (1024 * 1024)
try:
    with open("/tmp/giant", "wb") as handle:
        for _ in range(64):
            handle.write(chunk)
except OSError as exc:
    print("FILE_FAIL", exc.errno, errno.errorcode.get(exc.errno, "UNKNOWN"), flush=True)
else:
    print("FILE_OK", flush=True)
