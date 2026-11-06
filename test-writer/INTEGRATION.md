# Test-Writer / Nyxowl integration contract

This document is the source of truth for how the Test-Writer agent fits the
Nyxowl flow. The runtime is installed separately; this file describes the
contract the code and prompts must satisfy.

**OpenCode v2.2.5 is the only supported host.**

## 1. Actors and order

| Actor | Responsibility |
| --- | --- |
| `nyxowl` (primary) | Checks DNA, prepares the job, dispatches `TW_JOB <id>`, reads the verdict, publishes the `security` entry, verifies, opens the PR. It requests approval but never approves. |
| `nyx-testwriter` | Reads the approved job, writes one pytest file, lints it, submits it to the grader, and finishes with factual notes. It never judges its own work. |
| Owner | Reviews the spec/variants and approves with `tw-approve <id>` in a terminal. |
| `nyx-sec` | Finds the security issue and supplies the finding. |
| `nyx-api` / `nyx-db` (or the owning writer) | Lands the fix on the worktree branch. |
| `nyx-probe` | Handles non-Python runtime QA when the Test-Writer is not applicable. |

Order: find -> fix -> commit -> prepare -> owner approves -> `nyx-testwriter` ->
primary reads status -> `security` entry -> verify -> PR. The subagent is
invoked with exactly `TW_JOB <id>`.

## 2. Tool surface

| Role | Tools |
| --- | --- |
| `nyx-testwriter` | `nyx_testwriter_job`, `nyx_testwriter_write`, `nyx_testwriter_lint`, `nyx_testwriter_gate`, `nyx_testwriter_finish` |
| `nyxowl` | `nyx_testwriter_prepare`, `nyx_testwriter_status` |

The subagent has no host `read`, `edit`, `write`, `shell`/`bash`, or `webfetch`
tool. It sees only the job inputs returned by `nyx_testwriter_job`. The primary
alone reads the terminal verdict and report from `nyx_testwriter_status`; the
subagent summary is not evidence.

## 3. Broker boundary

The Nyxowl MCP server is the only broker. There is no second `tw-tools` MCP
server and no second stdio server.

| Wrapper | Invocation | Runs as |
| --- | --- | --- |
| `tw-status` | `<install>/bin/tw-status <id> [--inputs|--report]` | owner |
| `tw-gate` | `<install>/bin/tw-gate <id> [--lint-only|--finish|--gate N]` | owner |
| `tw-store-job` | `<install>/bin/tw-store-job <id>` (invoked directly by `tw-approve`) | owner |
| `tw-new-job` | `<install>/bin/tw-new-job --json` | owner |
| `tw-approve` | `<install>/bin/tw-approve <id>` | owner |

`<install>` defaults to `$HOME/.nyxowl/test-writer`. Every wrapper runs directly
as the current user; there is no sudoers rule, no password prompt, and no
privilege transition.

The store is `<install>/store` (`0700`, owner-readable). A missing or
non-executable wrapper fails closed with `ERR_TESTWRITER_UNAVAILABLE`; a failed
exec returns `ERR_EXEC_FAILED`. There is no unsandboxed fallback.

## 4. Job inputs contract

`tw-status <id> --inputs` returns the benign job inputs only. Hidden variant
refs, variant tar names, mutant source, and raw output are never included.

```json
{"status": "approved|running", "targetStack": "python", "spec": "...", "interface": "...", "detector": {}, "helperApi": "...", "budget": {}}
```

Nyxowl normalizes this to add `jobId`, `applicable`, and `reason`; `applicable`
is false for closed, unapproved, or non-Python jobs.

`tw-new-job --json` accepts:

```json
{"id": "job-id", "repo": "/abs/worktree", "vulnerable_ref": "<40-hex>", "patched_ref": "<40-hex>", "variants": {"still_vulnerable_ref": "<40-hex>", "fixed_differently_ref": "<40-hex>"}, "module": "pkg.module", "function": "name", "fix_origin": "upstream|reference", "spec_markdown": "...", "python_path": ["src"]}
```

