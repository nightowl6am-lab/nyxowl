"""AST-only entry-point interface extraction.

The grader must never import target code in the parent process.  This module
locates a module file under a committed snapshot plus ``python_path``, parses it
with :mod:`ast`, and returns a stable signature string.
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path
from typing import Any, Iterable

try:
    from .ids import validate_rel_path
except ImportError:  # CLI/module execution from ``grader/``
    from ids import validate_rel_path

MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
FUNCTION_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_SOURCE_BYTES = 4 * 1024 * 1024


class InterfaceError(ValueError):
    """A typed failure for a missing or unsafe interface entry point."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def _within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError:
        return False


def _module_parts(module: str) -> list[str]:
    if not isinstance(module, str) or MODULE_RE.fullmatch(module) is None:
        raise InterfaceError("bad_module", "module is not a dotted identifier")
    return module.split(".")


def _candidate_files(
    snapshot: Path,
    parts: list[str],
    python_path: Iterable[str],
) -> list[Path]:
    if isinstance(python_path, str):
        raise InterfaceError("bad_python_path", "python_path must be a list")
    entries = list(python_path)
    if not entries:
        entries = ["."]
    candidates: list[Path] = []
    for entry in entries:
        if not isinstance(entry, str):
            raise InterfaceError("bad_python_path", "python_path entries must be strings")
        try:
            validate_rel_path(entry)
        except ValueError as exc:
            raise InterfaceError("bad_python_path", str(exc)) from exc
        base = snapshot if entry == "." else snapshot / entry
        module_file = base.joinpath(*parts).with_suffix(".py")
        package_file = base.joinpath(*parts) / "__init__.py"
        candidates.extend([module_file, package_file])
    return candidates


def _locate(snapshot: Path, module: str, python_path: Iterable[str]) -> Path:
    parts = _module_parts(module)
    for candidate in _candidate_files(snapshot, parts, python_path):
        if not candidate.is_file():
            continue
        if not _within(candidate, snapshot):
            raise InterfaceError("unsafe_module", "module escapes the snapshot")
        return candidate
    raise InterfaceError("missing_module", "target module was not found under the snapshot")


def _function_node(tree: ast.Module, function: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function:
            return node
    raise InterfaceError("missing_function", "target function was not found in the module")


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    arguments = ast.unparse(node.args)
    returns = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
    return f"{node.name}({arguments}){returns}"


def extract_function(
    snapshot_dir: str | os.PathLike[str],
    module: str,
    function: str,
    python_path: Iterable[str] | None = None,
) -> str:
    """Return ``name(args) -> return`` for one snapshot entry point.

    Raises :class:`InterfaceError` for a bad module/function name, a missing
    file, a syntax error, or a module that resolves outside the snapshot.
    """
    if not isinstance(function, str) or FUNCTION_RE.fullmatch(function) is None:
        raise InterfaceError("bad_function", "function is not an identifier")
    snapshot = Path(snapshot_dir)
    if not snapshot.is_dir():
        raise InterfaceError("missing_snapshot", "snapshot directory was not found")

    path = _locate(snapshot, module, python_path or ())
    try:
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise InterfaceError("source_too_large", "target module is too large to parse")
        source = path.read_bytes()
    except OSError as exc:
        raise InterfaceError("missing_module", f"could not read target module: {exc}") from exc

    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        raise InterfaceError("syntax", f"target module does not parse: {exc.msg}") from exc
    except (ValueError, UnicodeError) as exc:
        raise InterfaceError("syntax", f"target module could not be decoded: {exc}") from exc

    node = _function_node(tree, function)
    return _signature(node)


def assert_entry(
    snapshot_dir: str | os.PathLike[str],
    meta: dict[str, Any],
) -> str:
    """Validate ``meta``'s entry point against ``snapshot_dir`` and return its signature."""
    if not isinstance(meta, dict):
        raise InterfaceError("bad_meta", "metadata must be an object")
    module = meta.get("module")
    function = meta.get("function")
    python_path = meta.get("python_path", ())
    if not isinstance(module, str) or not isinstance(function, str):
        raise InterfaceError("bad_meta", "metadata must name a module and function")
    if python_path is None:
        python_path = ()
    if isinstance(python_path, str):
        raise InterfaceError("bad_python_path", "python_path must be a list")
    signature = extract_function(snapshot_dir, module, function, python_path)

    interface = meta.get("interface")
    if isinstance(interface, str):
        for line in interface.splitlines():
            stripped = line.strip()
            if stripped.startswith("signature:"):
                expected = stripped.split(":", 1)[1].strip()
                if expected != signature:
                    raise InterfaceError(
                        "signature_mismatch",
                        "interface signature does not match the snapshot entry point",
                    )
                break
    return signature
