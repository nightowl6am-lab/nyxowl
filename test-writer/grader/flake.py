"""Pure flake decision for the M4 gate 4.

The gate runs the same proof test against the vulnerable and patched snapshots
with two extra fixed hash seeds (1 and 2).  This module reduces those
observations to a tiny, testable decision; it performs no I/O and knows nothing
about snapshots, tar files, or sandbox internals.

Observation shape::

    {
        "vulnerable": [run, run],        # seeds 1 and 2
        "patched": [run, run],
        "expected": {"vulnerable": "failed", "patched": "passed"},
    }

Each ``run`` is ``{"kind", "reason", "detector_seen",
"detector_attributed"}``.  Safety and setup observations are propagated with
their real reason; every other inconsistency becomes ``FLAKY``.
"""

from __future__ import annotations

from typing import Any

FLAKY = "FLAKY"
_DEFAULT_EXPECTED = {"vulnerable": "failed", "patched": "passed"}


def _flaky() -> dict[str, Any]:
    return {"ok": False, "reason": FLAKY}


def decide(observations: Any) -> dict[str, Any]:
    """Return ``{"ok": bool, "reason": str|None}`` for two-seed observations."""
    if not isinstance(observations, dict):
        return _flaky()

    runs: dict[str, list[dict[str, Any]]] = {}
    for stage in ("vulnerable", "patched"):
        items = observations.get(stage)
        if not isinstance(items, list) or len(items) != 2:
            return _flaky()
        if any(not isinstance(run, dict) for run in items):
            return _flaky()
        runs[stage] = items

    # A safety or setup observation is evidence in its own right and must not
    # be flattened into a flake label.
    for stage in ("vulnerable", "patched"):
        for run in runs[stage]:
            kind = run.get("kind")
            if kind == "safety":
                reason = run.get("reason")
                return {
                    "ok": False,
                    "reason": reason if isinstance(reason, str) and reason else "SAFETY_FAILURE",
                }
            if kind == "setup":
                reason = run.get("reason")
                if isinstance(reason, str) and reason:
                    return {"ok": False, "reason": reason}
                suffix = "VULN" if stage == "vulnerable" else "PATCHED"
                return {"ok": False, "reason": f"SETUP_ERROR_{suffix}:crash"}

    expected = observations.get("expected")
    if not isinstance(expected, dict):
        expected = _DEFAULT_EXPECTED
    for stage in ("vulnerable", "patched"):
        want = expected.get(stage)
        for run in runs[stage]:
            if run.get("kind") != want:
                return _flaky()

    for run in runs["vulnerable"]:
        if not (run.get("detector_seen") and run.get("detector_attributed")):
            return _flaky()

    return {"ok": True, "reason": None}
