# Test-Writer owner guide

This document is for the repository owner. It uses plain language and lists the
rootless installation steps. Nothing in this directory requires root, sudo, a
service account, `/opt/test-writer`, or `/var/lib/test-writer`.

## What the subagent will do

The Test-Writer subagent writes a proof test for a behaviour the primary has prepared and the owner has approved.
It runs inside a bubblewrap sandbox with no network, no host environment, no
home directory, no access to the private store, and hard limits on CPU,
memory, processes, file size, and output.

The grader turns the result into one of three verdicts:

- **PROVEN** — the test fails for the intended reason, consistently, and the
  evidence is strong enough to rely on.
- **UNPROVEN** — the evidence is missing or too weak to decide.
- **REFUTED** — the test does not demonstrate the claimed behaviour, or the
  evidence shows the claim is wrong.

Flags such as `CHEAT_ATTEMPT` are reported separately; they do not change the
verdict wording. Flakiness is a reason code (`FLAKY`), not a flag.

## First approved job

1. `nyxowl` checks the project DNA for a Python entry point; non-Python targets
   are recorded as `nyx-testwriter: NA (non-Python target)` and skipped. For a
   Python target it prepares the job with `nyx_testwriter_prepare`, creating a
   draft under `~/tw-jobs/<id>/` without touching the private store.
2. You review the draft in `~/tw-jobs/<id>/`: `meta.json`, `manifest.json`, and
   the commit snapshot tars. A complete draft has six files: the vulnerable and
   patched snapshots plus `src-still-vulnerable.tar` and
   `src-fixed-differently.tar`. The two hidden variant snapshots are required
   before the grader can return `PROVEN`; they are never shown to the subagent.
3. If the draft has only four files, add each hidden variant with
   `tw-add-variant <id> --kind still_vulnerable --ref <40-hex>` and
   `tw-add-variant <id> --kind fixed_differently --ref <40-hex>`. The owner
   supplies the refs; the subagent never sees them.
4. In a terminal, run `tw-approve <id>` as your normal user. No password is
   needed. Approval bundles the four required files, plus both variant tars
   when present, and hands them directly to the local `tw-store-job`, which
   verifies the hashes and installs the job atomically.
5. The primary dispatches the subagent with exactly `TW_JOB <id>`.
6. Read the terminal status with `nyx_testwriter_status`; the subagent's own
   summary is not evidence.
7. A `PROVEN` proof test is evidence for the `security` entry and the PR. It is
   not a target regression test and must not be copied into the target's normal
   test discovery; it depends on the grader-only `detector` fixture.

## Current status

- M0 through M4 are complete. M5 through M7 are pending.
- The runtime runs gates 1-6: lint, the vulnerable snapshot, the patched
  snapshot, flake re-runs, the hidden variants, and AST mutation scoring.
- `PROVEN` requires all six gates. Fixed seeds are used for the vulnerable,
  patched, flake, variant, and mutation runs; canaries remain per-run random.
- The runtime is installed in the owner's home and runs as the owner. There is
  no separate grader OS user. The store is owner-readable at mode `0700`.
- Host-isolation verification is still the M6 item and is not claimed here.
- M1 through M4 changed no dependencies, no receipt kind, and no TypeScript
  surface.

## Runtime paths

| Purpose | Default | Override |
| --- | --- | --- |
| Install root | `$HOME/.nyxowl/test-writer` | `TW_INSTALL_ROOT` |
| Store | `<install root>/store` (`0700`) | `TW_STORE_ROOT` |
| Workspace/drafts | `$HOME/tw-jobs` | `TW_WORKSPACE_ROOT` |
| Sandbox scratch | `<store>/tmp` | `TW_TMP_ROOT` |
| Sandbox interpreter | `<install root>/venv/bin/python` | `TW_VENV_PYTHON` |

All paths are resolved at runtime, so environment overrides may be exported after
the Python modules are imported.

## Owner steps, in order

### 1. Enter the source directory

After this branch is merged:

```bash
cd /home/ocagent/work/nyxowl/nyxowl/test-writer
```

Until then, use the worktree:

```bash
cd /home/ocagent/work/nyxowl/worktrees/nyxowl-test-writer-rootless/test-writer
```

### 2. Install the runtime tree as your user

```bash
bash bootstrap/install-user.sh
```

This copies `bin/`, `gate/`, `grader/` (including the harness), `agent/`, and the
docs into `$HOME/.nyxowl/test-writer`. It creates the store at
`$HOME/.nyxowl/test-writer/store` with mode `0700`. It does not create users or
groups, does not build the venv, and does not write outside the install root and
store. The script prints `USER_INSTALL: PASS` when it succeeds.

### 3. Build the runtime venv

```bash
bash bootstrap/build-user-venv.sh
```

This creates `<install root>/venv` and installs `requirements.lock` with
`--require-hashes` when that file is present, otherwise `requirements.in`. It
prints `USER_VENV: PASS`. No privilege transition is used.

### 4. Run the M0 and M1-M4 self-tests as the owner

