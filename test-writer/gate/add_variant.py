"""Owner-side ``tw-add-variant <id> --kind ... --ref ...``.

The command updates an existing owner draft.  It never runs as the subagent and
is deliberately not exposed through the MCP broker.  Each invocation rebuilds
one variant snapshot from a verified commit, verifies its entry point, and
updates the draft metadata plus the manifest hash.  The draft may hold one
variant temporarily; ``tw-approve`` refuses it until both variants are present.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

from . import common
from grader import job_check, package

USAGE = (
    "usage: tw-add-variant <id> --kind still_vulnerable|fixed_differently "
    "--ref <40hex> [--repo <path>]"
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_repo(job_id: str, explicit: str | None) -> Path:
    if explicit is None:
        recorded = common.read_source_record(job_id)
        if recorded is not None:
            return recorded
        explicit = str(Path.cwd())
    if not isinstance(explicit, str) or not explicit or "\x00" in explicit:
        raise common.Refusal(common.JOB_INVALID, "The repository path is not valid.")
    repo = Path(explicit).expanduser()
    if not repo.is_absolute():
        repo = Path.cwd() / repo
    if not repo.is_dir():
        raise common.Refusal(
            common.JOB_INVALID, "The repository path is not a directory."
        )
    return repo.resolve()


def _read_meta(draft: Path, job_id: str) -> dict[str, Any]:
    try:
        meta = common.read_json_file(draft / common.META_FILE)
    except (OSError, ValueError) as exc:
        raise common.Refusal(
            common.JOB_INVALID, "The draft metadata could not be read."
        ) from exc
    if not isinstance(meta, dict):
        raise common.Refusal(common.JOB_INVALID, "The draft metadata is not an object.")
    if meta.get("id") != job_id:
        raise common.Refusal(common.JOB_INVALID, "The draft id does not match.")
    return meta


def _base_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Validate every field except the possibly-incomplete variant object."""
    base = dict(meta)
    base.pop("variants", None)
    try:
        job_check.assert_valid_meta(base)
    except job_check.JobMetaError as exc:
        raise common.Refusal(
            common.JOB_INVALID, "The draft metadata is invalid."
        ) from exc
    return base


def _existing_variants(meta: dict[str, Any]) -> dict[str, str]:
    raw = meta.get("variants")
    if raw is None:
        return {}
    if not isinstance(raw, dict) or set(raw) - set(common.VARIANT_REF_KEYS):
        raise common.Refusal(common.JOB_INVALID, "The draft variants are invalid.")
    result: dict[str, str] = {}
    for key, value in raw.items():
        result[key] = common.validate_ref_value(value)
    return result


def _check_distinct(variants: dict[str, str], base: dict[str, Any]) -> None:
    refs = list(variants.values())
    if len(set(refs)) != len(refs):
        raise common.Refusal(common.JOB_INVALID, "The variant refs must be distinct.")
    protected = {base["vulnerable_ref"], base["patched_ref"]}
    if any(ref in protected for ref in refs):
        raise common.Refusal(
            common.JOB_INVALID,
            "A variant ref must differ from vulnerable_ref/patched_ref.",
        )


def add_variant(
    job_id: str,
    kind: str,
    ref: str,
    *,
    repo: str | None = None,
) -> dict[str, Any]:
    """Add or replace one variant snapshot in an existing owner draft."""
    identifier = common.validate_id(job_id)
    if kind not in common.VARIANT_KINDS:
        raise common.Refusal(common.JOB_INVALID, "The variant kind is not valid.")
    tar_name, ref_key = common.VARIANT_KINDS[kind]
    commit = common.validate_ref_value(ref)

    draft = common.workspace_root() / identifier
    if not draft.is_dir():
        raise common.Refusal(common.JOB_INVALID, "The draft was not found.")
    for name in common.BUNDLE_FILES:
        if not (draft / name).is_file():
            raise common.Refusal(
                common.JOB_INVALID, "The draft does not contain the required files."
            )

    meta = _read_meta(draft, identifier)
    base = _base_meta(meta)
    variants = _existing_variants(meta)
    variants[ref_key] = commit
    _check_distinct(variants, base)

    try:
        manifest = common.read_json_file(draft / common.MANIFEST_FILE)
    except (OSError, ValueError) as exc:
        raise common.Refusal(
            common.JOB_INVALID, "The manifest could not be read."
        ) from exc
    if not isinstance(manifest, dict):
        raise common.Refusal(common.JOB_INVALID, "The manifest is not an object.")

    repository = _resolve_repo(identifier, repo)
    tar_path = draft / tar_name
    python_path = list(base.get("python_path") or [])
    try:
        package.build_snapshot_tar(repository, commit, tar_path)
        package.verify_snapshot(
            tar_path, base["module"], base["function"], python_path
        )
    except (package.PackageError, OSError, ValueError) as exc:
        raise common.Refusal(
            common.JOB_INVALID, "The variant snapshot could not be built."
        ) from exc

    updated_meta = dict(meta)
    updated_meta["variants"] = variants
    updated_manifest = dict(manifest)
    updated_manifest[tar_name] = _sha256(tar_path)

    common.write_json_atomic(draft / common.META_FILE, updated_meta)
    common.write_json_atomic(draft / common.MANIFEST_FILE, updated_manifest)
    try:
        common.write_source_record(identifier, repository)
    except OSError:
        pass

    return {
        "ok": True,
        "id": identifier,
        "kind": kind,
        "variants": sorted(variants),
    }


def _parse_args(argv: list[str]) -> tuple[str, str, str, str | None]:
    if not argv:
        raise common.ProtocolError(USAGE)
    job_id = argv[0]
    values: dict[str, str] = {}
    index = 1
    while index < len(argv):
        flag = argv[index]
        if flag not in {"--kind", "--ref", "--repo"} or index + 1 >= len(argv):
            raise common.ProtocolError(USAGE)
        values[flag] = argv[index + 1]
        index += 2
    if "--kind" not in values or "--ref" not in values:
        raise common.ProtocolError(USAGE)
    return job_id, values["--kind"], values["--ref"], values.get("--repo")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        job_id, kind, ref, repo = _parse_args(args)
        response = add_variant(job_id, kind, ref, repo=repo)
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code
    except (OSError, ValueError):
        refusal = common.Refusal(
            common.JOB_INVALID, "The variant could not be added."
        )
        common.emit_json(common.refusal_payload(refusal))
        return 1
    common.emit_json(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
