"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    Backslashes are normalised to forward slashes and joined directly onto the
    root with no containment check.
    """
    normalized = name.replace("\\", "/")
    path = os.path.join(root, normalized)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