From the source directory:

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 selftests/run_all.py
```

The final lines must be:

```
M0_SELFTESTS: PASS
M1M3_SELFTESTS: PASS
```

These tests write only to isolated temporary roots. If `/usr/bin/bwrap` or the
resolved venv interpreter is missing, the sandbox cases skip with an explicit
message; that is not a pass.

### 5. Run the M0 acceptance probes as your user

The probes can run as the current user; no staging under a system directory is
needed. Export the probe root so the launcher accepts the absolute path:

```bash
export TW_INSTALL_ROOT="$HOME/.nyxowl/test-writer"
export TW_PROBE_ROOT="$PWD/selftests/probes"

python3 "$TW_INSTALL_ROOT/grader/sandbox_run.py" <<JSON
{"mode":"probe","probe":"$TW_PROBE_ROOT/env_probe.py","limits":{"wall_seconds":30}}
JSON
```

Expected inside the escaped `stdout` string: `"fake_secret": null`,
`"home_exists": false`, `"store_exists": false`, `"write": "OSError"`, and
`"if_nameindex": [[1, "lo"]]`.

Run the remaining probes the same way, changing only the `probe` name and the
`limits` object:

| Probe | Limits |
| --- | --- |
| `network_probe.py` | `{"wall_seconds":10}` |
| `cpu_probe.py` | `{"cpu_seconds":1,"wall_seconds":4}` |
| `memory_probe.py` | `{"memory_mb":64,"cpu_seconds":5,"wall_seconds":6}` |
| `fork_probe.py` | `{"max_pids":32,"wall_seconds":6}` |
| `file_probe.py` | `{"max_file_mb":4}` |
| `output_probe.py` | `{"max_output_kb":64}` |

Expected results:

- `network_probe.py` — `stdout` contains `NETWORK_FAIL`.
- `cpu_probe.py` — `"limit_hit": "cpu"`.
- `memory_probe.py` — `"limit_hit": "memory"`.
- `fork_probe.py` — `stdout` contains `FORK_FAIL` and `EAGAIN`, and
  `"limit_hit": "pids"`.
- `file_probe.py` — `"limit_hit": "file_size"`.
- `output_probe.py` — `"stdout_truncated": true` and
  `"limit_hit": "output"`.

Every result must also have `"ok": true` and a `"bwrap_version"` string.

## M4 acceptance

Run both commands from the source directory; they are rootless and use temporary
directories:

```bash
python3 fixtures/build_fixtures.py --verify
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 selftests/run_all.py
```

Expected final lines:

```
FIXTURES_VERIFY: PASS
M0_SELFTESTS: PASS
M1M3_SELFTESTS: PASS
```

`run_all.py` must also report `OK` with all 203 tests passing. The deterministic
fixture verdicts are:

- J1 — `PROVEN`, with flake, variants, and mutation all passing.
- J2 — `UNPROVEN` with `NO_DETECTOR_HIT_ON_VULN`.
- J3 — `REFUTED` (never `PROVEN`).
- J4 — `PROVEN`, with flake, variants, and mutation all passing.

The M4 cases also require `FLAKY`, `VARIANT_MISSING`, `VARIANT_TOO_WEAK`, and
`VARIANT_OVERFIT` routing, and the fixture mutation scores must be at least
`0.8`. The same run covers the red-team cases and the lint/finish/busy/closed/
budget refusals. A missing bubblewrap or runtime venv skips the sandbox cases
and is not an acceptance pass.

### Owner review before accepting PROVEN

The two approved refs are owner-supplied inputs, not a hostile-target boundary.
Before accepting a `PROVEN` verdict, review both refs (vulnerable and patched)
and confirm that no reachable module:

- touches `sys.modules["plugin"]` or any plugin attribute;
- writes outside the snapshot during import or collection;
- calls `os._exit` or `os.abort`.

Record the reviewed ref hashes with the job. This target-collusion residual is
an M3/M4 limitation: the harness and the target share one interpreter, so a
malicious snapshot could forge harness state. A separate-process judge that
would remove this residual is out of scope for M3/M4 and belongs to M6, which
is not claimed here.

## Wrapper commands

The installed wrappers run as your user. Use the install root explicitly if
`$HOME/.nyxowl/test-writer/bin` is not on `PATH`:

```bash
"$HOME/.nyxowl/test-writer/bin/tw-new-job" --json
"$HOME/.nyxowl/test-writer/bin/tw-add-variant" <id> --kind still_vulnerable|fixed_differently --ref <40-hex>
"$HOME/.nyxowl/test-writer/bin/tw-approve" <id>
"$HOME/.nyxowl/test-writer/bin/tw-status" <id> [--inputs|--report]
"$HOME/.nyxowl/test-writer/bin/tw-gate" <id> [--lint-only|--finish|--gate N]
```

`--gate 1` runs lint only. `--gate 2` through `--gate 6` run the full six-gate
pipeline; the number is the highest gate the caller is asking the runtime to
make available. `--gate 7` and above return `GATE_UNAVAILABLE`.

## Rollback

Only run this if you want to remove the installation. It deletes the store and
the runtime tree, so any job data below `$HOME/.nyxowl/test-writer/store` is
lost.

```bash
rm -rf "$HOME/.nyxowl/test-writer" "$HOME/tw-jobs"
```

Removing the source directory or the branch is a normal repository operation and
is handled separately.

## What is never done automatically

The repository and the agent never:

- request root or use a privilege transition;
- create or delete users and groups;
- write `/etc/sudoers.d` or any system configuration;
- install into `/opt` or `/var/lib`;
- install packages or reach the network;
- merge the branch.
