"""Owner-side ``tw-new-job --json``: build a reviewable job draft.

The draft never enters the grader store.  It contains two immutable ``git
archive`` snapshots, the validated metadata, the derived interface text, and a
sha256 manifest.  The owner later runs ``tw-approve`` which hands an in-memory
bundle to the grader-side ``tw-store-job``.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import common
from grader import extract_interface, job_check, package


def _build_meta(body: dict[str, Any]) -> dict[str, Any]:
    raw_budget = body.get("budget")
    if raw_budget is None:
        budget = dict(common.DEFAULT_BUDGET)
    elif isinstance(raw_budget, dict):
        budget = dict(common.DEFAULT_BUDGET)
        budget.update(raw_budget)
    else:
        budget = raw_budget

    raw_python_path = body.get("python_path")
    if raw_python_path is None:
        python_path: Any = []
    else:
        python_path = raw_python_path

    module = body.get("module")
    allowed_modules = body.get("allowed_modules")
    if allowed_modules is None:
        allowed_modules = [module] if isinstance(module, str) else []

    detector = body.get("detector")
    if detector is None:
        detector = dict(common.DEFAULT_DETECTOR)

    helper_api = body.get("helper_api")
    if helper_api is None:
        helper_api = common.DEFAULT_HELPER_API

    meta = {
        "id": body.get("id"),
        "vulnerable_ref": body.get("vulnerable_ref"),
        "patched_ref": body.get("patched_ref"),
        "module": module,
        "function": body.get("function"),
        "fix_origin": body.get("fix_origin"),
        "python_path": python_path,
        "allowed_modules": allowed_modules,
        "interface": body.get("interface"),
        "helper_api": helper_api,
        "detector": detector,
        "budget": budget,
        "spec_markdown": body.get("spec_markdown"),
    }
    variants = body.get("variants")
    if variants is not None:
        meta["variants"] = variants
    return meta


def _require_repo(body: dict[str, Any]) -> Path:
    raw = body.get("repo")
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise common.Refusal(common.JOB_INVALID, "The repository path is not valid.")
    repo = Path(raw)
    if not repo.is_absolute() or not repo.is_dir():
        raise common.Refusal(common.JOB_INVALID, "The repository path is not a directory.")
    return repo


def _build_interface(
    vulnerable_tar: Path,
    module: str,
    function: str,
    python_path: list[str],
) -> str:
    temporary = Path(tempfile.mkdtemp(prefix="tw-interface-"))
    try:
        package.safe_extract(vulnerable_tar, temporary)
        meta = {
            "module": module,
            "function": function,
            "python_path": python_path,
        }
        signature = extract_interface.assert_entry(temporary, meta)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return f"module: {module}\nfunction: {function}\nsignature: {signature}\n"


def create_draft(body: Any) -> dict[str, Any]:
    """Validate ``body``, build the draft, and return its public response."""
    if not isinstance(body, dict):
        raise common.Refusal(common.JOB_INVALID, "The prepare body must be an object.")

    meta = _build_meta(body)
    try:
        common.validate_id(meta["id"])
        job_check.assert_valid_meta(meta)
    except (common.Refusal, job_check.JobMetaError) as exc:
        raise common.Refusal(common.JOB_INVALID, "The job metadata is invalid.") from exc

    job_id = meta["id"]
    repo = _require_repo(body)

    drafts = common.workspace_root()
    drafts.mkdir(parents=True, exist_ok=True, mode=0o700)
    final = drafts / job_id
    if final.exists():
        raise common.Refusal(common.JOB_EXISTS, "The draft already exists.")

    staging = Path(tempfile.mkdtemp(prefix=f".{job_id}.", dir=drafts))
    try:
        vulnerable = staging / common.VULNERABLE_TAR
        patched = staging / common.PATCHED_TAR
        package.build_snapshot_tar(repo, meta["vulnerable_ref"], vulnerable)
        package.build_snapshot_tar(repo, meta["patched_ref"], patched)

        has_variants = "variants" in meta
        variant_paths: dict[str, Path] = {}
        if has_variants:
            variants = meta["variants"]
            for kind in ("still_vulnerable", "fixed_differently"):
                tar_name, ref_key = common.VARIANT_KINDS[kind]
                variant_paths[tar_name] = staging / tar_name
                package.build_snapshot_tar(
                    repo, variants[ref_key], variant_paths[tar_name]
                )

        python_path = list(meta["python_path"])
        try:
            meta["interface"] = _build_interface(
                vulnerable, meta["module"], meta["function"], python_path
            )
        except extract_interface.InterfaceError as exc:
            raise common.Refusal(
                common.JOB_INVALID, "The target entry point could not be resolved."
            ) from exc

        # Re-check after the interface text was derived.
        try:
            job_check.assert_valid_meta(meta)
        except job_check.JobMetaError as exc:
            raise common.Refusal(common.JOB_INVALID, "The job metadata is invalid.") from exc

        package.verify_snapshot(
            vulnerable, meta["module"], meta["function"], python_path
        )
        package.verify_snapshot(patched, meta["module"], meta["function"], python_path)
        for tar_path in variant_paths.values():
            package.verify_snapshot(
                tar_path, meta["module"], meta["function"], python_path
            )

        manifest = {
            common.VULNERABLE_TAR: _sha256(vulnerable),
            common.PATCHED_TAR: _sha256(patched),
        }
        for tar_name, tar_path in variant_paths.items():
            manifest[tar_name] = _sha256(tar_path)
        common.write_json_atomic(staging / common.META_FILE, meta)
        common.write_json_atomic(staging / common.MANIFEST_FILE, manifest)

        try:
            os.rename(staging, final)
        except OSError as exc:
            if final.exists():
                raise common.Refusal(common.JOB_EXISTS, "The draft already exists.") from exc
            raise common.Refusal(
                common.JOB_INVALID, "The draft could not be written."
            ) from exc
        staging = None
        try:
            common.write_source_record(job_id, repo)
        except OSError:
            # The draft is still valid; ``tw-add-variant`` can accept --repo.
            pass
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)

    return {"id": job_id, "workspaceHint": str(final)}


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args != ["--json"]:
            raise common.ProtocolError("usage: tw-new-job --json")
        body = common.read_stdin_json(common.MAX_PREPARE_BYTES)
        response = create_draft(body)
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code
    except (OSError, ValueError):
        refusal = common.Refusal(common.JOB_INVALID, "The draft could not be built.")
        common.emit_json(common.refusal_payload(refusal))
        return refusal.exit_code
    common.emit_json(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
