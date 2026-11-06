"""Grader-side ``tw-store-job <id>``: verify and install an approved bundle.

The tar arrives on stdin.  It is extracted into a private temporary directory
inside the store, checked byte-for-byte against the manifest, validated with
``job_check``, and only then moved into ``<store>/jobs/<id>/``.  Nothing is
printed except deterministic JSON.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import common
from grader import job_check, package, store


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_meta(incoming: Path) -> dict[str, Any]:
    try:
        meta = common.read_json_file(incoming / common.META_FILE)
    except (OSError, ValueError) as exc:
        raise common.Refusal(common.JOB_INVALID, "The job metadata could not be read.") from exc
    if not isinstance(meta, dict):
        raise common.Refusal(common.JOB_INVALID, "The job metadata is not an object.")
    try:
        job_check.assert_valid_meta(meta)
    except job_check.JobMetaError as exc:
        raise common.Refusal(common.JOB_INVALID, "The job metadata is invalid.") from exc
    return meta


def store_from_path(job_id: str, bundle_path: Path) -> dict[str, Any]:
    """Verify ``bundle_path`` and atomically install job ``job_id``."""
    identifier = common.validate_id(job_id)
    store.tmp_dir()
    jobs_root = common.store_root() / "jobs"
    jobs_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    final = jobs_root / identifier
    if final.exists():
        raise common.Refusal(common.JOB_EXISTS, "The job already exists.")

    incoming = Path(tempfile.mkdtemp(prefix=".incoming-", dir=store.tmp_dir()))
    try:
        try:
            extracted = package.safe_extract(bundle_path, incoming)
        except (package.PackageError, OSError, ValueError) as exc:
            raise common.Refusal(common.JOB_INVALID, "The bundle could not be extracted.") from exc
        files = set(extracted)
        if files == set(common.BUNDLE_FILES):
            include_variants = False
        elif files == set(common.bundle_files(True)):
            include_variants = True
        else:
            raise common.Refusal(
                common.JOB_INVALID, "The bundle does not contain exactly the managed files."
            )

        meta = _read_meta(incoming)
        if meta.get("id") != identifier:
            raise common.Refusal(common.JOB_INVALID, "The bundle id does not match.")
        if include_variants and "variants" not in meta:
            raise common.Refusal(
                common.JOB_INVALID, "The bundle variant metadata is missing."
            )

        try:
            manifest = common.read_json_file(incoming / common.MANIFEST_FILE)
        except (OSError, ValueError) as exc:
            raise common.Refusal(common.JOB_INVALID, "The manifest could not be read.") from exc
        if not isinstance(manifest, dict):
            raise common.Refusal(common.JOB_INVALID, "The manifest is not an object.")

        python_path = list(meta.get("python_path") or [])
        tar_names = [common.VULNERABLE_TAR, common.PATCHED_TAR]
        if include_variants:
            tar_names.extend(common.VARIANT_TARS)
        for name in tar_names:
            path = incoming / name
            expected = manifest.get(name)
            if not isinstance(expected, str) or expected != _sha256(path):
                raise common.Refusal(common.JOB_INVALID, "A snapshot hash does not match.")
            try:
                package.verify_snapshot(
                    path, meta["module"], meta["function"], python_path
                )
            except (package.PackageError, ValueError) as exc:
                raise common.Refusal(
                    common.JOB_INVALID, "A snapshot could not be verified."
                ) from exc

        # WHY: every installed managed file is private.  Previously only the
        # variant tars were chmodded, so meta.json, manifest.json, and the two
        # source tars kept the extractor's mode (typically 0644).  Do this
        # after verification and before the atomic rename so the published job
        # is never briefly readable by another account.
        for name in common.bundle_files(include_variants):
            try:
                os.chmod(incoming / name, 0o600)
            except OSError as exc:
                raise common.Refusal(
                    common.JOB_INVALID, "A bundled file could not be prepared."
                ) from exc

        budget = meta.get("budget") or {}
        max_attempts = int(budget.get("max_attempts", 1))
        # Write the mutable job files into the staging directory so the
        # directory rename is the single atomic publish step.  This is
        # stronger than writing them after the rename: readers never observe
        # a job directory without its state or audit record.
        now = common.utc_now()
        common.write_json_atomic(
            incoming / store.STATE_FILE,
            {
                "id": identifier,
                "status": "approved",
                "verdict": None,
                "reason": None,
                "flags": [],
                "attempts": 0,
                "max_attempts": max_attempts,
                "created_at": now,
                "updated_at": now,
            },
            0o600,
        )
        audit = (
            f"{now} id={identifier} "
            f"vulnerable_ref={meta['vulnerable_ref']} "
            f"patched_ref={meta['patched_ref']}\n"
        )
        common.write_text_atomic(incoming / "audit.log", audit, 0o600)

        if final.exists():
            raise common.Refusal(common.JOB_EXISTS, "The job already exists.")
        try:
            os.rename(incoming, final)
        except OSError as exc:
            if final.exists():
                raise common.Refusal(common.JOB_EXISTS, "The job already exists.") from exc
            raise common.Refusal(common.JOB_INVALID, "The job could not be stored.") from exc
    finally:
        shutil.rmtree(incoming, ignore_errors=True)

    return {"ok": True, "id": identifier}


def store_bundle(job_id: str, bundle: bytes) -> dict[str, Any]:
    """Install an in-memory bundle; used by the self-tests as the current user."""
    if not isinstance(bundle, (bytes, bytearray)):
        raise common.Refusal(common.JOB_INVALID, "The bundle is not bytes.")
    if len(bundle) > common.MAX_BUNDLE_BYTES:
        raise common.Refusal(common.JOB_INVALID, "The bundle exceeded its byte limit.")
    store.tmp_dir()
    descriptor, name = tempfile.mkstemp(prefix=".bundle-", dir=store.tmp_dir())
    path = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(bundle)
            handle.flush()
            os.fsync(handle.fileno())
        return store_from_path(job_id, path)
    finally:
        try:
            path.unlink()
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(args) != 1:
            raise common.ProtocolError("usage: tw-store-job <id>")
        job_id = common.validate_id(args[0])
        store.tmp_dir()
        descriptor, name = tempfile.mkstemp(prefix=".incoming-bundle-", dir=store.tmp_dir())
        path = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                total = 0
                while True:
                    chunk = sys.stdin.buffer.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > common.MAX_BUNDLE_BYTES:
                        raise common.ProtocolError("The bundle exceeded its byte limit.")
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            result = store_from_path(job_id, path)
        finally:
            try:
                path.unlink()
            except OSError:
                pass
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code or 1
    except (OSError, ValueError):
        refusal = common.Refusal(common.JOB_INVALID, "The job could not be stored.")
        common.emit_json(common.refusal_payload(refusal))
        return 1
    common.emit_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