`vulnerable_ref` and `patched_ref` are full 40-character lowercase commit
hashes. `patched_ref` is the fix commit, never the working tree. The optional
`variants` object supplies the two hidden comparison refs; `tw-add-variant`
adds them one at a time when they were omitted. A job without both hidden
variants can be linted and run through gates 1-4 but cannot reach `PROVEN`; gate
5 returns `VARIANT_MISSING`. The spec must contain the six headings
`## Claim`, `## Intended behavior`, `## Rejection behavior`, `## Entry point`,
`## Benign example`, and `## Detector`, plus a `BENIGN:` line.

`tw-new-job --json` reads that JSON body from stdin; it takes no positional
argument for the body. `python_path` may be `[]` when the module sits at the
repository root; the snapshot root is then the import root.

The owner approves by running `tw-approve <id>` in a terminal. It bundles the
four required files (`meta.json`, `manifest.json`, `src-vulnerable.tar`,
`src-patched.tar`), plus both variant tars when present, and passes them
directly to the local `tw-store-job` as the current user; the store verifies
the manifest and installs the job atomically. No password is needed. The
subagent never sees the variant refs or tars.

## 5. Repository-agnostic rules

- `repo` is the active worktree path, never the owner's main checkout.
- `python_path` entries are relative POSIX paths inside the committed snapshot.
- The entry point is `module.function`; the module is resolved against the
  snapshot and `python_path`, not against the live working tree.
- Monorepos use the same contract; `python_path` selects the package root.
- Before prepare, the primary checks project DNA for a Python entry point.
  Non-Python targets are recorded as `nyx-testwriter: NA (non-Python target)`
  and skipped; no job is created.

## 6. Proof vs regression test

The proof test uses pytest's `tmp_path` and prefers the grader-provided
`detector` fixture. The gate accepts a real assertion or `pytest.fail()` on the
vulnerable snapshot even without detector attribution, but the detector remains
the strongest oracle and must not be mocked or bypassed. The proof can run only
inside the grader harness, which supplies the fixture and the
vulnerable/patched snapshots. It is evidence for the `security` Blackboard entry
and the PR.

It must not be copied into the target repository's normal test discovery. The
target's own pytest cannot supply `detector`, so copying it creates a broken or
misleading regression test. A permanent repository regression test is a
separate adaptation task for the owner and primary, written without grader-only
fixtures.

## 7. Blackboard and receipts

The subagent never publishes to the Blackboard. On a terminal verdict the
primary publishes the promoted `security` entry: `status: pass` for PROVEN,
`status: review` for REFUTED/UNPROVEN, and `status: fail` only for a confirmed
security regression. The proof report and staged test are attached as PR
evidence.

No new receipt kind is introduced. The existing PR gate (`verify`, `seam`,
`slop`, `exploit`) is unchanged. The proof test is not a substitute for those
receipts and is not merged into the suite.

## 8. Failure routing

| Outcome / reason | Primary action |
| --- | --- |
| PROVEN | Publish `security` (`pass`), attach `REPORT.md`/staged test, run `nyx_verify_slice` on the normal suite, then PR. All six gates passed. |
| UNPROVEN — `NO_DETECTOR_HIT_ON_VULN` | The vulnerable snapshot passed, so the test observed nothing unsafe. Revise the proof to fail on the vulnerable ref; do not claim proof. |
| REFUTED — `PATCHED_STILL_LEAKS`, `FAIL_ON_PATCHED` | The test failed on the patched snapshot. Treat the fix as incomplete; publish `security` (`review`), route back to `nyx-sec`/the owning writer, and do not mark the slice done. |
| UNPROVEN — `VARIANT_MISSING` | The job lacks the hidden still-vulnerable or fixed-differently snapshot. Add both with `tw-add-variant` and approve a new bundle; do not claim proof. |
| UNPROVEN — `VARIANT_TOO_WEAK` | The test passes on the easier still-vulnerable snapshot; it is too weak. Revise the spec with the owner and open a new job. |
| UNPROVEN — `VARIANT_OVERFIT` | The test only succeeds for one narrow fix; broaden the spec and open a new job. |
| UNPROVEN — `VARIANT_MISLABELED` | The hidden snapshots are byte-identical or otherwise mislabeled. Fix the owner-supplied refs before retrying. |
| UNPROVEN — `FLAKY` | The seed-0 result did not reproduce with hash seeds 1 or 2; do not claim proof. Tighten determinism in a new job. |
| UNPROVEN — `MUTATION_SCORE_LOW` | The test did not distinguish enough AST mutants (score below `0.8`); revise the spec and open a new job. |
| `BUDGET_EXHAUSTED` / `GAVE_UP` | As UNPROVEN: `security` (`review`), record the reason, and retry only with a new job id and owner approval. |
| `CHEAT_CANARY_READ` or `SANDBOX_VIOLATION:<kind>` | Treat as a safety failure; `security` (`review`/`fail`), do not retry with the same test, and escalate to the owner. |
| `SETUP_ERROR_VULN:<kind>` / `SETUP_ERROR_PATCHED:<kind>` | The environment failed, not the fix; keep `security` in `review`, fix the runtime, and open a new job. |
| `LINT:<rule>` within budget | Writer fixes it and resubmits. If the budget ends, route as `BUDGET_EXHAUSTED`. |
| `SPEC_INSUFFICIENT` / `INJECTION_SUSPECTED` | Stop; the primary revises the spec or escalates. Never claim a verdict. |

