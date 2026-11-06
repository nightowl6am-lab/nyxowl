"""Deterministic, AST-only mutation generation for the M4 quality gate.

The module never imports, executes, or reads a target module at runtime.  It
parses source files with :mod:`ast`, compares top-level functions between the
vulnerable and patched snapshots, and emits small behaviour-changing mutants of
the patched source.  The caller is responsible for running the proof test in
the sandbox against each mutant.

Design notes
------------
* Only files below the job's ``python_path`` roots are considered.
* Mutations are generated for functions that exist in both snapshots and whose
  AST differs.
* A function's *guard* mutations (branch tests, comparisons, boolean operators,
  constants, and negated boolean returns) are preferred.  Terminal mutations
  (``return value -> None`` and ``raise -> return None``) are only emitted when
  the function has no guard mutation: on a function whose fix is an early
  guard, terminal mutants are usually dead code for the proof test and would
  dilute the mutation score without adding signal.
* Selection is deterministic: candidates are sorted by ``(path, function,
  operator, line, column)`` and a seeded :class:`random.Random` sample is capped
  at ``max_mutants``.
"""

from __future__ import annotations

import ast
import copy
import random
from pathlib import Path
from typing import Iterable, Iterator

Mutant = dict[str, str]

MAX_MUTANTS = 8

GUARD_OPERATORS = frozenset(
    {
        "negate_if",
        "swap_compare",
        "swap_boolop",
        "flip_constant",
        "add_not_return",
    }
)
TERMINAL_OPERATORS = frozenset({"return_none", "raise_return"})
OPERATORS = tuple(sorted(GUARD_OPERATORS | TERMINAL_OPERATORS))

_COMPARE_SWAP: dict[type[ast.cmpop], type[ast.cmpop]] = {
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
    ast.Lt: ast.Gt,
    ast.Gt: ast.Lt,
    ast.LtE: ast.GtE,
    ast.GtE: ast.LtE,
    ast.In: ast.NotIn,
    ast.NotIn: ast.In,
    ast.Is: ast.IsNot,
    ast.IsNot: ast.Is,
}


def _safe_relative(root: Path, relative: str) -> Path | None:
    """Resolve ``relative`` below ``root`` without following unsafe paths."""
    if not isinstance(relative, str):
        return None
    if relative in {"", "."}:
        return root
    candidate = root / relative
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    if resolved != root and root not in resolved.parents:
        return None
    return resolved


def _python_files(root: Path, python_path: Iterable[str]) -> list[str]:
    """Return sorted POSIX relative paths of ``.py`` files below the roots."""
    entries = list(python_path)
    roots: list[Path] = []
    for entry in entries or (".",):
        if not isinstance(entry, str):
            continue
        resolved = _safe_relative(root, entry)
        if resolved is not None and resolved.is_dir() and resolved not in roots:
            roots.append(resolved)
    if not roots:
        return []

    files: set[str] = set()
    for base in roots:
        for path in sorted(base.rglob("*.py")):
            if "__pycache__" in path.parts or not path.is_file():
                continue
            try:
                relative = path.resolve().relative_to(root).as_posix()
            except (OSError, ValueError):
                continue
            files.add(relative)
    return sorted(files)


def _top_level_functions(tree: ast.Module) -> dict[str, ast.AST]:
    functions: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.setdefault(node.name, node)
    return functions


