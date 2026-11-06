"""Text helpers for the fixture package."""

import os


def decode(name: str, root: str) -> str:
    """Return the UTF-8 text stored at ``name`` under ``root``.

    This variant rejects absolute names and every backslash, but it joins the
    remaining name directly.  A parent reference such as ``../secret.txt`` is
    therefore still accepted and escapes ``root``.
    """
    if not isinstance(name, str) or not name:
        raise ValueError("name must be a non-empty relative path")
    if (
        name.startswith("/")
        or name.startswith("\\")
        or "\\" in name
        or os.path.isabs(name)
    ):
        raise ValueError("name must be a relative POSIX path")
    path = os.path.join(root, name)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
