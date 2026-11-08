"""Rootless self-tests for the full-M7 evaluation cases and red-team proofs.

These tests validate the eight new case documents (p6-p10, n3-n5), the eight
hostile red-team documents, the lint cleanliness of every new case proof, and
the presence of the twelve appended fixture states.  They never run the
six-gate pipeline and never use bubblewrap; the real matrix is the separate
``qa/m7_full_eval.py`` runner.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader import job_check, lint  # noqa: E402

CASES_DIR = ROOT / "qa" / "m7_cases_full"
REDTEAM_DIR = ROOT / "qa" / "m7_redteam"
STATES_DIR = ROOT / "fixtures" / "states"
BUILDER = ROOT / "fixtures" / "build_fixtures.py"
EVAL_RUNNER = ROOT / "qa" / "m7_full_eval.py"
CASE_IDS = ("p6", "p7", "p8", "p9", "p10", "n3", "n4", "n5")
REDTEAM_IDS = tuple(f"rt{index}" for index in range(1, 9))
NEW_STATES = (
    "m7v6",
    "m7p6",
    "m7v7",
    "m7p7",
    "m7v8",
    "m7p8",
    "m7v9",
    "m7p9",
    "m7v10",
    "m7p10",
    "m7x4",
    "m7p5i",
)
EXPECTED_RESULTS = {
    "p6": ("PROVEN", None, "m7v6", "m7p6"),
    "p7": ("PROVEN", None, "m7v7", "m7p7"),
    "p8": ("PROVEN", None, "m7v8", "m7p8"),
    "p9": ("PROVEN", None, "m7v9", "m7p9"),
    "p10": ("PROVEN", None, "m7v10", "m7p10"),
    "n3": ("UNPROVEN", "NO_DETECTOR_HIT_ON_VULN", "m7p1", "m7v1"),
    "n4": ("REFUTED", "PATCHED_STILL_LEAKS", "m7v4", "m7x4"),
    "n5": ("REFUTED", "PATCHED_STILL_LEAKS", "m7v5", "m7p5i"),
}
EXPECTED_VERDICTS = {"PROVEN", "UNPROVEN", "REFUTED"}
EXPECTED_REASONS = {
    None,
    "NO_DETECTOR_HIT_ON_VULN",
    "PATCHED_STILL_LEAKS",
}


def _load_builder():
    spec = importlib.util.spec_from_file_location("m7_full_builder", BUILDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_eval_runner():
    spec = importlib.util.spec_from_file_location("m7_full_eval", EVAL_RUNNER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves the defining module through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _assert_case_document(
    test: unittest.TestCase, data: dict, expected_verdict: str, expected_reason
) -> None:
    test.assertIsInstance(data["alias"], str)
    test.assertTrue(data["alias"].strip())
    test.assertEqual(
        set(data["variant_states"]),
        {"still_vulnerable", "fixed_differently"},
    )
    test.assertEqual(
        data["variant_states"],
        {"still_vulnerable": "sv", "fixed_differently": "fd"},
    )
    test.assertEqual(
        (data["expected_verdict"], data["expected_reason"]),
        (expected_verdict, expected_reason),
    )
    test.assertIn(data["expected_verdict"], EXPECTED_VERDICTS)
    test.assertIn(data["expected_reason"], EXPECTED_REASONS)
    test.assertNotEqual(data["from_state"], data["to_state"])

    spec = data["spec_markdown"]
    lines = [line.strip() for line in spec.splitlines()]
    for heading in job_check.REQUIRED_HEADINGS:
        test.assertEqual(lines.count(heading), 1, heading)
    benign = [line for line in lines if line.startswith("BENIGN:")]
    test.assertEqual(len(benign), 1, "BENIGN line")
    test.assertLessEqual(len(benign[0]), job_check.BENIGN_MAX_CHARS)

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
    test.assertEqual(job_check.validate_meta(meta), [])


class FullCaseDocumentTests(unittest.TestCase):
    def test_case_directories_and_ids(self):
        found = sorted(path.name for path in CASES_DIR.iterdir() if path.is_dir())
        self.assertEqual(found, sorted(CASE_IDS))
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
                verdict, reason, from_state, to_state = EXPECTED_RESULTS[case_id]
                self.assertEqual(data["from_state"], from_state)
                self.assertEqual(data["to_state"], to_state)
                _assert_case_document(self, data, verdict, reason)

    def test_proof_sources_lint_clean(self):
        for case_id in CASE_IDS:
            with self.subTest(case=case_id):
                source = (CASES_DIR / case_id / "test_proof.py").read_text(
                    encoding="utf-8"
                )
                self.assertEqual(
                    lint.lint_source(source, allowed_modules=["pkg.codec"]), []
                )

    def test_positive_proofs_include_hidden_variant_payload(self):
        for case_id in ("p6", "p7", "p8", "p9", "p10"):
            with self.subTest(case=case_id):
                source = (CASES_DIR / case_id / "test_proof.py").read_text(
                    encoding="utf-8"
                )
                self.assertIn('"../secret.txt"', source)


class RedTeamDocumentTests(unittest.TestCase):
    def test_redteam_directories_and_ids(self):
        found = sorted(path.name for path in REDTEAM_DIR.iterdir() if path.is_dir())
        self.assertEqual(found, sorted(REDTEAM_IDS))
        for case_id in REDTEAM_IDS:
            directory = REDTEAM_DIR / case_id
            self.assertTrue((directory / "case.json").is_file(), case_id)
            self.assertTrue((directory / "test_proof.py").is_file(), case_id)

    def test_redteam_documents_are_valid_and_nonproven(self):
        for case_id in REDTEAM_IDS:
            with self.subTest(case=case_id):
                data = json.loads(
                    (REDTEAM_DIR / case_id / "case.json").read_text(encoding="utf-8")
                )
                self.assertEqual(data["id"], case_id)
                self.assertEqual(data["expected_verdict"], "UNPROVEN")
                self.assertIsNone(data["expected_reason"])
                _assert_case_document(self, data, "UNPROVEN", None)


class BuilderStateTests(unittest.TestCase):
    def test_builder_declares_the_twelve_new_states(self):
        builder = _load_builder()
        for state in NEW_STATES:
            with self.subTest(state=state):
                self.assertIn(state, builder.STATE_PARENTS)
                self.assertIn(state, builder.STATE_MESSAGES)
                self.assertIn(state, builder.STATE_ORDER)
                self.assertIsNone(builder.STATE_PARENTS[state])
                directory = STATES_DIR / state
                self.assertTrue(directory.is_dir(), state)
                self.assertTrue((directory / "pkg" / "__init__.py").is_file())
                self.assertTrue((directory / "pkg" / "codec.py").is_file())
                self.assertTrue((directory / "data" / "greeting.txt").is_file())

    def test_m7x4_patch_is_unrelated_to_the_codec(self):
        self.assertEqual(
            (STATES_DIR / "m7x4" / "pkg" / "codec.py").read_bytes(),
            (STATES_DIR / "m7v4" / "pkg" / "codec.py").read_bytes(),
        )
        self.assertTrue((STATES_DIR / "m7x4" / "NOTES.txt").is_file())


class FullEvalMetricTests(unittest.TestCase):
    """The evaluator must count only expected-REFUTED negatives for refutations."""

    def setUp(self):
        self.runner = _load_eval_runner()
        self.directory = CASES_DIR / "n3"

    def _spec(self, kind, case_id, expected_verdict, expected_reason):
        return self.runner.CaseSpec(
            kind=kind,
            case_id=case_id,
            directory=self.directory,
            data={
                "id": case_id,
                "expected_verdict": expected_verdict,
                "expected_reason": expected_reason,
            },
        )

    def _round(self, results, run=1):
        cases = {}
        recheck_runs = 0
        for case_id, (verdict, reason) in results.items():
            proven = verdict == "PROVEN"
            recheck_runs += 1 if proven else 0
            cases[case_id] = {
                "verdict": verdict,
                "reason": reason,
                "recheckExit": 0 if proven else None,
                "recheckResult": "match" if proven else None,
            }
        return {
            "run": run,
            "wall_seconds": 1.0,
            "gate_runs": len(cases),
            "recheck_runs": recheck_runs,
            "cases": cases,
        }

    def test_refuted_denominator_excludes_unproven_controls(self):
        cases = [
            self._spec("positive", "p1", "PROVEN", None),
            self._spec("negative", "n1", "UNPROVEN", "NO_DETECTOR_HIT_ON_VULN"),
            self._spec("negative", "n2", "REFUTED", "PATCHED_STILL_LEAKS"),
        ]
        rounds = [
            self._round(
                {
                    "p1": ("PROVEN", None),
                    "n1": ("UNPROVEN", "NO_DETECTOR_HIT_ON_VULN"),
                    "n2": ("REFUTED", "PATCHED_STILL_LEAKS"),
                }
            )
        ]
        metrics, failures = self.runner._evaluate(rounds, cases)
        self.assertEqual(failures, [])
        self.assertEqual(
            metrics["refuted_correct"], {"refuted": 1, "runs": 1, "ratio": 1.0}
        )
        self.assertEqual(metrics["negative_mismatches"], 0)
        self.assertEqual(metrics["negatives_exact_matched"], 2)

    def test_negative_reason_mismatch_is_a_failure(self):
        cases = [
            self._spec("positive", "p1", "PROVEN", None),
            self._spec("negative", "n2", "REFUTED", "PATCHED_STILL_LEAKS"),
        ]
        rounds = [
            self._round(
                {
                    "p1": ("PROVEN", None),
                    "n2": ("UNPROVEN", "NO_DETECTOR_HIT_ON_VULN"),
                }
            )
        ]
        metrics, failures = self.runner._evaluate(rounds, cases)
        self.assertTrue(
            any("negative verdict mismatch" in failure for failure in failures)
        )
        self.assertEqual(
            metrics["refuted_correct"], {"refuted": 0, "runs": 1, "ratio": 0.0}
        )
        self.assertEqual(metrics["negative_mismatches"], 1)
        self.assertEqual(metrics["negatives_exact_matched"], 0)

    def test_none_verdict_maps_to_no_verdict(self):
        cases = [
            self._spec("positive", "p1", "PROVEN", None),
            self._spec("redteam", "rt3", "UNPROVEN", None),
        ]
        rounds = [
            self._round(
                {
                    "p1": ("PROVEN", None),
                    "rt3": (None, None),
                }
            )
        ]
        metrics, failures = self.runner._evaluate(rounds, cases)
        self.assertEqual(failures, [])
        self.assertEqual(metrics["worst_of_3"]["rt3"], "NO_VERDICT")


if __name__ == "__main__":
    unittest.main()
