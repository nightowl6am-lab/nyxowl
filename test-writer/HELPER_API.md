# Proof-test helper API

This document is the normative contract for a Test-Writer proof test. The
grader passes it to the subagent as `helperApi`; the subagent must not infer a
different contract from the target repository. A file that breaks any rule here
is rejected by the static lint gate before either sandbox snapshot runs.

## 1. Shape of the file

- Exactly one pytest test function per file, named `test_*`.
- No collection-time side effects. Module level may contain only imports, a
  docstring, function/class definitions, and constant assignments. Calling a
  function at module level (including `print`, setup helpers, or profile
  registration) is a `MODULE_SIDE_EFFECT`.
- No fixtures, plugins, hooks, `pytest_*` functions, or `pytest_plugins`.
- Do not request `request`, `pytestconfig`, `monkeypatch`, or `mocker`; these
  fixtures expose pytest's plugin manager or patching machinery and are
  `MOCKING`. `pytest.MonkeyPatch` is also `MOCKING`.
- Do not read `/work/src`, `/work/harness`, or the installed grader code from
  the test. The runtime audit hook records `sensitive_read` and fails closed;
  import machinery and target code may read those roots, the test may not.
- The test file must be at most **51200 bytes** as UTF-8. More than one test
  function is also a `SIZE` violation.

## 2. Imports

The only allowed imports are:

- `pytest`
- `hypothesis`
- `hypothesis.strategies`
- the target module(s) named by the job `interface`, and their submodules

No other import is allowed, including the standard library, `unittest`,
`unittest.mock`, `mock`, `pytest_mock`, and `importlib`. Relative imports are
also disallowed. The lint gate applies the same allowlist plus
`allowed_modules` supplied by the job.

## 3. The `detector` fixture

The grader supplies `detector`; the test must request it as a test argument
named `detector`. The test must not import, define, shadow, or mock it.

```python
detector.check(condition, *, detail="")
```

Semantics:

- It records a **seen hit** for the current test. The grader uses that hit to
  attribute the test to the target entry point.
- It requires the target entry function named by the job to have been invoked in
  the same test. The fixture is not a general-purpose assertion helper.
- The job metadata may set `unsafe_return_contains` to a short marker. When it
  is present, a truthy `condition` is a hit only if the same test called the
  target and the target's last return value (text or bytes) contained the
  marker. A truthy check without that evidence still fails the test but is not
  a detector hit.
- If `condition` is truthy, it raises `AssertionError`. The truthy value must
  mean "the target exhibited the unsafe behavior".
- If `condition` is falsy, it returns normally.
- It exposes no canary path or canary value. Never open, read, copy, guess, or
  hardcode a canary path; use `detector.check`.
- It must not be replaced by a mock, fixture, monkeypatch, or local function.

## 4. Canonical vulnerable-vs-patched pattern

Call the target, compute the unsafe condition, and pass that condition to
`detector.check`:

1. On the **vulnerable** snapshot the target exhibits the unsafe behavior, so
   the condition is true and `detector.check` raises. The test fails only for
   this reason.
2. On the **patched** snapshot the unsafe behavior is absent, so the condition
   is false and the test passes.
3. An ordinary assertion may follow the check to state the safe result, but it
   must not be the only oracle.

A test that passes on the vulnerable snapshot, fails on the patched snapshot,
or exercises the target without recording a hit does not prove the fix.

## 5. Hypothesis example (lint-clean)

```python
from hypothesis import given, strategies as st

from target import reject_negative


@given(st.integers(max_value=-1))
def test_rejects_negative(detector, value):
    result = reject_negative(value)
    detector.check(result is not None, detail="negative input was accepted")
    assert result is None
```

`target` stands for the job's target module. Keep generated inputs inside the
rejection domain so the patched snapshot passes for the intended reason.

## 6. Plain deterministic example (lint-clean)

```python
from target import reject_negative


def test_rejects_negative(detector):
    result = reject_negative(-7)
    detector.check(result is not None, detail="negative input was accepted")
    assert result is None
```

## 7. Banned constructs

- `skip`, `skipif`, `xfail`, `pytest.skip`, `pytest.xfail`, `importorskip`, or
  equivalent unittest decorators (`SKIP_OR_XFAIL`).
- pytest hooks, plugins, fixtures, `pytest_*` functions, or a shadow
  `detector` fixture (`PYTEST_HOOK`).
- Hypothesis profile overrides: `settings(...)`,
  `settings.register_profile`, `settings.load_profile`, or equivalent
  (`HYPOTHESIS_OVERRIDE`).
- Bare `except`, `except Exception`, `except BaseException`,
  `except AssertionError`, or `contextlib.suppress` of those
  (`SWALLOWED_EXCEPTION`).
- `eval`, `exec`, `compile`, `__import__`, `getattr`, `setattr`, `delattr`,
  `globals`, `locals`, `vars`, `importlib`, or any dunder attribute access
  (`__dict__`, `__doc__`, `__file__`, `__globals__`, `__code__`,
  `__subclasses__`, ...) (`DYNAMIC_ESCAPE`).
- `pluginmanager`, `get_plugin`, `getplugin`, `_getplugin`, `plugins`,
  `pytestconfig`, or `config` reached through `pytest`, `request`, or
  `pytestconfig` (`DYNAMIC_ESCAPE`).
- `unittest.mock`, `mock`, `pytest_mock`, `request`, `pytestconfig`, `mocker`,
  `monkeypatch`, `pytest.MonkeyPatch`, `patch`, or mock objects (`MOCKING`).
- A hardcoded canary path or canary value (`CANARY_LITERAL`).
- A test with no `assert`, no `pytest.raises`, and no `detector.check`
  (`NO_ORACLE`), or an assertion that cannot fail such as `assert True` or
  `assert 1 == 1` (`TAUTOLOGY`).
- A file that does not parse (`SYNTAX`).
