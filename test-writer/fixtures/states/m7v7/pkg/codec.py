"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    The joined name is compared with the real root using a raw string prefix,
    so a parent reference keeps the root prefix and survives the check.
    """
    root_path = os.path.realpath(root)
    path = os.path.join(root_path, name)
    if not path.startswith(root_path):
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
