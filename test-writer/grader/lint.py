"""Deterministic, fail-closed static lint for Test-Writer proof tests (M2).

The lint is gate 1 of the grader.  It never imports or executes the submitted
source: it parses with :mod:`ast`, confirms that the module compiles, and then
walks the syntax tree.  Every emitted rule id comes from
:data:`grader.reasons.LINT_RULES`, so the result can only contain vocabulary the
grader already knows.  Malformed and hostile input is reported as ``SYNTAX``
instead of raising.
"""

from __future__ import annotations

import ast
import re
from typing import Iterable

try:  # Package import used by the grader and the self-tests.
    from .reasons import LINT_RULES, hint_for
except ImportError:  # Direct execution: ``python3 test-writer/grader/lint.py``
    from reasons import LINT_RULES, hint_for

MAX_SOURCE_BYTES = 51200

# The proof test may import pytest, Hypothesis, and the target module(s) named
# by the job interface.  Everything else is rejected, including the standard
# library, because a proof test needs no general-purpose runtime machinery.
BASE_ALLOWED_MODULES = frozenset({"pytest", "hypothesis"})

_MOCK_MODULES = ("mock", "pytest_mock", "unittest.mock")
_MOCK_CALL_NAMES = frozenset(
    {
        "patch",
        "Mock",
        "MagicMock",
        "AsyncMock",
        "NonCallableMock",
        "PropertyMock",
        "create_autospec",
    }
)
# ``request`` and ``pytestconfig`` are pytest's own escape hatches into the
# plugin manager and the session configuration.  They are as dangerous as a
# monkeypatch for a proof test, so they share the mock-fixture rule.
_MOCK_FIXTURE_NAMES = frozenset(
    {"mocker", "monkeypatch", "request", "pytestconfig"}
)

_BROAD_EXCEPTION_NAMES = frozenset(
    {"Exception", "BaseException", "AssertionError", "builtins.Exception", "builtins.BaseException"}
)

_DYNAMIC_CALL_NAMES = frozenset(
    {
        "eval",
        "exec",
        "compile",
        "__import__",
        "getattr",
        "setattr",
        "delattr",
        "globals",
        "locals",
        "vars",
    }
)
_DYNAMIC_ATTRIBUTES = frozenset(
    {
        "__dict__",
        "__globals__",
        "__builtins__",
        "__code__",
        "__subclasses__",
        "__getattribute__",
        "__class__",
        "__mro__",
        "__bases__",
    }
)
# Reference to one of these names lets a lint-clean test raise a BaseException
# that unwinds pytest, potentially skipping the harness report or changing the
# process exit status after a forged report was written.
_ESCAPE_EXCEPTION_NAMES = frozenset(
    {"SystemExit", "KeyboardInterrupt", "GeneratorExit"}
)

# Attribute names that reach pytest's plugin manager or session configuration.
_FORBIDDEN_ATTRIBUTES = frozenset(
    {
        "pluginmanager",
        "get_plugin",
        "getplugin",
        "_getplugin",
        "plugins",
        "pytestconfig",
        "config",
    }
)
# Only these roots are interesting: ``os.config`` or a user object's
# ``config`` attribute is not a pytest escape.
_ESCAPE_ATTRIBUTE_ROOTS = frozenset({"pytest", "request", "pytestconfig"})

_SKIP_DOTTED_NAMES = frozenset(
    {
        "pytest.mark.skip",
        "pytest.mark.skipif",
        "pytest.mark.xfail",
        "pytest.skip",
        "pytest.xfail",
        "pytest.importorskip",
        "unittest.skip",
        "unittest.skipIf",
        "unittest.skipUnless",
        "unittest.expectedFailure",
    }
)
_SKIP_BARE_NAMES = frozenset({"skip", "skipIf", "skipUnless", "xfail"})
_SKIP_ATTRIBUTE_NAMES = frozenset({"skipTest", "skip", "xfail"})

_HYPOTHESIS_PROFILE_PARTS = frozenset(
    {"register_profile", "load_profile", "get_profile"}
)

