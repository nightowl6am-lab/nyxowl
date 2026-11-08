"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    Forward-slash parent references are rejected, but backslashes are
    normalised afterwards, so ``..\\secret.txt`` still escapes the root.
    """
    if name.startswith("../"):
        raise ValueError("name must stay inside the fixture root")
    normalized = name.replace("\\", "/")
    path = os.path.join(root, normalized)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
