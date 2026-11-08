"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    Leading parent references are rejected, but absolute names bypass the
    check because they replace the root entirely.
    """
    if name.startswith("../") or name.startswith("..\\"):
        raise ValueError("name must stay inside the fixture root")
    path = name if os.path.isabs(name) else os.path.join(root, name)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
