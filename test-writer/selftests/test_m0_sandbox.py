"""End-to-end M0 checks for the bubblewrap sandbox.

These run rootless as the invoking owner and use only temporary directories, so
nothing is written to /opt or /var/lib.  If bubblewrap is unavailable the class
skips with an explicit message; it never quietly treats a missing sandbox as a
pass.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader import sandbox_run  # noqa: E402

BWRAP = Path("/usr/bin/bwrap")


class M0SandboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BWRAP.is_file():
            raise unittest.SkipTest(
                "M0 sandbox tests require /usr/bin/bwrap; install bubblewrap and rerun"
            )
        cls.tmp_root = tempfile.mkdtemp(prefix="tw-selftest-")
        cls._saved = {
            key: os.environ.get(key)
            for key in ("TW_TMP_ROOT", "FAKE_SECRET")
        }
        os.environ["TW_TMP_ROOT"] = cls.tmp_root
        os.environ["FAKE_SECRET"] = "host-secret-value"

    @classmethod
    def tearDownClass(cls):
        for key, value in cls._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        import shutil

        shutil.rmtree(cls.tmp_root, ignore_errors=True)

    def run_sandbox(self, name, extra_env=None, **limits):
        result = sandbox_run.run_probe(
            f"selftests/probes/{name}",
            limits=limits,
            seed=7,
            extra_env=extra_env,
        )
        self.assertTrue(result["ok"], result)
        self.assertIsInstance(result.get("bwrap_version"), str)
        self.assertTrue(result["bwrap_version"])
        return result

    def test_environment_is_cleared_and_paths_are_hidden(self):
        result = self.run_sandbox(
            "env_probe.py",
            extra_env={"FAKE_SECRET": "injected-by-caller"},
        )
        report = json.loads(result["stdout"].strip().splitlines()[-1])
        interfaces = [tuple(item) for item in report["if_nameindex"]]
        self.assertEqual(interfaces, [(1, "lo")])
        self.assertIsNone(report["fake_secret"])
        self.assertFalse(report["home_exists"])
        self.assertFalse(report["store_exists"])
        self.assertNotEqual(report["write"], "allowed")
        self.assertNotIn("host-secret-value", json.dumps(result))

    def test_network_is_unreachable(self):
        result = self.run_sandbox("network_probe.py")
        self.assertIn("NETWORK_FAIL", result["stdout"])

    def test_cpu_limit(self):
        result = self.run_sandbox("cpu_probe.py", cpu_seconds=1, wall_seconds=4)
        self.assertTrue(
            result["limit_hit"] == "cpu" or result["signal"] == 24,
            result,
        )
        self.assertLess(result["duration_s"], 4.0)

    def test_memory_limit(self):
        result = self.run_sandbox(
            "memory_probe.py",
            memory_mb=64,
            cpu_seconds=5,
            wall_seconds=6,
        )
        self.assertEqual(result["limit_hit"], "memory", result)

    def test_process_limit(self):
        result = self.run_sandbox("fork_probe.py", max_pids=32, wall_seconds=6)
        self.assertIn("FORK_FAIL", result["stdout"], result)
        self.assertIn("EAGAIN", result["stdout"], result)
        self.assertEqual(result["limit_hit"], "pids", result)

    def test_file_size_limit(self):
        result = self.run_sandbox("file_probe.py", max_file_mb=4)
        self.assertEqual(result["limit_hit"], "file_size", result)

    def test_output_is_truncated(self):
        result = self.run_sandbox("output_probe.py", max_output_kb=64)
        self.assertTrue(result["stdout_truncated"], result)
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), 64 * 1024 + 4)
        self.assertEqual(result["limit_hit"], "output", result)

    def test_wall_limit_kills_the_process_group(self):
        result = self.run_sandbox("cpu_probe.py", cpu_seconds=20, wall_seconds=1)
        self.assertTrue(result["timed_out"], result)
        self.assertEqual(result["limit_hit"], "wall", result)
        self.assertLess(result["duration_s"], 4.0)

    def test_bad_limits_fail_closed(self):
        result = sandbox_run.run_probe(
            "selftests/probes/env_probe.py", limits={"cpu_seconds": 0}
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "bad_request")

    def test_missing_probe_fails_closed(self):
        result = sandbox_run.run_probe("selftests/probes/does_not_exist.py")
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "missing_probe")
        self.assertIn("message", result)

    def test_absolute_probe_outside_allowed_roots_is_rejected(self):
        # Rejection must happen before bwrap is consulted: point BWRAP at a
        # missing path and still expect the probe-root error, not bwrap_missing.
        original = sandbox_run.BWRAP
        sandbox_run.BWRAP = "/nonexistent/bwrap-for-m0-test"
        try:
            result = sandbox_run.run_probe("/etc/hostname")
        finally:
            sandbox_run.BWRAP = original
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "missing_probe")
        self.assertIn("allowed roots", result["message"])

    def test_relative_probe_works_and_normal_limits_are_not_clamped(self):
        result = sandbox_run.run_probe(
            "selftests/probes/env_probe.py",
            limits={"max_output_kb": 64},
            seed=7,
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["limits_clamped"], result)
        self.assertEqual(result["limits"]["max_output_kb"], 64)
        self.assertEqual(result["effective_limits"]["max_output_kb"], 64)

    def test_oversized_limits_are_clamped_and_reported(self):
        result = sandbox_run.run_probe(
            "selftests/probes/env_probe.py",
            limits={"max_output_kb": 10**9},
            seed=7,
        )
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["limits_clamped"], result)
        self.assertEqual(result["limits"]["max_output_kb"], 4096)
        self.assertEqual(result["effective_limits"]["max_output_kb"], 4096)
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), 4096 * 1024)

    def test_missing_bwrap_fails_closed(self):
        original = sandbox_run.BWRAP
        sandbox_run.BWRAP = "/nonexistent/bwrap-for-m0-test"
        try:
            result = sandbox_run.run_probe("selftests/probes/env_probe.py")
        finally:
            sandbox_run.BWRAP = original
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "bwrap_missing")


if __name__ == "__main__":
    unittest.main()
