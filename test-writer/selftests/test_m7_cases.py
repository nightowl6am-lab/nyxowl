"""Rootless self-tests for the M7-lite evaluation cases.

The tests validate the seven case documents, the deterministic builder refs, the
proof-test lint result, and the cheap payload behavior of every fixture state.
They never run the six-gate pipeline and never use bubblewrap; the real matrix
is the separate ``qa/m7_lite_eval.py`` runner.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader import job_check, lint  # noqa: E402

CASES_DIR = ROOT / "qa" / "m7_cases"
STATES_DIR = ROOT / "fixtures" / "states"
BUILDER = ROOT / "fixtures" / "build_fixtures.py"
JOBS = ROOT / "fixtures" / "jobs"
CASE_IDS = ("c1", "c2", "c3", "c4", "c5", "n1", "n2")
EXPECTED_VERDICTS = {"PROVEN", "UNPROVEN", "REFUTED"}
EXPECTED_REASONS = {
    None,
    "NO_DETECTOR_HIT_ON_VULN",
    "PATCHED_STILL_LEAKS",
}
EXPECTED_RESULTS = {
    "c1": ("PROVEN", None),
    "c2": ("PROVEN", None),
    "c3": ("PROVEN", None),
    "c4": ("PROVEN", None),
    "c5": ("PROVEN", None),
    "n1": ("UNPROVEN", "NO_DETECTOR_HIT_ON_VULN"),
    "n2": ("REFUTED", "PATCHED_STILL_LEAKS"),
}
STATE_NAMES = (
    "a",
    "b",
    "c",
    "d",
    "e",
    "sv",
    "fd",
    "m7v1",
    "m7p1",
    "m7v3",
    "m7p3",
    "m7v4",
    "m7p4",
    "m7v5",
    "m7p5",
)
# These refs are recorded in the existing M1/M4 job fixtures and must not move
# when new independent state roots are appended to the builder.
FROZEN_REFS = {
    "a": "d07256445625c9590ffe352674097049108abb21",
    "b": "821afb1690782bde11724bb9f6a51ff71f563300",
    "c": "8dd1c7adc41487312d8deb6fe1a139bef9aabd94",
    "d": "6518d116ceadab64e2a6af8d89833a379895613e",
    "e": "b6bc52a15415f6cd0f520951b8726d6e1efd3406",
    "sv": "aa1bc76e3c73e94690b0d7936841df2507bf4c97",
    "fd": "83ee4c564b8dd49c8e4886f8fe5f1a8b89d2a707",
}
# state -> payload -> leaks outside the fixture root
PAYLOAD_EXPECTATIONS = {
    "a": {"../secret.txt": True, "%2e%2e/secret.txt": False},
    "b": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "c": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "d": {"../secret.txt": False, "%2e%2e/secret.txt": True},
    "e": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "sv": {"../secret.txt": True, "%2e%2e/secret.txt": False},
    "fd": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "m7v1": {"../secret.txt": True, "%2e%2e/secret.txt": False},
    "m7p1": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "m7v3": {"../secret.txt": True, "%2e%2e/secret.txt": False},
    "m7p3": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "m7v4": {"../secret.txt": True, "%2e%2e/secret.txt": True},
    "m7p4": {"../secret.txt": False, "%2e%2e/secret.txt": False},
    "m7v5": {"../secret.txt": True, "..\\secret.txt": True},
    "m7p5": {"../secret.txt": False, "..\\secret.txt": False},
}
_MODULES: dict[str, object] = {}


def _builder_refs() -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(BUILDER), "--print-refs"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=180,
    )
    if completed.returncode != 0:
        raise AssertionError(f"builder --print-refs failed: {completed.stderr}")
    return json.loads(completed.stdout)


def _load_codec(state: str):
    module = _MODULES.get(state)
    if module is not None:
        return module
    path = STATES_DIR / state / "pkg" / "codec.py"
    spec = importlib.util.spec_from_file_location(f"m7_state_{state}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _MODULES[state] = module
    return module


class CaseDocumentTests(unittest.TestCase):
    def test_case_directories_and_ids(self):
        found = sorted(path.name for path in CASES_DIR.iterdir() if path.is_dir())
        self.assertEqual(found, list(CASE_IDS))
        for case_id in CASE_IDS:
            directory = CASES_DIR / case_id
            self.assertTrue((directory / "case.json").is_file(), case_id)
            self.assertTrue((directory / "test_proof.py").is_file(), case_id)

    def test_case_documents_are_valid(self):
        for case_id in CASE_IDS:
            with self.subTest(case=case_id):
                data = json.loads(
                    (CASES_DIR / case_id / "case.json").read_text(encoding="utf-8")
                )
                self.assertEqual(data["id"], case_id)
                self.assertIsInstance(data["alias"], str)
                self.assertTrue(data["alias"].strip())
                self.assertEqual(
                    set(data["variant_states"]),
                    {"still_vulnerable", "fixed_differently"},
                )
                self.assertEqual(
                    data["variant_states"],
                    {"still_vulnerable": "sv", "fixed_differently": "fd"},
                )
                self.assertEqual(
                    (data["expected_verdict"], data["expected_reason"]),
                    EXPECTED_RESULTS[case_id],
                )
                self.assertIn(data["expected_verdict"], EXPECTED_VERDICTS)
                self.assertIn(data["expected_reason"], EXPECTED_REASONS)
                self.assertNotEqual(data["from_state"], data["to_state"])
                self.assertIn(data["from_state"], STATE_NAMES)
                self.assertIn(data["to_state"], STATE_NAMES)

                spec = data["spec_markdown"]
                lines = [line.strip() for line in spec.splitlines()]
                for heading in job_check.REQUIRED_HEADINGS:
                    self.assertEqual(lines.count(heading), 1, heading)
                benign = [line for line in lines if line.startswith("BENIGN:")]
                self.assertEqual(len(benign), 1, "BENIGN line")
                self.assertLessEqual(len(benign[0]), job_check.BENIGN_MAX_CHARS)

                meta = {
                    key: value
                    for key, value in data.items()
                    if key
                    not in {
                        "alias",
                        "variant_states",
                        "from_state",
                        "to_state",
                        "expected_verdict",
                        "expected_reason",
                    }
                }
                meta["vulnerable_ref"] = "1" * 40
                meta["patched_ref"] = "2" * 40
                meta["variants"] = {
                    "still_vulnerable_ref": "3" * 40,
                    "fixed_differently_ref": "4" * 40,
                }
                self.assertEqual(job_check.validate_meta(meta), [])

    def test_expected_proven_payloads_cover_still_vulnerable_state(self):
        for case_id in ("c1", "c2", "c4", "c5"):
            with self.subTest(case=case_id):
                source = (CASES_DIR / case_id / "test_proof.py").read_text(
                    encoding="utf-8"
                )
                self.assertIn('"../secret.txt"', source)
        c3 = (CASES_DIR / "c3" / "test_proof.py").read_text(encoding="utf-8")
        self.assertIn('"../app2/secret.txt"', c3)
        c5 = (CASES_DIR / "c5" / "test_proof.py").read_text(encoding="utf-8")
        self.assertIn('"..\\\\secret.txt"', c5)

    def test_proof_sources_lint_clean(self):
        for case_id in CASE_IDS:
            with self.subTest(case=case_id):
                source = (CASES_DIR / case_id / "test_proof.py").read_text(
                    encoding="utf-8"
                )
                self.assertEqual(
                    lint.lint_source(source, allowed_modules=["pkg.codec"]), []
                )


class BuilderRefTests(unittest.TestCase):
    def test_print_refs_shape_and_determinism(self):
        first = _builder_refs()
        second = _builder_refs()
        self.assertEqual(first, second)
        self.assertEqual(set(first), {"states", "refs"})
        states = first["states"]
        self.assertIsInstance(states, dict)
        self.assertTrue(set(STATE_NAMES).issubset(states))
        for name in STATE_NAMES:
            self.assertRegex(states[name], r"^[0-9a-f]{40}$")
        for name, value in FROZEN_REFS.items():
            self.assertEqual(states[name], value, name)
        refs = first["refs"]
        for name in STATE_NAMES:
            self.assertEqual(refs[f"refs/heads/state-{name}"], states[name])

    def test_recorded_jobs_still_match_frozen_refs(self):
        mapping = {
            "j1": ("a", "b"),
            "j2": ("c", "b"),
            "j3": ("a", "d"),
            "j4": ("a", "e"),
        }
        for job_id, (from_state, to_state) in mapping.items():
            data = json.loads(
                (JOBS / job_id / "job.json").read_text(encoding="utf-8")
            )
            self.assertEqual(data["vulnerable_ref"], FROZEN_REFS[from_state])
            self.assertEqual(data["patched_ref"], FROZEN_REFS[to_state])
            self.assertEqual(
                data["variants"]["still_vulnerable_ref"], FROZEN_REFS["sv"]
            )
            self.assertEqual(
                data["variants"]["fixed_differently_ref"], FROZEN_REFS["fd"]
            )


class StatePayloadTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory(prefix="tw-m7-states-")
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name) / "root"
        self.root.mkdir()
        (self.root / "data").mkdir()
        (self.root / "data" / "greeting.txt").write_text(
            "hello from the fixture\n", encoding="utf-8"
        )
        (Path(self._temp.name) / "secret.txt").write_text(
            "TOP SECRET\n", encoding="utf-8"
        )

    def _leaks(self, state: str, payload: str) -> bool:
        module = _load_codec(state)
        try:
            result = module.decode(payload, str(self.root))
        except (ValueError, OSError):
            return False
        return "TOP SECRET" in result

    def test_clean_name_returns_greeting_for_every_state(self):
        for state in STATE_NAMES:
            with self.subTest(state=state):
                module = _load_codec(state)
                self.assertEqual(
                    module.decode("data/greeting.txt", str(self.root)),
                    "hello from the fixture\n",
                )

    def test_payload_behavior_matches_table(self):
        for state, expectations in PAYLOAD_EXPECTATIONS.items():
            for payload, expected in expectations.items():
                with self.subTest(state=state, payload=payload):
                    self.assertEqual(self._leaks(state, payload), expected)

    def test_c3_sibling_payload_behavior(self):
        base = Path(self._temp.name)
        root = base / "app"
        (root / "data").mkdir(parents=True)
        (root / "data" / "greeting.txt").write_text(
            "hello from the fixture\n", encoding="utf-8"
        )
        sibling = base / "app2"
        sibling.mkdir()
        (sibling / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")

        benign = _load_codec("m7v3").decode("data/greeting.txt", str(root))
        self.assertEqual(benign, "hello from the fixture\n")

        for state, expected in (
            ("m7v3", True),
            ("m7p3", False),
            ("sv", True),
            ("fd", False),
        ):
            module = _load_codec(state)
            try:
                result = module.decode("../app2/secret.txt", str(root))
            except (ValueError, OSError):
                leaked = False
            else:
                leaked = "TOP SECRET" in result
            with self.subTest(state=state):
                self.assertEqual(leaked, expected)


if __name__ == "__main__":
    unittest.main()
