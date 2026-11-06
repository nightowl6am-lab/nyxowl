"""Deterministic Git snapshot packaging and safe extraction.

A snapshot is an uncompressed tar produced by ``git archive`` for a verified
40-hex commit.  Extraction is deliberately manual: only regular files and
directories are accepted, links/devices are rejected, every name must stay
under the destination, and total size is bounded.

No function in this module imports or executes target code.  Interface
verification delegates to :mod:`grader.extract_interface`, which parses with
``ast`` only.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

try:
    from . import extract_interface
    from .ids import safe_join, validate_ref, validate_rel_path
except ImportError:  # CLI/module execution from ``grader/``
    import extract_interface  # type: ignore
    from ids import safe_join, validate_ref, validate_rel_path

MAX_FILES = 10_000
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_PATH_CHARS = 4096

GIT_TIMEOUT_SECONDS = 120


class PackageError(ValueError):
    """Raised when a snapshot cannot be built, verified, or extracted safely."""


def _reject(message: str) -> None:
    raise PackageError(message)


def _safe_member_name(member: tarfile.TarInfo) -> str:
    name = member.name
    if not isinstance(name, str) or not name:
        _reject("tar member has an empty name")
    if "\x00" in name:
        _reject("tar member name contains NUL")
    if len(name) > MAX_PATH_CHARS:
        _reject("tar member name is too long")
    if member.issym() or member.islnk():
        _reject("tar member is a link")
    if member.ischr() or member.isblk() or member.isfifo() or member.issparse():
        _reject("tar member is a special file")
    if not (member.isreg() or member.isdir()):
        _reject("tar member is not a regular file or directory")
    if name in {".", "./"}:
        return name
    try:
        validate_rel_path(name.rstrip("/"))
    except ValueError as exc:
        _reject(f"unsafe tar member name: {exc}")
    return name


def safe_extract(tar_path: str | os.PathLike[str], dest_dir: str | os.PathLike[str]) -> list[str]:
    """Extract a tar into ``dest_dir``, rejecting anything but files and dirs.

    Returns the sorted list of extracted relative paths.
    """
    source = Path(tar_path)
    if not source.is_file():
        raise PackageError("tar file was not found")
    destination = Path(dest_dir)
    destination.mkdir(parents=True, exist_ok=True)

    extracted: list[str] = []
    total_bytes = 0
    file_count = 0
    try:
        archive = tarfile.open(source, mode="r:*")
    except (tarfile.TarError, OSError) as exc:
        raise PackageError(f"could not open tar: {exc}") from exc

    with archive:
        for member in archive:
            name = _safe_member_name(member)
            if name in {".", "./"}:
                if not member.isdir():
                    _reject("tar root entry is not a directory")
                continue
            relative = name.rstrip("/")
            try:
                target = Path(safe_join(str(destination), relative))
            except ValueError as exc:
                raise PackageError(f"unsafe tar member path: {exc}") from exc

            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                extracted.append(relative)
                continue

            file_count += 1
            if file_count > MAX_FILES:
                _reject("tar contains too many files")
            if member.size < 0 or member.size > MAX_FILE_BYTES:
                _reject("tar member exceeds the per-file size limit")
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_BYTES:
                _reject("tar exceeds the total size limit")

            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            source_handle = archive.extractfile(member)
            if source_handle is None:
                _reject("tar member has no data")
            descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o644,
            )
            written = 0
            try:
                with os.fdopen(descriptor, "wb") as output:
                    while True:
                        chunk = source_handle.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > MAX_FILE_BYTES:
                            _reject("tar member grew beyond the per-file limit")
                        output.write(chunk)
                os.chmod(target, 0o644)
            except BaseException:
                try:
                    os.unlink(target)
                except OSError:
                    pass
                raise
            extracted.append(relative)

    return sorted(extracted)


def _git_env() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": "/nonexistent",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
        "TZ": "UTC",
    }


def _run_git(repo: Path, args: list[str], *, timeout: int = GIT_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["git", "-C", str(repo), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_git_env(),
            timeout=timeout,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PackageError(f"could not run git: {exc}") from exc


def build_snapshot_tar(
    repo: str | os.PathLike[str],
    ref: str,
    out_path: str | os.PathLike[str],
) -> str:
    """Archive one verified commit into ``out_path`` atomically.

    Returns the 40-hex ref that was archived.
    """
    try:
        commit = validate_ref(ref)
    except ValueError as exc:
        raise PackageError(f"invalid ref: {exc}") from exc
    repository = Path(repo)
    if not repository.is_dir():
        raise PackageError("repository directory was not found")

    kind = _run_git(repository, ["cat-file", "-t", commit], timeout=30)
    if kind.returncode != 0 or kind.stdout.strip() != b"commit":
        raise PackageError("ref is not a commit object")

    destination = Path(out_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            try:
                completed = subprocess.run(
                    ["git", "-C", str(repository), "archive", "--format=tar", commit],
                    stdin=subprocess.DEVNULL,
                    stdout=handle,
                    stderr=subprocess.PIPE,
                    env=_git_env(),
                    timeout=GIT_TIMEOUT_SECONDS,
                    check=False,
                    shell=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise PackageError(f"could not run git archive: {exc}") from exc
            if completed.returncode != 0:
                message = completed.stderr.decode("utf-8", "replace").strip()
                raise PackageError(f"git archive failed: {message}")
            handle.flush()
            os.fsync(handle.fileno())

        if temporary.stat().st_size == 0:
            raise PackageError("git archive produced an empty tar")
        try:
            with tarfile.open(temporary, mode="r:") as archive:
                has_file = any(
                    member.isreg() for member in archive.getmembers()
                )
        except (tarfile.TarError, OSError) as exc:
            raise PackageError(f"git archive produced an unreadable tar: {exc}") from exc
        if not has_file:
            raise PackageError("git archive tar contains no regular files")

        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass
    return commit


def verify_snapshot(
    tar_path: str | os.PathLike[str],
    module: str,
    function: str,
    python_path: list[str] | tuple[str, ...] = (),
) -> str:
    """Return the entry signature parsed from an extracted snapshot tar."""
    temporary = tempfile.mkdtemp(prefix="tw-snapshot-")
    try:
        safe_extract(tar_path, temporary)
        return extract_interface.extract_function(
            temporary, module, function, python_path
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