_CANARY_SEGMENT_RE = re.compile(r"(?i)(?:^|[/\\])canary(?:[/\\]|$)")


def lint_source(
    source: str,
    *,
    allowed_modules: list[str] | tuple[str, ...] = (),
) -> list[dict[str, str]]:
    """Return the ordered list of lint violations for ``source``.

    ``allowed_modules`` names the target module(s) from the job interface.  The
    result is stable: each rule appears at most once and follows the order of
    :data:`grader.reasons.LINT_RULES`.  An unparseable or non-string source is
    reported as ``SYNTAX``; this function does not raise for hostile input.
    """
    if not isinstance(source, str):
        return _format_violations({"SYNTAX"})

    try:
        source_bytes = source.encode("utf-8", "surrogatepass")
    except Exception:
        # Encoding is only needed for the size budget.  A pathological string
        # still gets the text-length fallback, then the parser decides.
        source_bytes = b""
        try:
            too_big = len(source) > MAX_SOURCE_BYTES
        except Exception:
            too_big = True
    else:
        too_big = len(source_bytes) > MAX_SOURCE_BYTES

    try:
        tree = ast.parse(source, filename="<proof-test>", mode="exec")
        # ``ast.parse`` accepts a few node shapes that ``compile`` rejects.
        # Compiling is still a pure parse step and never executes the module.
        compile(source, "<proof-test>", "exec")
    except Exception:
        return _format_violations({"SYNTAX"})

    try:
        violations = _analyse(tree, allowed_modules, too_big)
    except Exception:
        # Fail closed if the analyser itself meets a construct it cannot
        # handle.  No unknown or free-form reason is ever returned.
        violations = {"SYNTAX"}

    return _format_violations(violations)


def _format_violations(rule_ids: Iterable[str]) -> list[dict[str, str]]:
    wanted = set(rule_ids)
    # Filtering through LINT_RULES guarantees the vocabulary and the order.
    return [
        {"rule": rule, "hint": hint_for(f"LINT:{rule}")}
        for rule in LINT_RULES
        if rule in wanted
    ]


def _analyse(
    tree: ast.Module,
    allowed_modules: list[str] | tuple[str, ...],
    too_big: bool,
) -> set[str]:
    violations: set[str] = set()

    test_functions = _test_functions(tree)
    aliases = _import_aliases(tree)
    if len(test_functions) > 1 or too_big:
        violations.add("SIZE")

    if not test_functions or not any(
        _has_oracle(node, aliases) for node in test_functions
    ):
        violations.add("NO_ORACLE")

    if _has_tautology(tree):
        violations.add("TAUTOLOGY")
    if _has_mocking(tree):
        violations.add("MOCKING")
    if _has_swallowed_exception(tree):
        violations.add("SWALLOWED_EXCEPTION")
    if _has_disallowed_import(tree, allowed_modules):
        violations.add("DISALLOWED_IMPORT")
    if _has_dynamic_escape(tree, aliases):
        violations.add("DYNAMIC_ESCAPE")
    if _has_skip_or_xfail(tree, aliases):
        violations.add("SKIP_OR_XFAIL")
    if _has_pytest_hook(tree, aliases):
        violations.add("PYTEST_HOOK")
    if _has_hypothesis_override(tree):
        violations.add("HYPOTHESIS_OVERRIDE")
    if _has_module_side_effect(tree):
        violations.add("MODULE_SIDE_EFFECT")
    if _has_canary_literal(tree):
        violations.add("CANARY_LITERAL")

    return violations


def _test_functions(tree: ast.Module) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name.startswith("test_")
    ]


