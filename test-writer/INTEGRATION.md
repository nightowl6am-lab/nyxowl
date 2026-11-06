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
| `tw-status` | `/usr/bin/sudo -n -u tw-grader /opt/test-writer/bin/tw-status <id> [--inputs|--report]` | `tw-grader` |
| `tw-gate` | `/usr/bin/sudo -n -u tw-grader /opt/test-writer/bin/tw-gate <id> [--lint-only|--finish]` | `tw-grader` |
| `tw-new-job` | `/opt/test-writer/bin/tw-new-job --json` | owner |

The grader store is `/var/lib/test-writer` (`0700`, owned by `tw-grader`). A
missing or non-executable wrapper fails closed with
`ERR_TESTWRITER_UNAVAILABLE`; a sudoers denial or failed exec returns
`ERR_EXEC_FAILED`. There is no unsandboxed fallback.

## 4. Job inputs contract

`tw-status <id> --inputs` returns:

```json
{"status": "approved|running", "targetStack": "python", "spec": "...", "interface": "...", "detector": {}, "helperApi": "...", "budget": {}}
```

Nyxowl normalizes this to add `jobId`, `applicable`, and `reason`; `applicable`
is false for closed, unapproved, or non-Python jobs.

`tw-new-job --json` accepts:

```json
{"id": "job-id", "repo": "/abs/worktree", "vulnerable_ref": "<40-hex>", "patched_ref": "<40-hex>", "module": "pkg.module", "function": "name", "fix_origin": "upstream|reference", "spec_markdown": "...", "python_path": ["src"]}
```

`vulnerable_ref` and `patched_ref` are full 40-character lowercase commit
hashes. `patched_ref` is the fix commit, never the working tree. The spec must
contain the six headings `## Claim`, `## Intended behavior`,
`## Rejection behavior`, `## Entry point`, `## Benign example`, and
`## Detector`, plus a `BENIGN:` line.

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

The proof test uses pytest's `tmp_path` and the grader-provided `detector`
fixture. It can run only inside the grader harness, which supplies the fixture
and the vulnerable/patched snapshots. It is evidence for the `security`
Blackboard entry and the PR.

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
| PROVEN | Publish `security` (`pass`), attach `REPORT.md`/staged test, run `nyx_verify_slice` on the normal suite, then PR. |
| REFUTED — `NO_FAIL_ON_VULN`, `NO_DETECTOR_HIT_ON_VULN`, `PATCHED_STILL_LEAKS`, `FAIL_ON_PATCHED`, `VARIANT_MISLABELED` | Treat the fix as incomplete; publish `security` (`review`), route back to `nyx-sec`/the owning writer, and do not mark the slice done. |
| UNPROVEN — `VARIANT_TOO_WEAK` | The test is too weak; revise the spec with the owner and open a new job. |
| UNPROVEN — `VARIANT_OVERFIT` | The test is too narrow; broaden the spec and open a new job. |
| UNPROVEN — `FLAKY` | Do not claim proof; tighten determinism in a new job. |
| UNPROVEN — `MUTATION_SCORE_LOW` | The test does not distinguish behaviour; revise the spec and open a new job. |
| `BUDGET_EXHAUSTED` / `GAVE_UP` | As UNPROVEN: `security` (`review`), record the reason, and retry only with a new job id and owner approval. |
| `CHEAT_CANARY_READ` or `SANDBOX_VIOLATION:<kind>` | Treat as a safety failure; `security` (`review`/`fail`), do not retry with the same test, and escalate to the owner. |
| `SETUP_ERROR_VULN:<kind>` / `SETUP_ERROR_PATCHED:<kind>` | The environment failed, not the fix; keep `security` in `review`, fix the runtime, and open a new job. |
| `LINT:<rule>` within budget | Writer fixes it and resubmits. If the budget ends, route as `BUDGET_EXHAUSTED`. |
| `SPEC_INSUFFICIENT` / `INJECTION_SUSPECTED` | Stop; the primary revises the spec or escalates. Never claim a verdict. |

## 9. Trust boundaries

The subagent sees only the job inputs. It never sees target source bodies,
variants, mutants, raw grader output, or the canary. The broker sanitizes grader
feedback to a fixed key set and drops values containing canary, variant, mutant,
stdout, or stderr markers. The grader snapshots frozen commit refs; it never
evaluates the live working tree. Uncommitted changes are invisible to the
grader.

## 10. Installation

The owner runs the M0 root/bootstrap steps in `README_OWNER.md`. The intended
sudoers rule grants `NOPASSWD` for `gate`, `status`, and `recheck`, and requires
a password for `store-job` (used to create a job). The M0 draft still shows
legacy wrapper names and must be reconciled before M3 acceptance; do not install
it as-is.

The `nyx-testwriter` agent and its seven `nyx_testwriter_*` tools are registered
in Nyxowl now. The runtime is not usable until M1-M3 install the wrappers,
grader, and store. Host-isolation verification remains an M6 item.
