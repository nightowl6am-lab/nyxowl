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

- M0 through M7 are complete in source. The live OpenCode host-isolation
  transcript for M6 passed on attempt 2 per `qa/EVIDENCE-M6.md`. M7-lite landed
  in PR A; full M7 (23-case matrix, red-team proofs, and the real-repository
  dogfood) landed in PR D.
- The runtime runs gates 1-6: lint, the vulnerable snapshot, the patched
  snapshot, flake re-runs, the hidden variants, and AST mutation scoring.
- Every terminal run now writes `test.py`, a canonical `proof.json`, an
  append-only `chain.log`, and an owner-facing `REPORT.md`. `tw-recheck <id>`
  replays the proof read-only and exits `0` only on a recomputed match.
- `PROVEN` requires all six gates. Fixed seeds are used for the vulnerable,
  patched, flake, variant, and mutation runs; canaries remain per-run random.
- The runtime is installed in the owner's home and runs as the owner. There is
  no separate grader OS user. The store is owner-readable at mode `0700`.
- M6 adds the advisory finish record (`finish.json` plus `advisoryFlags` in
  `tw-status`), the model-free three-run fixture matrix, the parent stdio MCP
  end-to-end test, and deny-by-default OpenCode permissions for the subagent.
  The live OpenCode host-isolation transcript passed on attempt 2 per
  `qa/EVIDENCE-M6.md`.
- M7-lite adds seven eval cases, a model-free eval runner, and a real-use
  dogfood runner. Full M7 adds the 23-case matrix, eight red-team proofs, and
  the real-repository dogfood. Evidence is `qa/EVIDENCE-M7.md`.
- M1 through M6 changed no dependencies, no receipt kind, and no TypeScript
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

### 1. Install the runtime (normal path)

The normal path is the Nyxowl CLI. The first `nyxowl` run installs the rootless
runtime under `$HOME/.nyxowl/test-writer` (or `$NYXOWL_HOME/test-writer`). To
install, repair, or inspect it explicitly:

```bash
nyxowl testwriter install
nyxowl testwriter status
```

The CLI runs `bootstrap/install-user.sh` and then
`bootstrap/build-user-venv.sh` as your user. The first copies `bin/`, `gate/`,
`grader/` (including the harness), `agent/`, and the docs into the install root
and creates the store at `<install root>/store` with mode `0700`. The second
creates `<install root>/venv` and installs `requirements.lock` with
`--require-hashes` when present, otherwise `requirements.in`. No root, sudo,
service account, or privilege transition is used, and no extra commands are
needed after `npm install -g nyxowl`.

For source checkouts, the bootstrap scripts remain available for internal use
and recovery:

```bash
cd /path/to/nyxowl/test-writer
bash bootstrap/install-user.sh
bash bootstrap/build-user-venv.sh
```

They are not the normal install path; prefer `nyxowl testwriter install`.

### 2. Run the M0 and M1-M5 self-tests as the owner

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

### 3. Run the M0 acceptance probes as your user

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

## M5 acceptance

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

`run_all.py` must also report `OK` with all 228 tests passing. The deterministic
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

The M5 cases require every terminal job to carry `test.py`, `proof.json`, and
`chain.log`, and `REPORT.md` to expose the same limits block as `report.md`
without target or test source. They also require `tw-recheck <id>` to reproduce
the recorded J1 (`PROVEN`) and J2 (`UNPROVEN`/`NO_DETECTOR_HIT_ON_VULN`) evidence
and to fail closed on proof, runtime, frozen-input, and chain tampering.

### M6 acceptance

Run these from the repository root. They use temporary install, store,
workspace, and scratch roots only; they do not touch `$HOME/.nyxowl/test-writer`
or `$HOME/tw-jobs`.

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 test-writer/qa/m6_threerun.py --out /tmp/opencode/m6-runs
node test-writer/qa/m6_parent_e2e.mjs
```

Expected final lines:

```
M6_THREERUN: PASS
M6_PARENT_E2E: PASS
```

`m6_threerun.py` builds the fixtures once, installs this worktree once into a
temporary install root, and performs three independent rounds. It requires J1
`PROVEN` 3/3, J2 `UNPROVEN`/`NO_DETECTOR_HIT_ON_VULN` 3/3, J3 never `PROVEN`
(`REFUTED` expected) 3/3, J4 `PROVEN` 3/3, and a successful `tw-recheck` for
every PROVEN job. The J4 `INJECTION_SUSPECTED` advisory is scripted plumbing
evidence, not a model judgment.

`m6_parent_e2e.mjs` starts this worktree's `dist/cli/bin.js mcp` over stdio and
drives prepare, both `tw-add-variant` calls, approve, job read, write, lint,
gate, finish, and status. It asserts 39 tools, exactly seven Test-Writer tools,
exactly five subagent tools, no variant refs/tars/store paths in the job
response, a PROVEN report with `## Limits`, and the error paths.

