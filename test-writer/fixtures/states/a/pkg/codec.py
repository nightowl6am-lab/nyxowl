"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``."""
    path = os.path.join(root, name)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