## 9. Trust boundaries

The subagent sees only the job inputs. It never sees target source bodies,
hidden variants, variant refs or tars, mutant source, raw grader output, or the
canary. The broker sanitizes grader feedback to a fixed key set and drops values
containing canary, variant, mutant, stdout, or stderr markers. The grader
snapshots frozen commit refs; it never evaluates the live working tree.
Uncommitted changes are invisible to the grader.

Gates 2 and 3 use fixed hash seed `0`; gate 4 re-runs both snapshots with fixed
seeds `1` and `2`; gates 5 and 6 use seed `0`. The canary remains per-run
random. Reports expose counts, scores, and survivor IDs only; they never include
variant or mutant source.

The runtime and owner share one OS account. That is deliberate: the owner is
trusted and the LLM is the adversary; the barrier is information asymmetry and
the fixed broker/tool boundary, not store permissions. The store is
owner-readable at `0700`, and the subagent still has no host filesystem tools.

A target snapshot is owner-supplied, not a hostile-target boundary. Before
accepting `PROVEN`, the owner reviews both approved refs for plugin-state access
(`sys.modules["plugin"]` and plugin attributes), writes outside the snapshot at
import/collection, and `os._exit`/`os.abort`, and records the reviewed ref
hashes with the job. Test-only source, plugin, and report forgery is blocked by
lint, the audit hook, the report MAC, and the exit-status check.

The proof test is untrusted quality code, not a hostile-code security boundary.
Gates 2, 4, and 5 accept any real `AssertionError` or pytest `Failed` on the
vulnerable/still-vulnerable snapshot that passes the patched/fixed-differently
snapshot. `detector_seen`, `detector_attributed`, and `detector_calls` are
recorded as evidence only and are never a pass condition: a malicious test that
reads the same interpreter and forges plugin booleans must still produce the
real behavioural differential, pass the hidden variants, and kill mutants. The
owner reviews the proof test and spec. Interpreter introspection is outside the
verdict trust model; a separate-process judge remains future work. The residual
target-collusion risk is the shared interpreter and is not claimed as solved in
M4. A separate-process judge is out of scope for M3/M4 and deferred to M6,
which remains unclaimed.

## 10. Installation

The owner runs the rootless steps in `README_OWNER.md`, then the M1-M4
acceptance commands. `install-user.sh` installs `bin/`, `gate/`, `grader/`
(including the harness), `agent/`, and the docs into
`$HOME/.nyxowl/test-writer` and creates `<install>/store` with mode `0700`.
`build-user-venv.sh` creates `<install>/venv` and installs the hashed lock. No
step uses root, sudo, users/groups, `/opt`, or `/var/lib`.

M3 and M4 are complete. The `nyx-testwriter` agent
and its seven `nyx_testwriter_*` tools are registered in Nyxowl, and gates 1-6
are usable. Only M5-M7, including M6 host-isolation verification, remain before
host readiness.