def _parse(path: Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None


def changed_functions(
    vulnerable_dir: str | Path,
    patched_dir: str | Path,
    python_path: Iterable[str] = (),
) -> list[tuple[str, str]]:
    """Return ``(relative_path, function_name)`` for functions that differ.

    Only top-level functions that exist in both snapshots are compared.  The
    result is sorted by path and function name so callers can rely on a stable
    order.
    """
    vulnerable_root = Path(vulnerable_dir).resolve()
    patched_root = Path(patched_dir).resolve()
    vulnerable_files = set(_python_files(vulnerable_root, python_path))
    patched_files = set(_python_files(patched_root, python_path))

    changed: list[tuple[str, str]] = []
    for relative in sorted(vulnerable_files & patched_files):
        vulnerable_tree = _parse(vulnerable_root / relative)
        patched_tree = _parse(patched_root / relative)
        if vulnerable_tree is None or patched_tree is None:
            continue
        vulnerable_functions = _top_level_functions(vulnerable_tree)
        patched_functions = _top_level_functions(patched_tree)
        for name in sorted(set(vulnerable_functions) & set(patched_functions)):
            vulnerable_dump = ast.dump(
                vulnerable_functions[name], include_attributes=False
            )
            patched_dump = ast.dump(
                patched_functions[name], include_attributes=False
            )
            if vulnerable_dump != patched_dump:
                changed.append((relative, name))
    return sorted(changed)


def _walk_with_paths(
    node: ast.AST, path: tuple[tuple[str, int | None], ...] = ()
) -> Iterator[tuple[ast.AST, tuple[tuple[str, int | None], ...]]]:
    """Yield every node below ``node`` with its field/index path."""
    yield node, path
    for field, value in ast.iter_fields(node):
        if isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, ast.AST):
                    yield from _walk_with_paths(item, path + ((field, index),))
        elif isinstance(value, ast.AST):
            yield from _walk_with_paths(value, path + ((field, None),))


def _get_node(root: ast.AST, path: tuple[tuple[str, int | None], ...]) -> ast.AST:
    node = root
    for field, index in path:
        value = getattr(node, field)
        node = value if index is None else value[index]
    return node


def _set_child(
    parent: ast.AST,
    step: tuple[str, int | None],
    replacement: ast.AST,
) -> None:
    field, index = step
    if index is None:
        setattr(parent, field, replacement)
    else:
        getattr(parent, field)[index] = replacement


def _is_boolean_expression(node: ast.AST) -> bool:
    if isinstance(node, (ast.Compare, ast.BoolOp)):
        return True
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return True
    return isinstance(node, ast.Constant) and isinstance(node.value, bool)


def _operators_for(node: ast.AST) -> list[str]:
    """Return the deterministic operator list that applies to ``node``."""
    operators: list[str] = []
    if isinstance(node, ast.If):
        operators.append("negate_if")
    elif isinstance(node, ast.Compare):
        if any(type(op) in _COMPARE_SWAP for op in node.ops):
            operators.append("swap_compare")
    elif isinstance(node, ast.BoolOp):
        if isinstance(node.op, (ast.And, ast.Or)):
            operators.append("swap_boolop")
    elif isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, bool):
            operators.append("flip_constant")
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            if value in (0, 1, 0.0, 1.0):
                operators.append("flip_constant")
    elif isinstance(node, ast.Return):
        if node.value is not None and not (
            isinstance(node.value, ast.Constant) and node.value.value is None
        ):
            if _is_boolean_expression(node.value):
                operators.append("add_not_return")
            operators.append("return_none")
    elif isinstance(node, ast.Raise):
        operators.append("raise_return")
    return operators


def _apply_operator(
    function_root: ast.AST,
    path: tuple[tuple[str, int | None], ...],
    operator: str,
) -> None:
    node = _get_node(function_root, path)
    if operator == "negate_if":
        assert isinstance(node, ast.If)
        node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
    elif operator == "swap_compare":
        assert isinstance(node, ast.Compare)
        for index, op in enumerate(node.ops):
            replacement = _COMPARE_SWAP.get(type(op))
            if replacement is not None:
                node.ops[index] = replacement()
                break
    elif operator == "swap_boolop":
        assert isinstance(node, ast.BoolOp)
        node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
    elif operator == "flip_constant":
        assert isinstance(node, ast.Constant)
        value = node.value
        if isinstance(value, bool):
            node.value = not value
        elif isinstance(value, float):
            node.value = 1.0 if value == 0.0 else 0.0
        else:
            node.value = 1 if value == 0 else 0
    elif operator == "add_not_return":
        assert isinstance(node, ast.Return) and node.value is not None
        node.value = ast.UnaryOp(op=ast.Not(), operand=node.value)
    elif operator == "return_none":
        assert isinstance(node, ast.Return)
        node.value = ast.Constant(value=None)
    elif operator == "raise_return":
        assert isinstance(node, ast.Raise)
        parent = _get_node(function_root, path[:-1])
        _set_child(parent, path[-1], ast.Return(value=ast.Constant(value=None)))
    else:  # pragma: no cover - internal invariant
        raise ValueError(f"unknown mutation operator: {operator!r}")


