"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    The guard uses a raw string-prefix comparison, so a parent reference keeps
    the root prefix and survives the check.
    """
    path = os.path.join(root, name)
    if not path.startswith(root):
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
