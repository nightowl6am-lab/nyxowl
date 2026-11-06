#!/usr/bin/env python3
"""Deterministic Git fixtures for the Test-Writer M1 jobs.

Each state directory under ``states/`` is committed with fixed author and
committer metadata, fixed messages, fixed parent commits, and explicit
``100644`` index modes.  The resulting commit hashes are therefore stable
across machines that share a compatible Git object format.

The builder never reads the network, never changes the caller's working
directory, and writes only to the requested ``--out`` directory or to
temporary directories it owns.  ``--verify`` builds the repository twice in
separate temporary directories, compares every state ref and every branch ref,
and compares the state refs with the full 40-hex refs recorded in
``jobs/*/job.json``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent
STATES_DIR = FIXTURES_DIR / "states"
JOBS_DIR = FIXTURES_DIR / "jobs"

AUTHOR_NAME = "Fixture Builder"
AUTHOR_EMAIL = "fixtures@example.invalid"
COMMIT_DATE = "2000-01-01T00:00:00+0000"

# The graph is intentional: b and d are alternative fixes for a, c is an
# independent already-safe root, and e is b plus hostile configuration.
STATE_PARENTS: dict[str, str | None] = {
    "a": None,
    "b": "a",
    "c": None,
    "d": "a",
    "e": "b",
}
STATE_MESSAGES = {
    "a": "state a: vulnerable decode",
    "b": "state b: containment fix",
    "c": "state c: safe from the start",
    "d": "state d: incomplete traversal fix",
    "e": "state e: containment fix plus hostile config",
}
STATE_ORDER = ("a", "b", "c", "d", "e")
REQUIRED_FILES = ("pkg/__init__.py", "pkg/codec.py", "data/greeting.txt")
REF_RE = re.compile(r"^[0-9a-f]{40}$")


class FixtureError(RuntimeError):
    """Raised when the fixture tree cannot be built or verified."""


def _base_env(home: Path) -> dict[str, str]:
    """Return a Git environment with no user or system configuration."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("GIT_")
    }
    env.update(
        {
            "GIT_AUTHOR_NAME": AUTHOR_NAME,
            "GIT_AUTHOR_EMAIL": AUTHOR_EMAIL,
            "GIT_AUTHOR_DATE": COMMIT_DATE,
            "GIT_COMMITTER_NAME": AUTHOR_NAME,
            "GIT_COMMITTER_EMAIL": AUTHOR_EMAIL,
            "GIT_COMMITTER_DATE": COMMIT_DATE,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "LC_ALL": "C",
            "TZ": "UTC",
        }
    )
    return env


