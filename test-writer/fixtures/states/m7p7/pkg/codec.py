"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    The resolved candidate must start with the resolved root followed by a
    path separator.
    """
    root_path = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root_path, name))
    if not path.startswith(root_path + os.sep):
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