def _candidate_source(
    module: ast.Module,
    function_index: int,
    path: tuple[tuple[str, int | None], ...],
    operator: str,
    relative: str,
) -> str | None:
    mutated = copy.deepcopy(module)
    function_root = mutated.body[function_index]
    try:
        _apply_operator(function_root, path, operator)
        text = ast.unparse(mutated)
        ast.parse(text, filename=relative)
        compile(text, relative, "exec")
    except (SyntaxError, ValueError, TypeError):
        return None
    return text


def generate_mutants(
    vulnerable_dir: str | Path,
    patched_dir: str | Path,
    python_path: Iterable[str] = (),
    seed: int = 0,
    max_mutants: int = MAX_MUTANTS,
) -> list[Mutant]:
    """Return a deterministic, seeded sample of single-mutation mutants."""
    if max_mutants <= 0:
        return []
    vulnerable_root = Path(vulnerable_dir).resolve()
    patched_root = Path(patched_dir).resolve()
    changed = changed_functions(vulnerable_root, patched_root, python_path)

    by_file: dict[str, list[str]] = {}
    for relative, name in changed:
        by_file.setdefault(relative, []).append(name)

    # ``_Candidate`` is an internal tuple: key, relative, operator, source.
    candidates: list[tuple[tuple[object, ...], str, str, str]] = []
    counter = 0
    for relative in sorted(by_file):
        module = _parse(patched_root / relative)
        if module is None:
            continue
        indexes = {
            node.name: index
            for index, node in enumerate(module.body)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        for name in sorted(by_file[relative]):
            index = indexes.get(name)
            if index is None:
                continue
            function_root = module.body[index]

            guard_sources: list[tuple[tuple[object, ...], str, str, str]] = []
            terminal_sources: list[tuple[tuple[object, ...], str, str, str]] = []
            seen_sources: set[str] = set()
            for node, path in _walk_with_paths(function_root):
                for operator in _operators_for(node):
                    source = _candidate_source(
                        module, index, path, operator, relative
                    )
                    if source is None or source in seen_sources:
                        continue
                    seen_sources.add(source)
                    key = (
                        relative,
                        name,
                        operator,
                        int(getattr(node, "lineno", 0)),
                        int(getattr(node, "col_offset", 0)),
                        counter,
                    )
                    counter += 1
                    entry = (key, relative, operator, source)
                    if operator in GUARD_OPERATORS:
                        guard_sources.append(entry)
                    else:
                        terminal_sources.append(entry)
            candidates.extend(guard_sources or terminal_sources)

    candidates.sort(key=lambda item: item[0])
    if len(candidates) > max_mutants:
        rng = random.Random(seed)
        candidates = rng.sample(candidates, max_mutants)
        candidates.sort(key=lambda item: item[0])

    return [
        {
            "id": f"m{index + 1:03d}",
            "relative_path": relative,
            "source": source,
            "operator": operator,
        }
        for index, (_key, relative, operator, source) in enumerate(candidates)
    ]


def score(killed: int, ran: int) -> float | None:
    """Return ``killed / ran``, or ``None`` when no mutant actually ran."""
    if ran <= 0:
        return None
    return killed / ran
