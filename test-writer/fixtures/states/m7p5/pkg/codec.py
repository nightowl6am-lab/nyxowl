"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    Backslashes are normalised to forward slashes, then the resolved candidate
    must stay inside the resolved root.
    """
    normalized = name.replace("\\", "/")
    root_path = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root_path, normalized))
    if os.path.commonpath([root_path, path]) != root_path:
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
