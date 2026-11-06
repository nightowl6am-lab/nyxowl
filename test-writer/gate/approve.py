"""Owner-side ``tw-approve <id>``: bundle a draft and store it locally.

The bundle is built in memory and piped directly to
``<install>/bin/tw-store-job`` as the current user.  The rootless runtime uses
no privilege transition and no password prompt.  The bundle is never printed.
"""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

from . import common
from grader import job_check, package


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_draft(job_id: str) -> tuple[dict[str, Any], Path]:
    draft = common.workspace_root() / job_id
    if not draft.is_dir():
        raise common.Refusal(common.JOB_INVALID, "The draft was not found.")

    try:
        meta = common.read_json_file(draft / common.META_FILE)
    except (OSError, ValueError) as exc:
        raise common.Refusal(common.JOB_INVALID, "The draft metadata could not be read.") from exc
    if not isinstance(meta, dict):
        raise common.Refusal(common.JOB_INVALID, "The draft metadata is not an object.")
    try:
        job_check.assert_valid_meta(meta)
    except job_check.JobMetaError as exc:
        raise common.Refusal(common.JOB_INVALID, "The draft metadata is invalid.") from exc
    if meta.get("id") != job_id:
        raise common.Refusal(common.JOB_INVALID, "The draft id does not match.")

    has_variants = "variants" in meta
    expected = set(common.bundle_files(has_variants))
    present = {entry.name for entry in draft.iterdir() if entry.is_file()}
    if present != expected:
        raise common.Refusal(
            common.JOB_INVALID, "The draft does not contain exactly the managed files."
        )

    try:
        manifest = common.read_json_file(draft / common.MANIFEST_FILE)
    except (OSError, ValueError) as exc:
        raise common.Refusal(common.JOB_INVALID, "The manifest could not be read.") from exc
    if not isinstance(manifest, dict):
        raise common.Refusal(common.JOB_INVALID, "The manifest is not an object.")

    python_path = list(meta.get("python_path") or [])
    tar_names = [common.VULNERABLE_TAR, common.PATCHED_TAR]
    if has_variants:
        tar_names.extend(common.VARIANT_TARS)
    for name in tar_names:
        path = draft / name
        expected_hash = manifest.get(name)
        if not isinstance(expected_hash, str) or expected_hash != _sha256(path):
            raise common.Refusal(common.JOB_INVALID, "A snapshot hash does not match.")
        try:
            package.verify_snapshot(
                path, meta["module"], meta["function"], python_path
            )
        except (package.PackageError, ValueError) as exc:
            raise common.Refusal(common.JOB_INVALID, "A snapshot could not be verified.") from exc

    return meta, draft


def build_bundle(draft: Path, include_variants: bool | None = None) -> bytes:
    """Return a deterministic in-memory tar of the managed files.

    When ``include_variants`` is omitted, the two variant tars are included
    only when both are present in the draft.
    """
    if include_variants is None:
        include_variants = all(
            (draft / name).is_file() for name in common.VARIANT_TARS
        )
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name in common.bundle_files(include_variants):
            data = (draft / name).read_bytes()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            info.mode = 0o600
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def store_bundle(job_id: str, bundle: bytes) -> tuple[bytes, int]:
    executable = common.install_root() / "bin" / "tw-store-job"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise common.Refusal(
            common.RUNTIME_UNAVAILABLE, "tw-store-job is not installed."
        )
    completed = subprocess.run(
        [str(executable), job_id],
        input=bundle,
        stdout=subprocess.PIPE,
        stderr=None,
        check=False,
        shell=False,
    )
    return completed.stdout, completed.returncode


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        common.emit_json(
            common.refusal_payload(common.ProtocolError("usage: tw-approve <id>"))
        )
        return 2
    try:
        job_id = common.validate_id(args[0])
        meta, draft = load_draft(job_id)
        bundle = build_bundle(draft, "variants" in meta)
        output, returncode = store_bundle(job_id, bundle)
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code or 1
    except (OSError, ValueError):
        refusal = common.Refusal(common.JOB_INVALID, "The draft could not be approved.")
        common.emit_json(common.refusal_payload(refusal))
        return 1

    text = output.decode("utf-8", "replace").strip()
    if returncode != 0:
        if text:
            sys.stdout.write(text + "\n")
        else:
            common.emit_json(
                common.refusal_payload(
                    common.Refusal(common.JOB_INVALID, "The store refused the bundle.")
                )
            )
        return 1
    print(f"APPROVED {job_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
