"""Rootless runtime path resolution for the Test-Writer.

All paths are resolved at call time, never at import time, so callers (and the
self-tests) can set the ``TW_*`` environment after importing a module.

Defaults::

    install root     $HOME/.nyxowl/test-writer       TW_INSTALL_ROOT
    store root       <install root>/store            TW_STORE_ROOT
    workspace root   $HOME/tw-jobs                   TW_WORKSPACE_ROOT
    tmp root         <store root>/tmp                TW_TMP_ROOT
    venv python      <install root>/venv/bin/python  TW_VENV_PYTHON

The runtime is installed and run by the owner, so no system-owned install path
is required or created.
"""

from __future__ import annotations

import os
from pathlib import Path


def install_root() -> Path:
    """Return the owner-owned runtime tree."""
    override = os.environ.get("TW_INSTALL_ROOT")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".nyxowl" / "test-writer"


def store_root() -> Path:
    """Return the private job store, defaulting below the install root."""
    override = os.environ.get("TW_STORE_ROOT")
    if override:
        return Path(override).expanduser()
    return install_root() / "store"


def workspace_root() -> Path:
    """Return the owner/writer draft tree."""
    override = os.environ.get("TW_WORKSPACE_ROOT")
    if override:
        return Path(override).expanduser()
    return Path.home() / "tw-jobs"


def tmp_root() -> Path:
    """Return the sandbox scratch parent."""
    override = os.environ.get("TW_TMP_ROOT")
    if override:
        return Path(override).expanduser()
    return store_root() / "tmp"


def venv_python() -> Path:
    """Return the interpreter the sandbox is allowed to execute."""
    override = os.environ.get("TW_VENV_PYTHON")
    if override:
        return Path(override).expanduser()
    return install_root() / "venv" / "bin" / "python"
