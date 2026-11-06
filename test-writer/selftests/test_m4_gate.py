"""Rootless end-to-end self-tests for the M4 quality gates.

These tests reuse the M3 fixture harness: deterministic fixture repository,
real drafts, in-memory approval, and real bubblewrap runs.  Sandbox cases skip
explicitly when bubblewrap or the runtime venv is absent; no dependency or
production root is used.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:  # unittest discovery uses bare module names; direct runs use a package.
    from test_m3_gate import (  # type: ignore
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        VENV_PYTHON,
        _GateEnv,
    )
except ImportError:  # pragma: no cover - package-style invocation
    from selftests.test_m3_gate import (  # type: ignore
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        VENV_PYTHON,
        _GateEnv,
    )

WEAK_ABSOLUTE_TEST = """\
from pkg.codec import decode


def test_absolute_path(detector, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET\\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    result = None
    try:
        result = decode(str(secret), str(root))
    except ValueError:
        result = None
    detector.check(result is not None and "TOP SECRET" in result)
    assert result is None
"""

OVERFIT_TEST = """\
from pkg.codec import decode


def test_overfit_encoding(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET\\n", encoding="utf-8")
    locked = root / "locked"
    locked.mkdir()
    (locked / "x").write_text("x", encoding="utf-8")
    locked.chmod(0)
    (root / "locked%2fx").symlink_to(secret)
    result = None
    try:
        result = decode("locked%2fx", str(root))
    except ValueError:
        result = None
    detector.check(result is not None and "TOP SECRET" in result)
    assert result is None
"""

# No detector fixture and no detector call: the differential rests only on a
# plain assertion.  The gate must accept it as real behavioural evidence; the
# hidden variants and mutation gate remain the strength checks.
NO_DETECTOR_TEST = """\
from pkg.codec import decode


def test_decode_blocks_parent_traversal(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\\n", encoding="utf-8")
    result = None
    try:
        result = decode("../secret.txt", str(root))
    except ValueError:
        result = None
    assert result is None
"""

FLAKY_TEST = """\
from pkg.codec import decode


def test_hash_seed(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\\n", encoding="utf-8")
    result = None
    try:
        result = decode("../secret.txt", str(root))
    except ValueError:
        result = None
    leaked = result is not None and "TOP SECRET" in result
    if hash("flaky-proof-sentinel") % 2 == 0:
        detector.check(leaked, detail="decode escaped the fixture root")
        assert result is None
    else:
        detector.check(False)
        # Deliberately flaky: the observable outcome, not just detector
        # attribution, changes with the hash seed.
        assert result is not None
"""


def _refs(job_id: str = "j1") -> set[str]:
    data = json.loads((JOBS / job_id / "job.json").read_text(encoding="utf-8"))
    return {
        data["vulnerable_ref"],
        data["patched_ref"],
        data["variants"]["still_vulnerable_ref"],
        data["variants"]["fixed_differently_ref"],
    }


@unittest.skipUnless(GIT, "git executable not found; M4 gate tests skipped")
class M4GateTests(_GateEnv):
    def assert_no_hidden_material(self, job_id: str, payload: object) -> None:
        serialized = json.dumps(payload, sort_keys=True).lower()
        for ref in _refs(job_id):
            self.assertNotIn(ref, serialized)
        for marker in (
            "src-still-vulnerable",
            "src-fixed-differently",
            "mutant",
            # Target source fragments that only appear in mutant sources.
            "commonpath",
            "realpath",
        ):
            self.assertNotIn(marker, serialized)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_missing_variants_is_variant_missing(self):
        self.create_job("m4-missing", "j1", drop=("variants",))
        source = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        feedback = self.gate("m4-missing", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "QUALITY_ISSUE", feedback)
        self.assertIs(feedback["ok"], False, feedback)
        self.assertTrue(feedback["closed"], feedback)
        self.assert_marker_free(feedback)

        state = self.state("m4-missing")
        self.assertEqual(state["reason"], "VARIANT_MISSING")
        stored = self.report_json("m4-missing")
        self.assertEqual(stored["reason"], "VARIANT_MISSING")
        self.assertEqual(stored["gates"]["variants"], "fail")
        self.assertEqual(stored["gates"]["mutation"], "not_run")
        self.assertIn("VARIANT_MISSING", self.report_text("m4-missing"))
        self.assert_no_hidden_material("j1", feedback)
        self.assert_no_hidden_material("j1", stored)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_absolute_path_only_test_is_variant_too_weak(self):
        self.create_job("m4-weak", "j1")
        feedback = self.gate("m4-weak", WEAK_ABSOLUTE_TEST)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "QUALITY_ISSUE", feedback)
        self.assert_marker_free(feedback)
        state = self.state("m4-weak")
        self.assertEqual(state["reason"], "VARIANT_TOO_WEAK")
        stored = self.report_json("m4-weak")
        self.assertEqual(stored["gates"]["flake"], "pass")
        self.assertEqual(stored["gates"]["variants"], "fail")
        self.assertEqual(stored["gates"]["mutation"], "not_run")
        self.assertIn("VARIANT_TOO_WEAK", self.report_text("m4-weak"))
        self.assert_no_hidden_material("j1", feedback)
        self.assert_no_hidden_material("j1", stored)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_plain_assert_differential_is_proven_without_detector(self):
        # Regression for the forgeable-detector problem: gate 2/4/5 must not
        # depend on detector globals.  A plain ``assert`` that fails on the
        # vulnerable snapshot and passes the patched one is accepted, and the
        # hidden variants plus mutation remain the strength checks.
        self.create_job("m4-no-detector", "j1")
        feedback = self.gate("m4-no-detector", NO_DETECTOR_TEST)
        self.assertEqual(feedback["verdict"], "PROVEN", feedback)
        self.assertIs(feedback["ok"], True, feedback)
        self.assert_marker_free(feedback)

        stored = self.report_json("m4-no-detector")
        self.assertEqual(stored["gates"]["flake"], "pass")
        self.assertEqual(stored["gates"]["variants"], "pass")
        self.assertEqual(stored["gates"]["mutation"], "pass")
        # Detector state is still recorded, but it is zero here and was never
        # consulted as a pass condition.
        self.assertFalse(stored["counts"]["vulnerable"]["detector_seen"])
        self.assertFalse(stored["counts"]["vulnerable"]["detector_attributed"])
        self.assertEqual(stored["counts"]["vulnerable"]["detector_calls"], 0)
        self.assertGreaterEqual(stored["counts"]["mutation"]["score"], 0.8)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_overfit_test_is_variant_overfit(self):
        self.create_job("m4-overfit", "j1")
        feedback = self.gate("m4-overfit", OVERFIT_TEST)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "QUALITY_ISSUE", feedback)
        self.assert_marker_free(feedback)
        state = self.state("m4-overfit")
        self.assertEqual(state["reason"], "VARIANT_OVERFIT")
        stored = self.report_json("m4-overfit")
        self.assertEqual(stored["gates"]["variants"], "fail")
        self.assertEqual(stored["gates"]["mutation"], "not_run")
        self.assertIn("VARIANT_OVERFIT", self.report_text("m4-overfit"))
        self.assert_no_hidden_material("j1", feedback)
        self.assert_no_hidden_material("j1", stored)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_flaky_hash_seed_is_flaky(self):
        def parity(seed: int) -> str:
            env = os.environ.copy()
            env["PYTHONHASHSEED"] = str(seed)
            completed = subprocess.run(
                [
                    str(VENV_PYTHON),
                    "-c",
                    "print(hash('flaky-proof-sentinel') % 2)",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            return completed.stdout.strip()

        # The fixture is only meaningful if at least one extra seed differs
        # from the seed-0 run.
        self.assertTrue(
            parity(1) != parity(0) or parity(2) != parity(0),
            "the hash sentinel no longer changes parity across seeds",
        )

        self.create_job("m4-flaky", "j1")
        feedback = self.gate("m4-flaky", FLAKY_TEST)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "FLAKY", feedback)
        self.assertIs(feedback["ok"], False, feedback)
        self.assert_marker_free(feedback)
        state = self.state("m4-flaky")
        self.assertEqual(state["reason"], "FLAKY")
        stored = self.report_json("m4-flaky")
        self.assertEqual(stored["gates"]["flake"], "fail")
        self.assertEqual(stored["gates"]["variants"], "not_run")
        self.assertIn("FLAKY", self.report_text("m4-flaky"))

    def test_gate_seven_is_unavailable(self):
        self.create_job("m4-gate7")
        feedback = self.gate(
            "m4-gate7", "def test_x():\n    assert True\n", ["--gate", "7"]
        )
        self.assertEqual(feedback["reason"], "GATE_UNAVAILABLE")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_proven_report_and_feedback_hide_variant_and_mutant_material(self):
        self.create_job("m4-proven", "j1")
        source = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        feedback = self.gate("m4-proven", source)
        self.assertEqual(feedback["verdict"], "PROVEN", feedback)
        self.assertIs(feedback["ok"], True, feedback)
        self.assert_marker_free(feedback)
        self.assertGreaterEqual(feedback["counts"].get("mutation_score", 0.0), 0.8)
        self.assert_no_hidden_material("j1", feedback)

        stored = self.report_json("m4-proven")
        self.assertEqual(stored["gates"]["flake"], "pass")
        self.assertEqual(stored["gates"]["variants"], "pass")
        self.assertEqual(stored["gates"]["mutation"], "pass")
        mutation = stored["counts"]["mutation"]
        self.assertGreaterEqual(mutation["ran"], 1)
        self.assertGreaterEqual(mutation["score"], 0.8)
        self.assert_no_hidden_material("j1", stored)

        report = self.report_text("m4-proven")
        self.assertIn("## Flake", report)
        self.assertIn("## Variants", report)
        self.assertIn("## Mutation", report)
        self.assert_no_hidden_material("j1", report)

        inputs = self.status("m4-proven", "--inputs")
        self.assertEqual(set(inputs), {"status"})
        self.assert_no_hidden_material("j1", inputs)


if __name__ == "__main__":
    unittest.main()
