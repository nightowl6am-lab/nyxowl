"""Text helpers for the fixture package."""

import urllib.parse
from pathlib import Path


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    This fix decodes percent escapes and then requires the resolved candidate
    path to stay below the resolved root.  It is deliberately different from
    the ``realpath`` plus ``commonpath`` implementation in state b.
    """
    if not isinstance(name, str) or not name:
        raise ValueError("name must be a non-empty relative path")
    decoded = urllib.parse.unquote(name)
    if decoded.startswith("/") or decoded.startswith("\\") or "\\" in decoded:
        raise ValueError("name must be a relative POSIX path")
    root_path = Path(root).resolve()
    candidate = (root_path / decoded).resolve()
    if not candidate.is_relative_to(root_path):
        raise ValueError("path escapes the fixture root")
    with open(candidate, "r", encoding="utf-8") as handle:
        return handle.read()