def _has_oracle(node: ast.AST, aliases: dict[str, str]) -> bool:
    # Ignore nested functions/classes: an assertion in an uncalled helper is not
    # an oracle for this test.  The test function node itself is not yielded.
    for child in _scope_children(node):
        if isinstance(child, ast.Assert):
            return True
        if isinstance(child, ast.Call):
            name = _resolve_dotted(_dotted_name(child.func), aliases)
            if name in {"pytest.raises", "detector.check"}:
                return True
    return False


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    """Map local import names to their fully qualified names."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    aliases[alias.asname] = alias.name
                else:
                    root = alias.name.split(".", 1)[0]
                    aliases[root] = root
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                if alias.name == "*":
                    continue
                local = alias.asname or alias.name
                aliases[local] = f"{module}.{alias.name}" if module else alias.name
    return aliases


def _resolve_dotted(name: str, aliases: dict[str, str]) -> str:
    if not name:
        return name
    root, separator, remainder = name.partition(".")
    resolved = aliases.get(root)
    if resolved is None:
        return name
    return f"{resolved}.{remainder}" if separator else resolved


def _scope_children(node: ast.AST):
    """Yield descendants of ``node`` without entering nested scopes."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        if isinstance(
            child,
            (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda),
        ):
            continue
        yield child
        stack.extend(ast.iter_child_nodes(child))


def _dotted_name(node: ast.AST) -> str:
    """Return ``a.b.c`` for a Name/Attribute chain, or ``""`` otherwise."""
    parts: list[str] = []
    current: ast.AST | None = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    return ""


def _contains_call(node: ast.AST) -> bool:
    return any(isinstance(child, ast.Call) for child in ast.walk(node))


def _is_constant_expression(node: ast.AST) -> bool:
    """Return True only for literal data that cannot run code at import time."""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return all(_is_constant_expression(element) for element in node.elts)
    if isinstance(node, ast.Dict):
        keys_ok = all(
            key is None or _is_constant_expression(key) for key in node.keys
        )
        return keys_ok and all(_is_constant_expression(value) for value in node.values)
    if isinstance(node, ast.UnaryOp) and isinstance(
        node.op, (ast.Not, ast.UAdd, ast.USub, ast.Invert)
    ):
        return _is_constant_expression(node.operand)
    return False


def _has_module_side_effect(tree: ast.Module) -> bool:
    for statement in tree.body:
        if isinstance(
            statement,
            (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
        ):
            continue
        if (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Constant)
            and isinstance(statement.value.value, str)
        ):
            # Module docstring.
            continue
        if isinstance(statement, ast.Assign):
            if not _is_constant_expression(statement.value):
                return True
            continue
        if isinstance(statement, ast.AnnAssign):
            if statement.value is not None and not _is_constant_expression(statement.value):
                return True
            continue
        # Any other module-level statement executes during collection, even if
        # it contains no call (for example ``raise`` or ``assert``).
        return True
    return False


_UNKNOWN = object()


def _constant_value(node: ast.AST):
    """Return a bounded, literal-only value, or ``_UNKNOWN``.

    This is deliberately small: it folds literals and simple arithmetic and
    comparisons so an assertion such as ``1 + 1 == 2`` is recognised as a
    tautology, without evaluating arbitrary calls or unbounded expressions.
    """
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp):
        value = _constant_value(node.operand)
        if value is _UNKNOWN:
            return _UNKNOWN
        try:
            if isinstance(node.op, ast.Not):
                return not value
            if isinstance(node.op, ast.UAdd):
                return +value
            if isinstance(node.op, ast.USub):
                return -value
            if isinstance(node.op, ast.Invert):
                return ~value
        except Exception:
            return _UNKNOWN
        return _UNKNOWN
    if isinstance(node, ast.BoolOp):
        values = [_constant_value(value) for value in node.values]
        if any(value is _UNKNOWN for value in values):
            return _UNKNOWN
        try:
            if isinstance(node.op, ast.And):
                return all(values)
            return any(values)
        except Exception:
            return _UNKNOWN
    if isinstance(node, ast.BinOp):
        left = _constant_value(node.left)
        right = _constant_value(node.right)
        if left is _UNKNOWN or right is _UNKNOWN:
            return _UNKNOWN
        return _safe_binop(node.op, left, right)
    if isinstance(node, ast.Compare):
        left = _constant_value(node.left)
        if left is _UNKNOWN:
            return _UNKNOWN
        values = [left]
        for comparator in node.comparators:
            value = _constant_value(comparator)
            if value is _UNKNOWN:
                return _UNKNOWN
            values.append(value)
        try:
            for operator, first, second in zip(node.ops, values, values[1:]):
                if not _safe_compare(operator, first, second):
                    return False
            return True
        except Exception:
            return _UNKNOWN
    return _UNKNOWN


