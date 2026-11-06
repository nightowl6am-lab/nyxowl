"""Text helpers for the fixture package."""

import os
import urllib.parse


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    This incomplete fix rejects a literal parent reference, then decodes the
    name.  Encoded traversal therefore survives the check.
    """
    if ".." in name or name.startswith("/") or name.startswith("\\"):
        raise ValueError("name must stay inside the fixture root")
    decoded = urllib.parse.unquote(name)
    path = os.path.join(root, decoded)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
