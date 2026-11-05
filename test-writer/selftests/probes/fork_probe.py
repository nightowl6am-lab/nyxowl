"""Probe: fork up to 128 children and report the first process-limit failure."""

import errno
import os
import time

for _ in range(128):
    try:
        pid = os.fork()
    except OSError as exc:
        print("FORK_FAIL", exc.errno, errno.errorcode.get(exc.errno, "UNKNOWN"), flush=True)
        break
    if pid == 0:
        try:
            time.sleep(5)
        finally:
            os._exit(0)