def _safe_binop(operator: ast.operator, left, right):
    try:
        if isinstance(operator, ast.Add):
            if isinstance(left, (int, float, complex)) and isinstance(
                right, (int, float, complex)
            ):
                return left + right
            if isinstance(left, str) and isinstance(right, str):
                if len(left) + len(right) <= 4096:
                    return left + right
            if isinstance(left, bytes) and isinstance(right, bytes):
                if len(left) + len(right) <= 4096:
                    return left + right
        if isinstance(operator, ast.Sub) and isinstance(left, (int, float, complex)):
            if isinstance(right, (int, float, complex)):
                return left - right
        if isinstance(operator, ast.Mult):
            if isinstance(left, (int, float)) and isinstance(right, (int, float)):
                if abs(left) <= 1_000_000 and abs(right) <= 1_000_000:
                    return left * right
            if isinstance(left, int) and isinstance(right, (str, bytes)):
                return _safe_repeat(right, left)
            if isinstance(right, int) and isinstance(left, (str, bytes)):
                return _safe_repeat(left, right)
    except Exception:
        return _UNKNOWN
    return _UNKNOWN


def _safe_repeat(value: str | bytes, count: int):
    if count < 0 or count > 4096 or len(value) > 4096:
        return _UNKNOWN
    if count * len(value) > 4096:
        return _UNKNOWN
    return value * count


def _safe_compare(operator: ast.cmpop, left, right) -> bool:
    if isinstance(operator, ast.Eq):
        return left == right
    if isinstance(operator, ast.NotEq):
        return left != right
    if isinstance(operator, ast.Lt):
        return left < right
    if isinstance(operator, ast.LtE):
        return left <= right
    if isinstance(operator, ast.Gt):
        return left > right
    if isinstance(operator, ast.GtE):
        return left >= right
    if isinstance(operator, ast.Is):
        return left is right
    if isinstance(operator, ast.IsNot):
        return left is not right
    if isinstance(operator, ast.In):
        return left in right
    if isinstance(operator, ast.NotIn):
        return left not in right
    raise TypeError("unsupported comparison")


def _literal_bool(node: ast.AST) -> bool | None:
    """Return a literal's truth value, or ``None`` when it is not literal."""
    value = _constant_value(node)
    if value is _UNKNOWN:
        return None
    try:
        return bool(value)
    except Exception:
        return None


def _has_tautology(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assert):
            if _literal_bool(node.test) is True:
                return True
            if _is_identical_comparison(node.test):
                return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attribute = node.func.attr
            if attribute in {"assertTrue", "assertIs"} and node.args:
                if _literal_bool(node.args[0]) is True:
                    return True
            if attribute == "assertFalse" and node.args:
                if _literal_bool(node.args[0]) is False:
                    return True
            if attribute in {"assertEqual", "assertEquals"} and len(node.args) >= 2:
                if _same_expression(node.args[0], node.args[1]):
                    return True
                left = _constant_value(node.args[0])
                right = _constant_value(node.args[1])
                if left is not _UNKNOWN and right is not _UNKNOWN and left == right:
                    return True
    return False


def _is_identical_comparison(node: ast.AST) -> bool:
    if not isinstance(node, ast.Compare) or len(node.ops) != 1:
        return False
    if not isinstance(node.ops[0], (ast.Eq, ast.Is)):
        return False
    return _same_expression(node.left, node.comparators[0])


def _same_expression(left: ast.AST, right: ast.AST) -> bool:
    if _contains_call(left) or _contains_call(right):
        return False
    return ast.dump(left, include_attributes=False) == ast.dump(
        right, include_attributes=False
    )


def _argument_names(arguments: ast.arguments):
    """Yield every parameter name of one function/lambda signature."""
    for argument in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs):
        yield argument.arg
    if arguments.vararg is not None:
        yield arguments.vararg.arg
    if arguments.kwarg is not None:
        yield arguments.kwarg.arg


