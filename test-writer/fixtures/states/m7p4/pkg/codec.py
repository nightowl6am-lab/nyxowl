"""Text helpers for the fixture package."""

import os
import urllib.parse


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    The name is percent-decoded once and the resolved candidate must stay
    inside the resolved root.
    """
    decoded = urllib.parse.unquote(name)
    root_path = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root_path, decoded))
    if os.path.commonpath([root_path, path]) != root_path:
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