The OpenCode host-isolation transcript is a manual verifier step and is not run
by either script; it passed on attempt 2 per `qa/EVIDENCE-M6.md`.

### M7-lite acceptance

These commands are rootless and offline. They use temporary roots only.

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 test-writer/qa/m7_lite_eval.py --out /tmp/opencode/m7-lite-eval --rounds 3
node test-writer/qa/m7_dogfood.mjs
```

Expected final lines:

```
M7_LITE_EVAL: PASS
PR_A_DOGFOOD: PASS
```

The eval matrix covers five expected `PROVEN` cases, one
`UNPROVEN`/`NO_DETECTOR_HIT_ON_VULN` control, and one
`REFUTED`/`PATCHED_STILL_LEAKS` control. It fails closed on any false `PROVEN`,
any expected-`PROVEN` miss, or any failed `tw-recheck`. The dogfood runner drives
the real stdio MCP server against a temporary Git repository, runs the real
`npm run test` script, and verifies four receipts at the local PR gate. Missing
`dist`, bubblewrap, or the runtime venv skips with exit `2`.

### Full M7 acceptance

These commands are rootless and offline. They use temporary roots only. The
matrix is model-free; `model_tokens` is a hard zero.

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 test-writer/qa/m7_full_eval.py --rounds 3 \
  --out /tmp/opencode/m7-full-eval
node test-writer/qa/m7_real_dogfood.mjs
```

Expected final lines:

```
M7_FULL_EVAL: PASS
SLICE5_DOGFOOD: PASS (target=private-production-repo; test=pnpm run test)
```

The full matrix covers 10 expected `PROVEN` cases, 5 negatives with the exact
expected `(verdict, reason)` (`n1`/`n3` `UNPROVEN`/`NO_DETECTOR_HIT_ON_VULN`;
`n2`/`n4`/`n5` `REFUTED`/`PATCHED_STILL_LEAKS`), and 8 red-team proofs that must
stay non-`PROVEN`. It fails closed on any false `PROVEN`, any negative
verdict/reason mismatch, any expected-`PROVEN` miss, or any failed `tw-recheck`.
The real-repository dogfood clones a tracked-only `private-production-repo`, commits a
real Vitest smoke test in an external worktree, runs the repo's real
`pnpm run test` from DNA, and requires GREEN verify/seam/slop/exploit receipts
plus a four-receipt local PR. It never reads `.env`, never installs, and never
uses `commandsOverride`.

### Recheck contract

`tw-recheck <id>` re-verifies a closed job without trusting the stored verdict.
It checks the `proof.json` self-hash, the effective runtime hashes, the frozen
input hashes (`meta.json`, `manifest.json`, both source tars, optional variant
tars, and `test.py`), the append-only `chain.log`, and the stored state. It then
re-runs the full gate pipeline on the staged test and compares verdict, reason,
flags, gates, the vulnerable/patched/violations count blocks, mutation
score/counts/survivors, variant statuses, and flake runs.
It writes nothing except one appended `chain.log` entry, and only after a
successful match or a post-run mismatch.

Exit codes: `0` means the recomputed evidence matches; `1` means a mismatch or a
fail-closed refusal (`HASH_MISMATCH`, `CHAIN_BROKEN`, `PROOF_MISSING`,
`STATE_MISMATCH`, `NO_FROZEN_TEST`, `JOB_NOT_CLOSED`, `JOB_INVALID`, `BUSY`);
`2` is a usage error. A missing runtime or venv exits `78` with
`RUNTIME_UNAVAILABLE`.

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
would remove this residual remains future work; it is not part of M6 and is not
claimed here.

## Wrapper commands

The installed wrappers run as your user. Use the install root explicitly if
`$HOME/.nyxowl/test-writer/bin` is not on `PATH`:

```bash
"$HOME/.nyxowl/test-writer/bin/tw-new-job" --json
"$HOME/.nyxowl/test-writer/bin/tw-add-variant" <id> --kind still_vulnerable|fixed_differently --ref <40-hex>
"$HOME/.nyxowl/test-writer/bin/tw-approve" <id>
"$HOME/.nyxowl/test-writer/bin/tw-status" <id> [--inputs|--report]
"$HOME/.nyxowl/test-writer/bin/tw-gate" <id> [--lint-only|--finish|--gate N]
"$HOME/.nyxowl/test-writer/bin/tw-recheck" <id>
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