def _git(
    repo: Path,
    args: list[str],
    *,
    env: dict[str, str],
    input_bytes: bytes | None = None,
) -> str:
    """Run one offline Git command inside ``repo`` and return stdout."""
    command = [
        "git",
        "-C",
        str(repo),
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        *args,
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=str(repo),
            env=env,
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise FixtureError(f"could not run Git: {exc}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        raise FixtureError(f"git {' '.join(args)} failed: {stderr}")
    return completed.stdout.decode("utf-8").strip()


def _state_entries(state_name: str) -> list[tuple[str, bytes]]:
    """Read one state tree as ``(relative POSIX path, bytes)`` entries."""
    state_dir = STATES_DIR / state_name
    if not state_dir.is_dir():
        raise FixtureError(f"missing state directory: {state_dir}")

    entries: list[tuple[str, bytes]] = []
    for path in sorted(state_dir.rglob("*")):
        relative_path = path.relative_to(state_dir)
        if (
            any(part in {"__pycache__", ".git"} for part in relative_path.parts)
            or relative_path.suffix in {".pyc", ".pyo"}
        ):
            # Ignore interpreter and repository artifacts even if a local run
            # happened to leave them in the source tree.
            continue
        if path.is_symlink():
            raise FixtureError(f"state {state_name} contains a symlink: {path}")
        if not path.is_file():
            continue
        relative = relative_path.as_posix()
        if relative == ".." or relative.startswith("../"):
            raise FixtureError(f"state {state_name} has an unsafe path: {relative}")
        content = path.read_bytes()
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FixtureError(
                f"state {state_name} file {relative} is not valid UTF-8"
            ) from exc
        entries.append((relative, content))

    present = {relative for relative, _ in entries}
    for required in REQUIRED_FILES:
        if required not in present:
            raise FixtureError(f"state {state_name} is missing {required}")
    entries.sort(key=lambda entry: entry[0])
    return entries


def _write_commit(
    repo: Path,
    state_name: str,
    entries: list[tuple[str, bytes]],
    parent: str | None,
    env: dict[str, str],
    index_path: Path,
) -> str:
    """Write one tree and commit object without touching a working tree."""
    state_env = dict(env)
    state_env["GIT_INDEX_FILE"] = str(index_path)

    _git(repo, ["read-tree", "--empty"], env=state_env)
    for relative, content in entries:
        blob = _git(
            repo,
            ["hash-object", "-w", "--stdin"],
            env=state_env,
            input_bytes=content,
        )
        if not REF_RE.fullmatch(blob):
            raise FixtureError(f"git hash-object returned a bad blob id: {blob!r}")
        _git(
            repo,
            ["update-index", "--add", "--cacheinfo", f"100644,{blob},{relative}"],
            env=state_env,
        )

    tree = _git(repo, ["write-tree"], env=state_env)
    if not REF_RE.fullmatch(tree):
        raise FixtureError(f"git write-tree returned a bad tree id: {tree!r}")

    commit_args = ["commit-tree", tree, "-m", STATE_MESSAGES[state_name]]
    if parent is not None:
        commit_args.extend(["-p", parent])
    commit = _git(repo, commit_args, env=state_env)
    if not REF_RE.fullmatch(commit):
        raise FixtureError(f"git commit-tree returned a bad commit id: {commit!r}")
    return commit


def _chmod_worktree(repo: Path) -> None:
    """Give every checked-out file a stable 0644 mode and directories 0755."""
    for root, directories, files in os.walk(repo):
        root_path = Path(root)
        relative_parts = root_path.relative_to(repo).parts
        if relative_parts and relative_parts[0] == ".git":
            directories[:] = []
            continue
        for name in directories:
            os.chmod(root_path / name, 0o755)
        for name in files:
            os.chmod(root_path / name, 0o644)


def _build_repo(repo: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Create the fixture repository at ``repo`` and return its refs."""
    if repo.exists() and any(repo.iterdir()):
        raise FixtureError(f"output directory is not empty: {repo}")
    repo.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="fixture-home-") as home_name:
        env = _base_env(Path(home_name))
        _git(
            repo,
            ["init", "-q", "--initial-branch=main", "--object-format=sha1"],
            env=env,
        )
        object_format = _git(repo, ["rev-parse", "--show-object-format"], env=env)
        if object_format != "sha1":
            raise FixtureError(
                f"fixture repository uses {object_format!r}, expected 'sha1'"
            )

        hooks_dir = repo / ".git" / "fixture-hooks"
        hooks_dir.mkdir(parents=True, exist_ok=True)
        _git(repo, ["config", "core.hooksPath", ".git/fixture-hooks"], env=env)
        _git(repo, ["config", "core.logAllRefUpdates", "false"], env=env)
        _git(repo, ["config", "user.name", AUTHOR_NAME], env=env)
        _git(repo, ["config", "user.email", AUTHOR_EMAIL], env=env)

        state_refs: dict[str, str] = {}
        with tempfile.TemporaryDirectory(prefix="fixture-index-") as index_dir:
            for state_name in STATE_ORDER:
                entries = _state_entries(state_name)
                parent_name = STATE_PARENTS[state_name]
                parent = state_refs[parent_name] if parent_name is not None else None
                commit = _write_commit(
                    repo,
                    state_name,
                    entries,
                    parent,
                    env,
                    Path(index_dir) / f"index-{state_name}",
                )
                state_refs[state_name] = commit
                _git(
                    repo,
                    ["update-ref", f"refs/heads/state-{state_name}", commit],
                    env=env,
                )

        _git(repo, ["symbolic-ref", "HEAD", "refs/heads/state-a"], env=env)
        _git(repo, ["checkout", "-q", "-f", "state-a"], env=env)
        _chmod_worktree(repo)

        branch_refs: dict[str, str] = {}
        listing = _git(
            repo,
            ["for-each-ref", "--format=%(refname) %(objectname)"],
            env=env,
        )
        for line in listing.splitlines():
            name, _, value = line.partition(" ")
            branch_refs[name] = value

        return state_refs, branch_refs


def _build_in_temp_dir() -> tuple[Path, dict[str, str], dict[str, str]]:
    """Build the repository in a temporary directory the caller must dispose."""
    build_dir = Path(tempfile.mkdtemp(prefix="fixture-repo-"))
    try:
        state_refs, branch_refs = _build_repo(build_dir)
    except BaseException:
        shutil.rmtree(build_dir, ignore_errors=True)
        raise
    return build_dir, state_refs, branch_refs


def _load_recorded_jobs() -> list[dict[str, object]]:
    """Load and shape-check every ``jobs/*/job.json`` file."""
    if not JOBS_DIR.is_dir():
        raise FixtureError(f"missing jobs directory: {JOBS_DIR}")
    job_files = sorted(JOBS_DIR.glob("*/job.json"))
    if not job_files:
        raise FixtureError(f"no job.json files found under {JOBS_DIR}")

    jobs: list[dict[str, object]] = []
    for job_file in job_files:
        try:
            data = json.loads(job_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise FixtureError(f"invalid JSON in {job_file}: {exc}") from exc
        if not isinstance(data, dict):
            raise FixtureError(f"job file is not an object: {job_file}")
        for key in ("id", "from_state", "to_state", "vulnerable_ref", "patched_ref"):
            if key not in data:
                raise FixtureError(f"{job_file} is missing {key}")
        from_state = data["from_state"]
        to_state = data["to_state"]
        if not isinstance(from_state, str) or from_state not in STATE_PARENTS:
            raise FixtureError(
                f"{job_file} names unknown from_state {from_state!r}"
            )
        if not isinstance(to_state, str) or to_state not in STATE_PARENTS:
            raise FixtureError(f"{job_file} names unknown to_state {to_state!r}")
        for key in ("vulnerable_ref", "patched_ref"):
            value = data[key]
            if not isinstance(value, str) or not REF_RE.fullmatch(value):
                raise FixtureError(
                    f"{job_file} has a non-40-hex {key}: {value!r}"
                )
        jobs.append(data)
    return jobs


def _verify() -> int:
    """Build twice in isolated temp dirs and compare refs with job metadata."""
    first_dir, first_states, first_branches = _build_in_temp_dir()
    try:
        second_dir, second_states, second_branches = _build_in_temp_dir()
        try:
            failures: list[str] = []
            if first_states != second_states:
                failures.append(
                    f"state refs differ between builds: {first_states} != {second_states}"
                )
            if first_branches != second_branches:
                failures.append(
                    "branch refs differ between builds: "
                    f"{first_branches} != {second_branches}"
                )

            for job in _load_recorded_jobs():
                job_id = job["id"]
                from_state = job["from_state"]
                to_state = job["to_state"]
                expected_vulnerable = first_states[str(from_state)]
                expected_patched = first_states[str(to_state)]
                if job["vulnerable_ref"] != expected_vulnerable:
                    failures.append(
                        f"{job_id} vulnerable_ref {job['vulnerable_ref']} does not "
                        f"match state {from_state} ({expected_vulnerable})"
                    )
                if job["patched_ref"] != expected_patched:
                    failures.append(
                        f"{job_id} patched_ref {job['patched_ref']} does not "
                        f"match state {to_state} ({expected_patched})"
                    )

            if failures:
                for failure in failures:
                    print(f"FIXTURES_VERIFY: FAIL: {failure}", file=sys.stderr)
                return 1
            print("FIXTURES_VERIFY: PASS")
            return 0
        finally:
            shutil.rmtree(second_dir, ignore_errors=True)
    finally:
        shutil.rmtree(first_dir, ignore_errors=True)


def _print_refs() -> int:
    """Print the deterministic state and branch refs as JSON."""
    build_dir, state_refs, branch_refs = _build_in_temp_dir()
    try:
        print(
            json.dumps(
                {"states": state_refs, "refs": branch_refs},
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


def _publish(build_dir: Path, out_dir: Path) -> None:
    """Move a finished build to its requested destination."""
    if not out_dir.parent.exists():
        raise FixtureError(f"parent directory does not exist: {out_dir.parent}")
    if out_dir.exists():
        if not out_dir.is_dir():
            raise FixtureError(f"output path is not a directory: {out_dir}")
        if any(out_dir.iterdir()):
            raise FixtureError(f"output directory is not empty: {out_dir}")
        out_dir.rmdir()
    shutil.move(str(build_dir), str(out_dir))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build or verify the deterministic Test-Writer M1 fixtures."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--out", type=Path, help="destination for the Git repo")
    mode.add_argument(
        "--verify",
        action="store_true",
        help="build twice and compare refs with jobs/*/job.json",
    )
    mode.add_argument(
        "--print-refs",
        action="store_true",
        help="build in a temporary directory and print the refs",
    )
    args = parser.parse_args(argv)

    try:
        if args.verify:
            return _verify()
        if args.print_refs:
            return _print_refs()
        if args.out is None:
            raise FixtureError("--out requires a destination")

        build_dir, _state_refs, _branch_refs = _build_in_temp_dir()
        try:
            _publish(build_dir, args.out)
        except BaseException:
            shutil.rmtree(build_dir, ignore_errors=True)
            raise
        print(f"FIXTURES_BUILD: PASS ({args.out})")
        return 0
    except (FixtureError, OSError, ValueError) as exc:
        label = "FIXTURES_VERIFY" if args.verify else "FIXTURES_BUILD"
        print(f"{label}: FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
