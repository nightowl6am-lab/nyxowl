"""Text helpers for the fixture package."""

import os
import urllib.parse


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    The name is percent-decoded twice before being joined onto the root.
    """
    decoded = urllib.parse.unquote(urllib.parse.unquote(name))
    path = os.path.join(root, decoded)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
