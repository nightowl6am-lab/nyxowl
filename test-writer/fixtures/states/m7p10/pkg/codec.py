"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    Leading parent references and absolute names are rejected, and the
    resolved candidate must stay inside the resolved root.
    """
    if (
        name.startswith("../")
        or name.startswith("..\\")
        or os.path.isabs(name)
    ):
        raise ValueError("name must stay inside the fixture root")
    root_path = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root_path, name))
    if os.path.commonpath([root_path, path]) != root_path:
        raise ValueError("path escapes the fixture root")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
