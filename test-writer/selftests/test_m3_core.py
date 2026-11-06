"""Rootless self-tests for the M3 core.

These tests use only the Python standard library and temporary roots.  They do
not contact the network, use sudo, invoke the gate wrappers, or read the
production store.  Sandbox cases skip with an explicit message when bubblewrap
or the runtime venv is absent; a missing dependency is never treated as a pass.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader import extract_interface, job_check, package, sandbox_run, store  # noqa: E402

FIXTURES = ROOT / "fixtures"
STATES = FIXTURES / "states"
JOBS = FIXTURES / "jobs"
HARNESS = ROOT / "grader" / "harness"
BUILDER = FIXTURES / "build_fixtures.py"
BWRAP = Path("/usr/bin/bwrap")
VENV_PYTHON = Path("/opt/test-writer/venv/bin/python")
GIT = shutil.which("git")
SANDBOX_SKIP = (
    "M3 sandbox tests require /usr/bin/bwrap and "
    "/opt/test-writer/venv/bin/python; install the sandbox runtime and rerun"
)


def _proven_eligible(result):
    """True only when the gate could ever reach PROVEN from this result.

    Mirrors the gate's hard safety gate: a missing report, a canary read, or
    any sandbox violation disqualifies the run before snapshot comparison.
    """
    report = result.get("report")
    if not result.get("ok") or not isinstance(report, dict):
        return False
    if report.get("canary_read") or report.get("violations"):
        return False
    return True


class _TempEnv(unittest.TestCase):
    """Give each test class isolated store, scratch, and workspace roots."""

    @classmethod
    def setUpClass(cls):
        cls._saved = {
            key: os.environ.get(key)
            for key in ("TW_STORE_ROOT", "TW_TMP_ROOT", "TW_WORKSPACE_ROOT")
        }
        cls._temp = Path(tempfile.mkdtemp(prefix="tw-m3-"))
        os.environ["TW_STORE_ROOT"] = str(cls._temp / "store")
        os.environ["TW_TMP_ROOT"] = str(cls._temp / "tmp")
        os.environ["TW_WORKSPACE_ROOT"] = str(cls._temp / "workspace")

    @classmethod
    def tearDownClass(cls):
        for key, value in cls._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(cls._temp, ignore_errors=True)


class ReportContractTests(unittest.TestCase):
    """Unit-level invariants for report shape, MAC, and exit agreement."""

    @staticmethod
    def _report(**overrides):
        data = {
            "schema": "tw-test-report/v1",
            "outcome": "passed",
            "tests_collected": 1,
            "tests_run": 1,
            "failures": [],
            "detector_seen": False,
            "detector_attributed": False,
            "detector_calls": 0,
            "canary_read": False,
            "violations": [],
            "target_called": False,
            "module_imported": True,
            "error": None,
            "pytest_exit": 0,
            "mac": "0" * 64,
        }
        data.update(overrides)
        return data

    def test_report_shape_rejects_extra_keys(self):
        self.assertTrue(sandbox_run._valid_report(self._report()))
        self.assertFalse(sandbox_run._valid_report(self._report(extra=1)))
        failed = {
            "outcome": "failed",
            "error": None,
            "pytest_exit": 1,
            "failures": [{"type": "AssertionError", "phase": "call", "extra": 1}],
        }
        self.assertFalse(sandbox_run._valid_report(self._report(**failed)))

    def test_mac_round_trip_and_key_mismatch(self):
        key = "a" * 64
        unsigned = self._report()
        unsigned.pop("mac")
        canonical = json.dumps(
            unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        unsigned["mac"] = hmac.new(
            key.encode("utf-8"), canonical, hashlib.sha256
        ).hexdigest()
        self.assertTrue(sandbox_run._valid_report_mac(unsigned, key))
        self.assertFalse(sandbox_run._valid_report_mac(unsigned, "b" * 64))
        unsigned["outcome"] = "failed"
        self.assertFalse(sandbox_run._valid_report_mac(unsigned, key))

    def test_passed_requires_zero_exit_and_matching_pytest_exit(self):
        report = self._report()
        self.assertTrue(sandbox_run._exit_consistent(report, 0, None))
        self.assertFalse(sandbox_run._exit_consistent(report, 1, None))
        self.assertFalse(sandbox_run._exit_consistent(report, 0, 9))
        self.assertFalse(
            sandbox_run._exit_consistent(self._report(pytest_exit=1), 0, None)
        )

    def test_failed_requires_nonzero_exit(self):
        report = self._report(
            outcome="failed",
            failures=[{"type": "AssertionError", "phase": "call"}],
            pytest_exit=1,
        )
        self.assertTrue(sandbox_run._exit_consistent(report, 1, None))
        self.assertFalse(sandbox_run._exit_consistent(report, 0, None))
        no_failure = self._report(outcome="failed", pytest_exit=1)
        self.assertFalse(sandbox_run._exit_consistent(no_failure, 1, None))

    def test_error_exit_matrix(self):
        cases = {
            "no_tests": ({0, 5}, {1, 2}),
            "skipped": ({0, 5}, {1, 2}),
            # These kinds merely require a non-zero exit; pytest's specific
            # code is not constrained beyond that.
            "collection": ({1, 2, 5}, {0}),
            "import": ({1, 2, 5}, {0}),
            "crash": ({1, 2, 5}, {0}),
            "forbidden_fixture": ({1, 2, 5}, {0}),
        }
        for error, (accepted, rejected) in cases.items():
            for exit_code in accepted:
                with self.subTest(error=error, exit=exit_code):
                    report = self._report(
                        outcome="error", error=error, pytest_exit=exit_code
                    )
                    self.assertTrue(
                        sandbox_run._exit_consistent(report, exit_code, None)
                    )
            for exit_code in rejected:
                with self.subTest(error=error, exit=exit_code):
                    report = self._report(
                        outcome="error", error=error, pytest_exit=exit_code
                    )
                    self.assertFalse(
                        sandbox_run._exit_consistent(report, exit_code, None)
                    )

    def test_error_requires_an_error_kind(self):
        report = self._report(outcome="error", error=None, pytest_exit=1)
        self.assertFalse(sandbox_run._exit_consistent(report, 1, None))


class StoreTests(_TempEnv):
    def test_state_round_trip_and_permissions(self):
        job_id = "state-job"
        state = {
            "status": "draft",
            "verdict": None,
            "reason": None,
            "flags": [],
            "attempts": 0,
            "max_attempts": 3,
        }
        written = store.write_state(job_id, state)
        loaded = store.load_state(job_id)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded["id"], job_id)
        self.assertEqual(loaded["status"], "draft")
        self.assertEqual(loaded["attempts"], 0)
        self.assertEqual(loaded["max_attempts"], 3)
        self.assertEqual(loaded["created_at"], written["created_at"])
        self.assertIsInstance(loaded["updated_at"], str)
        self.assertTrue(loaded["updated_at"].endswith("Z"))

        directory = store.job_dir(job_id)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            (directory / store.STATE_FILE).stat().st_mode & 0o777, 0o600
        )
        self.assertFalse(store.is_closed(job_id))
        store.write_state(job_id, {**state, "status": "closed"})
        self.assertTrue(store.is_closed(job_id))

    def test_meta_round_trip(self):
        job_id = "meta-job"
        meta = {"id": job_id, "module": "pkg.codec"}
        store.write_meta(job_id, meta)
        self.assertEqual(store.read_meta(job_id), meta)

    def test_lock_is_busy_across_processes(self):
        job_id = "lock-job"
        lock = store.acquire_job_lock(job_id)
        script = (
            "import sys\n"
            f"sys.path.insert(0, {str(ROOT)!r})\n"
            "from grader import store\n"
            "try:\n"
            f"    held = store.acquire_job_lock({job_id!r})\n"
            "except store.BusyError:\n"
            "    print('BUSY')\n"
            "else:\n"
            "    held.release()\n"
            "    print('ACQUIRED')\n"
        )
        try:
            first = subprocess.run(
                [sys.executable, "-c", script],
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(first.stdout.strip(), "BUSY")
        finally:
            lock.release()

        second = subprocess.run(
            [sys.executable, "-c", script],
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(second.stdout.strip(), "ACQUIRED")


class JobCheckTests(unittest.TestCase):
    def _valid_meta(self):
        return json.loads((JOBS / "j1" / "job.json").read_text(encoding="utf-8"))

    def test_accepts_real_fixture_job(self):
        meta = self._valid_meta()
        self.assertEqual(job_check.validate_meta(meta), [])
        job_check.assert_valid_meta(meta)

    def test_rejects_bad_id_ref_and_spec(self):
        meta = self._valid_meta()
        broken_id = {**meta, "id": "bad id!"}
        self.assertIn(job_check.BAD_ID, job_check.validate_meta(broken_id))

        broken_ref = {**meta, "vulnerable_ref": "abc"}
        self.assertIn(job_check.BAD_REF, job_check.validate_meta(broken_ref))

        same_ref = {**meta, "patched_ref": meta["vulnerable_ref"]}
        self.assertIn(job_check.SAME_REF, job_check.validate_meta(same_ref))

        broken_spec = {
            **meta,
            "spec_markdown": meta["spec_markdown"].replace("## Detector", "## Other"),
        }
        self.assertIn(job_check.BAD_SPEC, job_check.validate_meta(broken_spec))

        with self.assertRaises(job_check.JobMetaError) as caught:
            job_check.assert_valid_meta(broken_id)
        self.assertIn(job_check.BAD_ID, caught.exception.errors)

    def test_rejects_other_boundary_values(self):
        meta = self._valid_meta()
        cases = {
            "module": ({**meta, "module": "pkg..codec"}, job_check.BAD_MODULE),
            "function": ({**meta, "function": "not a function"}, job_check.BAD_FUNCTION),
            "path": ({**meta, "python_path": ["../src"]}, job_check.BAD_PATH),
            "origin": ({**meta, "fix_origin": "vendor"}, job_check.BAD_FIX_ORIGIN),
            "budget": (
                {**meta, "budget": {**meta["budget"], "wall_seconds": 10**9}},
                job_check.BAD_BUDGET,
            ),
        }
        for label, (candidate, token) in cases.items():
            with self.subTest(label=label):
                self.assertIn(token, job_check.validate_meta(candidate))


class InterfaceTests(unittest.TestCase):
    def test_finds_decode_in_state_a(self):
        signature = extract_interface.extract_function(
            STATES / "a", "pkg.codec", "decode", ["."]
        )
        self.assertEqual(signature, "decode(name: str, root: str) -> str")

    def test_assert_entry_checks_metadata_signature(self):
        meta = json.loads((JOBS / "j1" / "job.json").read_text(encoding="utf-8"))
        self.assertEqual(
            extract_interface.assert_entry(STATES / "a", meta),
            "decode(name: str, root: str) -> str",
        )

    def test_does_not_execute_module_side_effects(self):
        with tempfile.TemporaryDirectory(prefix="tw-interface-") as temp_name:
            root = Path(temp_name)
            package = root / "pkg"
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
            marker = root / "executed.txt"
            (package / "side.py").write_text(
                "from pathlib import Path\n"
                f"Path({str(marker)!r}).write_text('executed', encoding='utf-8')\n"
                "\n"
                "def entry(value: int) -> int:\n"
                "    return value\n",
                encoding="utf-8",
            )
            signature = extract_interface.extract_function(
                root, "pkg.side", "entry", ["."]
            )
            self.assertEqual(signature, "entry(value: int) -> int")
            self.assertFalse(marker.exists())

    def test_missing_and_broken_entries_are_typed(self):
        with self.assertRaises(extract_interface.InterfaceError) as missing:
            extract_interface.extract_function(STATES / "a", "pkg.nope", "x")
        self.assertEqual(missing.exception.kind, "missing_module")

        with self.assertRaises(extract_interface.InterfaceError) as missing_fn:
            extract_interface.extract_function(STATES / "a", "pkg.codec", "nope")
        self.assertEqual(missing_fn.exception.kind, "missing_function")

        with tempfile.TemporaryDirectory(prefix="tw-syntax-") as temp_name:
            root = Path(temp_name)
            (root / "broken.py").write_text("def broken(:\n", encoding="utf-8")
            with self.assertRaises(extract_interface.InterfaceError) as syntax:
                extract_interface.extract_function(root, "broken", "broken")
            self.assertEqual(syntax.exception.kind, "syntax")


@unittest.skipUnless(GIT, "git executable not found; package tests skipped")
class PackageTests(_TempEnv):
    @classmethod
    def setUpClass(cls):
        _TempEnv.setUpClass()
        cls._repo = cls._temp / "repo"
        built = subprocess.run(
            [sys.executable, str(BUILDER), "--out", str(cls._repo)],
            cwd=str(cls._temp),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if built.returncode != 0:
            raise unittest.SkipTest(f"fixture build failed: {built.stderr.strip()}")
        cls._meta = json.loads((JOBS / "j1" / "job.json").read_text(encoding="utf-8"))
        cls._tar = cls._temp / "snapshot.tar"
        package.build_snapshot_tar(
            cls._repo, cls._meta["vulnerable_ref"], cls._tar
        )

    def test_extracts_real_state_tar(self):
        destination = self._temp / "extract-real"
        extracted = package.safe_extract(self._tar, destination)
        self.assertIn("pkg/codec.py", extracted)
        self.assertEqual(
            (destination / "pkg" / "codec.py").read_bytes(),
            (STATES / "a" / "pkg" / "codec.py").read_bytes(),
        )
        self.assertEqual(
            package.verify_snapshot(
                self._tar, "pkg.codec", "decode", ["."]
            ),
            "decode(name: str, root: str) -> str",
        )

    def test_build_rejects_non_commit_ref(self):
        with self.assertRaises(package.PackageError):
            package.build_snapshot_tar(self._repo, "0" * 40, self._temp / "nope.tar")

    def test_safe_extract_rejects_traversal(self):
        traversal = self._temp / "traversal.tar"
        with tarfile.open(traversal, mode="w") as archive:
            payload = b"escape"
            info = tarfile.TarInfo("../escape.txt")
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        destination = self._temp / "extract-traversal"
        with self.assertRaises(package.PackageError):
            package.safe_extract(traversal, destination)
        self.assertFalse((destination.parent / "escape.txt").exists())

    def test_safe_extract_rejects_symlink_and_absolute(self):
        for name, info_factory in (
            ("absolute.tar", lambda: tarfile.TarInfo("/etc/passwd")),
            ("symlink.tar", lambda: tarfile.TarInfo("link")),
        ):
            path = self._temp / name
            with tarfile.open(path, mode="w") as archive:
                info = info_factory()
                if name == "symlink.tar":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/passwd"
                else:
                    info.size = 0
                archive.addfile(info, io.BytesIO(b""))
            with self.subTest(archive=name):
                with self.assertRaises(package.PackageError):
                    package.safe_extract(path, self._temp / f"extract-{name}")


@unittest.skipUnless(
    BWRAP.is_file() and VENV_PYTHON.is_file(),
    SANDBOX_SKIP,
)
class SandboxTestModeTests(_TempEnv):
    LIMITS = {
        "wall_seconds": 30,
        "cpu_seconds": 10,
        "memory_mb": 256,
        "max_pids": 64,
        "max_file_mb": 16,
        "max_output_kb": 256,
    }

    def run_test(self, test_file, canary="CANARY-SELFTEST-VALUE", unsafe_return=None):
        return sandbox_run.run_test(
            snapshot_dir=STATES / "a",
            test_file=test_file,
            harness_dir=HARNESS,
            module="pkg.codec",
            function="decode",
            limits=self.LIMITS,
            seed=7,
            canary=canary,
            unsafe_return=unsafe_return,
        )

    def write_test(self, source: str) -> Path:
        path = self._temp / f"test-{len(list(self._temp.glob('test-*.py')))}.py"
        path.write_text(source, encoding="utf-8")
        return path

    def test_control_test_passes(self):
        result = self.run_test(HARNESS / "control_test.py")
        self.assertTrue(result["ok"], result)
        self.assertIsNone(result["report_error"], result)
        report = result["report"]
        self.assertIsNotNone(report)
        assert report is not None
        self.assertEqual(report["outcome"], "passed")
        self.assertIsNone(report["error"])
        self.assertEqual(report["tests_collected"], 1)
        self.assertEqual(report["tests_run"], 1)
        self.assertEqual(report["failures"], [])
        self.assertFalse(report["target_called"])
        self.assertTrue(report["module_imported"])
        self.assertEqual(report["detector_calls"], 0)

    def test_forged_report_is_rejected_even_when_directory_is_readonly(self):
        # A lint-free test can write a plausible ``passed`` report and then
        # remove write permission from ``/work/out`` so the plugin cannot
        # atomically replace it.  The parent must authenticate the report and
        # reject the forged document instead of trusting its shape.
        forged = json.dumps(
            {
                "schema": "tw-test-report/v1",
                "outcome": "passed",
                "tests_collected": 1,
                "tests_run": 1,
                "failures": [],
                "detector_seen": True,
                "detector_attributed": True,
                "detector_calls": 1,
                "canary_read": False,
                "violations": [],
                "target_called": True,
                "module_imported": True,
                "error": None,
                "pytest_exit": 0,
                # A syntactically valid but uncorrelated MAC.  Only the parent's
                # per-run key can produce the real signature.
                "mac": "0" * 64,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        path = self.write_test(
            "def test_forges_report(detector, tmp_path):\n"
            f"    forged = {forged!r}\n"
            "    with open('/work/out/report.json', 'w', encoding='utf-8') as handle:\n"
            "        handle.write(forged)\n"
            "    type(tmp_path)('/work/out').chmod(0o500)\n"
            "    detector.check(True)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        self.assertIsNone(result["report"], result)
        self.assertEqual(result["report_error"], "invalid", result)
        self.assertFalse(_proven_eligible(result), result)

    def test_attribution_selftest_is_failed_and_attributed(self):
        result = self.run_test(HARNESS / "attribution_selftest.py")
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "failed")
        self.assertTrue(report["detector_seen"])
        self.assertTrue(report["detector_attributed"])
        self.assertTrue(report["target_called"])
        self.assertEqual(report["failures"][0]["type"], "AssertionError")
        self.assertNotIn("harness attribution self-test", json.dumps(report))

    def test_canary_read_is_recorded_not_blocked(self):
        path = self.write_test(
            "def test_reads_canary():\n"
            "    with open('/canary/value', 'r', encoding='utf-8') as handle:\n"
            "        handle.read()\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "passed")
        self.assertTrue(report["canary_read"])
        self.assertNotIn("CANARY-SELFTEST-VALUE", json.dumps(result))

    def test_subprocess_violation_is_recorded(self):
        path = self.write_test(
            "import subprocess\n"
            "\n"
            "def test_subprocess_is_blocked():\n"
            "    try:\n"
            "        subprocess.run(['true'], check=False)\n"
            "    except RuntimeError:\n"
            "        pass\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertIn("subprocess", report["violations"])
        self.assertEqual(report["outcome"], "passed")

    def test_hypothesis_runs_without_proc(self):
        path = self.write_test(
            "from hypothesis import given, strategies as st\n\n\n"
            "@given(st.integers(max_value=-1))\n"
            "def test_hypothesis_runs(value):\n"
            "    assert value < 0\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "passed")
        self.assertTrue(report["module_imported"])
        self.assertEqual(report["tests_collected"], 1)

    def test_forbidden_request_fixture_is_setup_error(self):
        path = self.write_test(
            "def test_forbidden(detector, request):\n"
            "    detector.check(False)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["error"], "forbidden_fixture")
        self.assertEqual(report["outcome"], "error")
        self.assertFalse(report["detector_seen"])
        self.assertFalse(report["detector_attributed"])
        self.assertEqual(report["detector_calls"], 0)

    def test_forbidden_pytestconfig_fixture_is_setup_error(self):
        path = self.write_test(
            "def test_forbidden(detector, pytestconfig):\n"
            "    detector.check(False)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["error"], "forbidden_fixture")
        self.assertEqual(report["outcome"], "error")
        self.assertFalse(report["detector_seen"])

    def test_target_source_read_is_blocked(self):
        path = self.write_test(
            "def test_reads_target_source(detector):\n"
            "    try:\n"
            "        with open('/work/src/pkg/codec.py', 'r', encoding='utf-8') as handle:\n"
            "            handle.read()\n"
            "    except RuntimeError:\n"
            "        pass\n"
            "    detector.check(False)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertIn("sensitive_read", report["violations"])
        self.assertFalse(report["detector_seen"])

    def test_open_code_target_source_read_is_blocked(self):
        # ``io.open_code`` is the import machinery's read path and lint does not
        # cover it.  Called directly from a test it must obey the same
        # frame-aware rule as ``open``: test frames never read the target
        # snapshot, so the uncaught block fails the run.
        path = self.write_test(
            "import io\n\n\n"
            "def test_reads_target_via_open_code(detector):\n"
            "    io.open_code('/work/src/pkg/codec.py').read()\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertIn("sensitive_read", report["violations"])
        self.assertNotEqual(report["outcome"], "passed")
        self.assertFalse(_proven_eligible(result))

    def test_target_directory_listing_is_blocked(self):
        path = self.write_test(
            "import os\n\n\n"
            "def test_lists_target_source(detector):\n"
            "    try:\n"
            "        os.listdir('/work/src/pkg')\n"
            "    except RuntimeError:\n"
            "        pass\n"
            "    detector.check(False)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertIn("sensitive_read", report["violations"])

    def test_target_reading_own_source_during_test_is_blocked(self):
        path = self.write_test(
            "from pkg.codec import decode\n\n\n"
            "def test_target_reads_source(detector):\n"
            "    data = decode('pkg/codec.py', '/work/src')\n"
            "    detector.check('realpath' in data)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertIn("sensitive_read", report["violations"])
        self.assertEqual(report["outcome"], "failed")
        self.assertFalse(report["detector_attributed"])

    def test_normal_decode_on_tmp_path_still_passes(self):
        path = self.write_test(
            "from pkg.codec import decode\n\n\n"
            "def test_normal_read(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (root / 'greeting.txt').write_text('hello\\n', encoding='utf-8')\n"
            "    assert decode('greeting.txt', str(root)) == 'hello\\n'\n"
            "    detector.check(False)\n"
        )
        result = self.run_test(path)
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "passed")
        self.assertEqual(report["violations"], [])
        self.assertTrue(report["target_called"])

    def test_detector_without_target_is_not_a_hit(self):
        path = self.write_test(
            "def test_false_hit(detector):\n"
            "    detector.check(True)\n"
        )
        result = self.run_test(path, unsafe_return="TOP SECRET")
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "failed")
        self.assertFalse(report["detector_seen"])
        self.assertFalse(report["detector_attributed"])
        self.assertEqual(report["detector_calls"], 1)
        self.assertEqual(report["failures"][0]["type"], "AssertionError")
        self.assertNotIn("TOP SECRET", json.dumps(report))

    def test_detector_with_wrong_target_return_is_not_a_hit(self):
        path = self.write_test(
            "from pkg.codec import decode\n\n\n"
            "def test_false_hit(detector, tmp_path):\n"
            "    (tmp_path / 'greeting.txt').write_text('hello\\n', encoding='utf-8')\n"
            "    decode('greeting.txt', str(tmp_path))\n"
            "    detector.check(True)\n"
        )
        result = self.run_test(path, unsafe_return="TOP SECRET")
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertTrue(report["target_called"])
        self.assertFalse(report["detector_seen"])
        self.assertFalse(report["detector_attributed"])

    def test_detector_marker_hit_is_attributed(self):
        path = self.write_test(
            "from pkg.codec import decode\n\n\n"
            "def test_marker_hit(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (tmp_path / 'secret.txt').write_text('TOP SECRET\\n', encoding='utf-8')\n"
            "    text = decode('../secret.txt', str(root))\n"
            "    detector.check('TOP SECRET' in text)\n"
        )
        result = self.run_test(path, unsafe_return="TOP SECRET")
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["outcome"], "failed")
        self.assertTrue(report["detector_seen"])
        self.assertTrue(report["detector_attributed"])
        self.assertNotIn("TOP SECRET", json.dumps(report))

    def test_unsafe_return_validation(self):
        path = self.write_test(
            "def test_control(detector):\n"
            "    detector.check(False)\n"
        )
        for value in ("TOP\x00SECRET", "x" * 513):
            with self.subTest(value=value[:8]):
                result = self.run_test(path, unsafe_return=value)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["setup_error"], "bad_request")

    def test_missing_venv_fails_closed(self):
        original = sandbox_run.VENV_PYTHON
        sandbox_run.VENV_PYTHON = "/nonexistent/tw-venv/bin/python"
        try:
            result = self.run_test(HARNESS / "control_test.py")
        finally:
            sandbox_run.VENV_PYTHON = original
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "venv_missing")

    def test_missing_snapshot_fails_closed(self):
        result = sandbox_run.run_test(
            snapshot_dir=self._temp / "does-not-exist",
            test_file=HARNESS / "control_test.py",
            harness_dir=HARNESS,
            module="pkg.codec",
            function="decode",
            limits=self.LIMITS,
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["setup_error"], "missing_snapshot")


if __name__ == "__main__":
    unittest.main()
