"""Text helpers for the fixture package."""

import os
import urllib.parse


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    This implementation decodes the name and then rejects any traversal
    component outright.  It accepts only clean relative paths.
    """
    if not isinstance(name, str) or not name:
        raise ValueError("name must be a non-empty relative path")
    decoded = urllib.parse.unquote(name)
    if decoded.startswith("/") or decoded.startswith("\\"):
        raise ValueError("name must be relative")
    parts = decoded.replace("\\", "/").split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("name must not contain a traversal component")
    path = os.path.join(root, *parts)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
