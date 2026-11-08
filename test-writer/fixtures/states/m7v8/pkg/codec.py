"""Text helpers for the fixture package."""

import os
import unicodedata


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    A literal parent reference is rejected before the name is NFKC-normalised
    and joined onto the root with no containment check.
    """
    if ".." in name:
        raise ValueError("name must stay inside the fixture root")
    normalized = unicodedata.normalize("NFKC", name)
    path = os.path.join(root, normalized)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
