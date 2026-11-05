"""Self-tests that lock the grader's reason vocabulary to the plan."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader.reasons import (  # noqa: E402
    LINT_RULES,
    REASON_HINTS,
    SANDBOX_VIOLATION_KINDS,
    SETUP_ERROR_KINDS,
    hint_for,
    setup_error_kind,
)

NEUTRAL_HINT = "No further detail is available."

EXPECTED_LINT_RULES = (
    "NO_ORACLE",
    "TAUTOLOGY",
    "MOCKING",
    "SWALLOWED_EXCEPTION",
    "DISALLOWED_IMPORT",
    "DYNAMIC_ESCAPE",
    "SKIP_OR_XFAIL",
    "PYTEST_HOOK",
    "HYPOTHESIS_OVERRIDE",
    "MODULE_SIDE_EFFECT",
    "CANARY_LITERAL",
    "SIZE",
    "SYNTAX",
)

EXPECTED_SETUP_ERROR_KINDS = (
    "collection",
    "import",
    "wrong_exception",
    "timeout",
    "memory",
    "crash",
    "no_report",
    "no_tests",
    "skipped",
)

EXPECTED_SANDBOX_VIOLATION_KINDS = (
    "socket",
    "subprocess",
    "exec",
    "fork",
    "ctypes",
    "write_outside_tmp",
)

FORBIDDEN_HINT_FRAGMENTS = (
    "canary",
    "/canary",
    "variant",
    "mutant",
    "stdout",
    "stderr",
)


class LintRuleTests(unittest.TestCase):
    def test_exact_plan_tuple(self):
        self.assertEqual(LINT_RULES, EXPECTED_LINT_RULES)

    def test_every_rule_has_a_hint(self):
        for rule in LINT_RULES:
            with self.subTest(rule=rule):
                self.assertIn(f"LINT:{rule}", REASON_HINTS)


class SetupErrorKindTests(unittest.TestCase):
    def test_exact_plan_tuple(self):
        self.assertEqual(SETUP_ERROR_KINDS, EXPECTED_SETUP_ERROR_KINDS)

    def test_wrong_exception_expands_with_identifier(self):
        self.assertEqual(
            setup_error_kind("wrong_exception", "NameError"),
            "wrong_exception:NameError",
        )

    def test_non_parameterised_kind_names_itself(self):
        self.assertEqual(setup_error_kind("timeout"), "timeout")

    def test_wrong_exception_requires_identifier(self):
        for bad in (None, "", " ", "NameError:x", "1Bad", "Bad-Name", 7):
            with self.subTest(exception_type=bad):
                with self.assertRaises(ValueError):
                    setup_error_kind("wrong_exception", bad)  # type: ignore[arg-type]

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(ValueError):
            setup_error_kind("bogus")

    def test_every_non_parameterised_kind_has_hints(self):
        for kind in EXPECTED_SETUP_ERROR_KINDS:
            if kind == "wrong_exception":
                continue
            with self.subTest(kind=kind):
                self.assertIn(f"SETUP_ERROR_VULN:{kind}", REASON_HINTS)
                self.assertIn(f"SETUP_ERROR_PATCHED:{kind}", REASON_HINTS)


class SandboxViolationTests(unittest.TestCase):
    def test_exact_plan_tuple(self):
        self.assertEqual(SANDBOX_VIOLATION_KINDS, EXPECTED_SANDBOX_VIOLATION_KINDS)

    def test_every_kind_has_a_hint(self):
        for kind in SANDBOX_VIOLATION_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(f"SANDBOX_VIOLATION:{kind}", REASON_HINTS)


class HintTests(unittest.TestCase):
    def test_unknown_code_returns_neutral_fallback(self):
        self.assertEqual(hint_for("unknown"), NEUTRAL_HINT)

    def test_parameterised_wrong_exception_resolves(self):
        code = f"SETUP_ERROR_VULN:{setup_error_kind('wrong_exception', 'NameError')}"
        self.assertNotEqual(hint_for(code), NEUTRAL_HINT)

    def test_hints_are_ascii_and_non_leaking(self):
        for code, hint in REASON_HINTS.items():
            with self.subTest(code=code):
                self.assertTrue(hint.isascii(), hint)
                lowered = hint.lower()
                for fragment in FORBIDDEN_HINT_FRAGMENTS:
                    self.assertNotIn(fragment, lowered)


if __name__ == "__main__":
    unittest.main()
