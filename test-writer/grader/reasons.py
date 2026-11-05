"""Verdict vocabulary and fixed, non-leaking explanations.

The grader never forwards free-form model text to the owner.  Every reason code
below maps to a stable sentence that reveals no target source, no test internals,
and no values from the sandbox.  Parameterised codes are expanded once at import
time so callers can only look up known keys.
"""

from __future__ import annotations

VERDICTS = ("PROVEN", "UNPROVEN", "REFUTED")
FLAGS = (
    "INJECTION_SUSPECTED",
    "SPEC_INSUFFICIENT",
    "CHEAT_ATTEMPT",
    "VARIANT_MISLABELED",
)

LINT_RULES = (
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

SETUP_ERROR_KINDS = (
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

# Every setup error kind except ``wrong_exception`` names itself.  The
# parameterised kind carries an exception type and is built by
# :func:`setup_error_kind` instead of being listed as a literal.
_NON_PARAMETERISED_SETUP_ERROR_KINDS = tuple(
    kind for kind in SETUP_ERROR_KINDS if kind != "wrong_exception"
)

SANDBOX_VIOLATION_KINDS = (
    "socket",
    "subprocess",
    "exec",
    "fork",
    "ctypes",
    "write_outside_tmp",
)

REASON_CODES = (
    "LINT:<rule_id>",
    "CHEAT_CANARY_READ",
    "SANDBOX_VIOLATION:<kind>",
    "SETUP_ERROR_VULN:<kind>",
    "NO_FAIL_ON_VULN",
    "NO_DETECTOR_HIT_ON_VULN",
    "SETUP_ERROR_PATCHED:<kind>",
    "PATCHED_STILL_LEAKS",
    "FAIL_ON_PATCHED",
    "FLAKY",
    "VARIANT_TOO_WEAK",
    "VARIANT_OVERFIT",
    "VARIANT_MISLABELED",
    "MUTATION_SCORE_LOW",
    "BUDGET_EXHAUSTED",
    "GAVE_UP",
)

_LINT_HINTS = {
    "NO_ORACLE": "The test contains no assertion, no pytest.raises, and no detector.check.",
    "TAUTOLOGY": "The test asserts a value that cannot fail.",
    "MOCKING": "The test mocks the target or uses a forbidden fixture.",
    "SWALLOWED_EXCEPTION": "The test catches every error or suppresses AssertionError.",
    "DISALLOWED_IMPORT": "The test imports a module outside the allowlist.",
    "DYNAMIC_ESCAPE": "The test uses dynamic attribute access or an eval-like escape.",
    "SKIP_OR_XFAIL": "The test can skip or mark itself as an expected failure.",
    "PYTEST_HOOK": "The test defines a pytest hook, plugin, or shadow fixture.",
    "HYPOTHESIS_OVERRIDE": "The test overrides the grader's Hypothesis profile.",
    "MODULE_SIDE_EFFECT": "The test runs code at import time.",
    "CANARY_LITERAL": "The test hardcodes a protected path instead of using the detector fixture.",
    "SIZE": "The test file or test count exceeds the size limit.",
    "SYNTAX": "The test file does not parse.",
}

_SETUP_ERROR_HINTS = {
    "collection": "Test collection failed.",
    "import": "The test module could not be imported.",
    "wrong_exception": "The test raised an unexpected exception type.",
    "timeout": "The run exceeded its time budget.",
    "memory": "The run exceeded its memory budget.",
    "crash": "The test process terminated unexpectedly.",
    "no_report": "The harness did not receive an outcome report.",
    "no_tests": "No tests were collected.",
    "skipped": "The test was skipped.",
}

_SANDBOX_HINTS = {
    "socket": "The sandbox observed a network attempt.",
    "subprocess": "The sandbox observed a subprocess attempt.",
    "exec": "The sandbox observed an exec attempt.",
    "fork": "The sandbox observed a fork attempt.",
    "ctypes": "The sandbox observed a native-code load attempt.",
    "write_outside_tmp": "The sandbox observed a write outside the temporary directory.",
}

_STATIC_HINTS = {
    "CHEAT_CANARY_READ": "A test attempted to read a protected value.",
    "NO_FAIL_ON_VULN": "The test did not fail under the vulnerable setup.",
    "NO_DETECTOR_HIT_ON_VULN": "The test did not exercise the behaviour under test.",
    "PATCHED_STILL_LEAKS": "The test still failed after the fix was applied.",
    "FAIL_ON_PATCHED": "The test failed after the fix was applied.",
    "FLAKY": "The test produced inconsistent results across runs.",
    "VARIANT_TOO_WEAK": "The test passed too easily on an easier setup.",
    "VARIANT_OVERFIT": "The test only passed for one narrow setup.",
    "VARIANT_MISLABELED": "The test was associated with the wrong setup label.",
    "MUTATION_SCORE_LOW": "The test did not distinguish enough behaviour changes.",
    "BUDGET_EXHAUSTED": "The run stopped after reaching its time or resource budget.",
    "GAVE_UP": "The run stopped without producing a usable test.",
}

REASON_HINTS: dict[str, str] = dict(_STATIC_HINTS)
for _rule, _hint in _LINT_HINTS.items():
    REASON_HINTS[f"LINT:{_rule}"] = _hint
for _kind, _hint in _SETUP_ERROR_HINTS.items():
    REASON_HINTS[f"SETUP_ERROR_VULN:{_kind}"] = _hint
    REASON_HINTS[f"SETUP_ERROR_PATCHED:{_kind}"] = _hint
for _kind, _hint in _SANDBOX_HINTS.items():
    REASON_HINTS[f"SANDBOX_VIOLATION:{_kind}"] = _hint


def setup_error_kind(kind: str, exception_type: str | None = None) -> str:
    """Return the stable setup-error token for a known kind.

    ``wrong_exception`` is parameterised: it needs a non-empty Python
    identifier and expands to ``wrong_exception:<Type>``.  All other known
    kinds name themselves.  Unknown kinds are rejected so a caller cannot
    smuggle free-form text into a reason code.
    """
    if kind == "wrong_exception":
        if not isinstance(exception_type, str) or not exception_type.isidentifier():
            raise ValueError("wrong_exception requires an identifier exception type")
        return f"wrong_exception:{exception_type}"
    if kind in _NON_PARAMETERISED_SETUP_ERROR_KINDS:
        return kind
    raise ValueError(f"unknown setup error kind: {kind!r}")


def hint_for(code: str) -> str:
    """Return the fixed hint for a known reason code, or a neutral fallback."""
    hint = REASON_HINTS.get(code)
    if hint is not None:
        return hint
    for prefix in (
        "SETUP_ERROR_VULN:wrong_exception:",
        "SETUP_ERROR_PATCHED:wrong_exception:",
    ):
        if code.startswith(prefix):
            return REASON_HINTS[prefix.removesuffix(":")]
    return "No further detail is available."