def _has_mocking(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(_is_mock_module(alias.name) for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if _is_mock_module(module):
                return True
            if module == "unittest" and any(alias.name == "mock" for alias in node.names):
                return True
            # ``from pytest import MonkeyPatch`` is pytest's public patching
            # API and is not available to a proof test.
            if module == "pytest" and any(
                alias.name == "MonkeyPatch" for alias in node.names
            ):
                return True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            if any(name in _MOCK_FIXTURE_NAMES for name in _argument_names(node.args)):
                return True
        elif isinstance(node, ast.Name):
            if node.id in _MOCK_FIXTURE_NAMES or node.id == "MonkeyPatch":
                return True
        elif isinstance(node, ast.Attribute):
            # ``pytest.MonkeyPatch`` and any other ``.MonkeyPatch`` access.
            if node.attr == "MonkeyPatch":
                return True
        elif isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Name) and function.id in _MOCK_CALL_NAMES:
                return True
            if isinstance(function, ast.Name) and function.id == "MonkeyPatch":
                return True
            name = _dotted_name(function)
            if name == "patch" or name.startswith("patch."):
                return True
            if name.startswith("mock.") or name.startswith("unittest.mock."):
                return True
            if name.startswith("pytest_mock."):
                return True
    return False


def _is_mock_module(name: str) -> bool:
    return any(name == module or name.startswith(module + ".") for module in _MOCK_MODULES)


def _exception_types(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Tuple):
        names: list[str] = []
        for element in node.elts:
            names.extend(_exception_types(element))
        return names
    name = _dotted_name(node)
    return [name] if name else []


def _has_swallowed_exception(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            if node.type is None:
                return True
            if any(name in _BROAD_EXCEPTION_NAMES for name in _exception_types(node.type)):
                return True
        if isinstance(node, ast.Call):
            name = _dotted_name(node.func)
            if name in {"suppress", "contextlib.suppress"} and node.args:
                if any(
                    exception_name in _BROAD_EXCEPTION_NAMES
                    for exception_name in _exception_types(node.args[0])
                ):
                    return True
    return False


def _normalise_allowed_modules(
    allowed_modules: list[str] | tuple[str, ...],
) -> frozenset[str]:
    allowed = set(BASE_ALLOWED_MODULES)
    if isinstance(allowed_modules, str):
        allowed_modules = (allowed_modules,)
    for module in allowed_modules:
        if isinstance(module, str) and module.strip():
            allowed.add(module.strip())
    return frozenset(allowed)


def _module_is_allowed(name: str, allowed: frozenset[str]) -> bool:
    return any(name == module or name.startswith(module + ".") for module in allowed)


def _has_disallowed_import(
    tree: ast.Module,
    allowed_modules: list[str] | tuple[str, ...],
) -> bool:
    allowed = _normalise_allowed_modules(allowed_modules)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(not _module_is_allowed(alias.name, allowed) for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if node.level != 0:
                return True
            module = node.module or ""
            if not module:
                return True
            if _module_is_allowed(module, allowed):
                continue
            # ``from package import submodule`` can name the usable module in
            # the alias even when the package itself is not on the allowlist.
            if not any(
                alias.name != "*"
                and _module_is_allowed(f"{module}.{alias.name}", allowed)
                for alias in node.names
            ):
                return True
    return False


def _is_dunder(name: str) -> bool:
    return len(name) >= 4 and name.startswith("__") and name.endswith("__")


def _has_dynamic_escape(tree: ast.Module, aliases: dict[str, str]) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Name) and function.id in _DYNAMIC_CALL_NAMES:
                return True
            name = _dotted_name(function)
            if name.startswith("importlib."):
                return True
        if isinstance(node, ast.Name):
            if node.id == "__builtins__":
                return True
            if node.id in _ESCAPE_EXCEPTION_NAMES:
                return True
        if isinstance(node, ast.Attribute):
            # Every dunder attribute is an escape surface: even apparently
            # harmless ones expose a module's loader, globals, or frame.
            if _is_dunder(node.attr):
                return True
            if node.attr in _DYNAMIC_ATTRIBUTES:
                return True
            if node.attr in _ESCAPE_EXCEPTION_NAMES:
                return True
            name = _dotted_name(node)
            if name:
                resolved = _resolve_dotted(name, aliases)
                parts = resolved.split(".")
                if (
                    parts[0] in _ESCAPE_ATTRIBUTE_ROOTS
                    and parts[-1] in _FORBIDDEN_ATTRIBUTES
                ):
                    return True
            if isinstance(node.value, ast.Name) and node.value.id == "importlib":
                return True
    return False


def _has_skip_or_xfail(tree: ast.Module, aliases: dict[str, str]) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Name) and function.id in _SKIP_BARE_NAMES:
                return True
            name = _resolve_dotted(_dotted_name(function), aliases)
            if name in _SKIP_DOTTED_NAMES:
                return True
            if isinstance(function, ast.Attribute) and function.attr in _SKIP_ATTRIBUTE_NAMES:
                return True
        elif isinstance(node, ast.Attribute):
            if _resolve_dotted(_dotted_name(node), aliases) in _SKIP_DOTTED_NAMES:
                return True
    return False


def _has_pytest_hook(tree: ast.Module, aliases: dict[str, str]) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            if any(
                isinstance(target, ast.Name)
                and target.id in {"pytest_plugins", "detector"}
                for target in node.targets
            ):
                return True
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id in {
                "pytest_plugins",
                "detector",
            }:
                return True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name.startswith("pytest_") or node.name == "detector":
                return True
            for decorator in node.decorator_list:
                target = decorator.func if isinstance(decorator, ast.Call) else decorator
                name = _resolve_dotted(_dotted_name(target), aliases)
                if name == "fixture" or name == "pytest.fixture" or name.startswith("pytest.fixture."):
                    return True
        elif isinstance(node, ast.ClassDef):
            if node.name == "detector":
                return True
        elif isinstance(node, ast.Call):
            # ``pytest.exit`` can terminate the session with an arbitrary exit
            # status (including 0) after a forged report is written.
            name = _resolve_dotted(_dotted_name(node.func), aliases)
            parts = name.split(".")
            if parts[0] == "pytest" and parts[-1] == "exit":
                return True
    return False


def _has_hypothesis_override(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module == "hypothesis" and any(
                alias.name == "settings" for alias in node.names
            ):
                return True
        if isinstance(node, ast.Import):
            if any(
                alias.name == "hypothesis.settings"
                or alias.name.startswith("hypothesis.settings.")
                for alias in node.names
            ):
                return True
        if isinstance(node, ast.Call):
            name = _dotted_name(node.func)
            if name == "settings" or name.startswith("settings."):
                return True
            if name.rsplit(".", 1)[-1] in _HYPOTHESIS_PROFILE_PARTS:
                return True
        elif isinstance(node, ast.Attribute):
            if node.attr in _HYPOTHESIS_PROFILE_PARTS:
                return True
    return False


def _canary_text(text: str) -> bool:
    return _CANARY_SEGMENT_RE.search(text) is not None


def _fold_string_literal(node: ast.AST) -> str | None:
    """Return a literal string, folding only safe ``+``/f-string concatenation."""
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return node.value
        if isinstance(node.value, bytes):
            return node.value.decode("utf-8", "ignore")
        return None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _fold_string_literal(node.left)
        right = _fold_string_literal(node.right)
        if left is not None and right is not None:
            return left + right
        return None
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                return None
        return "".join(parts)
    return None


def _has_canary_literal(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        text = _fold_string_literal(node)
        if text is not None and _canary_text(text):
            return True
    return False


if __name__ == "__main__":  # pragma: no cover - tiny manual entry point
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("usage: lint.py <test-file>")
    from pathlib import Path

    result = lint_source(Path(sys.argv[1]).read_text(encoding="utf-8"))
    for item in result:
        print(f"{item['rule']}: {item['hint']}")
