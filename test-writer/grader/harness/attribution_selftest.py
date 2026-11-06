"""Harness self-test: a genuine attributed detector hit.

This file is run by the M3 self-tests against a fixture snapshot.  It imports
the target entry point, calls it, and then reports a truthy condition.  The
expected harness report is ``outcome=failed`` with ``detector_seen`` and
``detector_attributed`` both true.
"""

from pkg.codec import decode


def test_attribution_selftest(detector, tmp_path):
    (tmp_path / "greeting.txt").write_text(
        "hello from the fixture\n", encoding="utf-8"
    )
    text = decode("greeting.txt", str(tmp_path))
    detector.check(bool(text), detail="harness attribution self-test")
    assert text == "hello from the fixture\n"
