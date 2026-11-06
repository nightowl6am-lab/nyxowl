# Test-Writer owner guide

This document is for the repository owner. It uses plain language and lists the
only steps that require root. Nothing in this directory runs those steps for you.

## What the subagent will do

The Test-Writer subagent writes a proof test for a behaviour the primary has prepared and the owner has approved.
It runs inside a bubblewrap sandbox with no network, no host environment, no
home directory, no access to the production store, and hard limits on CPU,
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
   draft under `~/tw-jobs/<id>/` without touching the grader store.
2. You review the draft in `~/tw-jobs/<id>/`: `meta.json`, `manifest.json`, and
   the two commit snapshot tars.
3. In a terminal, run `tw-approve <id>` and enter your sudo password. Approval
   bundles exactly those four files and hands them to the grader-side
   `tw-store-job`, which verifies the hashes and installs the job atomically.
4. The primary dispatches the subagent with exactly `TW_JOB <id>`.
5. Read the terminal status with `nyx_testwriter_status`; the subagent's own
   summary is not evidence.
6. A `PROVEN` proof test is evidence for the `security` entry and the PR. It is
   not a target regression test and must not be copied into the target's normal
   test discovery; it depends on the grader-only `detector` fixture.

## Current status

- M0 through M3 are complete; the owner installation and acceptance steps ran on
  2026-11-06.
- M4 through M7 are pending.
- The runtime is usable for gates 1-3 today: lint, the vulnerable snapshot, and
  the patched snapshot.
- Host-isolation verification is still the M6 item and is not claimed here.
- M1 through M3 changed no dependencies, no receipt kind, and no TypeScript
  surface.

## Owner steps, in order

### 1. Enter the source directory

After this branch is merged:

```bash
cd /home/ocagent/work/nyxowl/nyxowl/test-writer
```

Until then, use the worktree:

```bash
cd /home/ocagent/work/nyxowl/worktrees/nyxowl-test-writer-m1-m3/test-writer
```

### 2. Create the service account and install the runtime tree

```bash
sudo bash bootstrap/install-root.sh
```

This creates the `tw-grader` group and user, `/opt/test-writer`, and
`/var/lib/test-writer`. It installs `bin/`, `gate/`, `grader/` (including the
harness), `/agent/`, and docs such as `HELPER_API.md` as root-owned files. It
does not touch the venv, write into the store, install sudoers, or start a
service. The script prints `ROOT_INSTALL: PASS` when it succeeds.

### 3. Review and install the sudoers draft

First read the draft and replace `<owner>` with your account name:

```bash
less bootstrap/sudoers.test-writer.draft
```

Then install it with the editor that validates sudoers syntax:

```bash
sudo visudo -f /etc/sudoers.d/test-writer
```

Do not copy the file into place with `cp`; `visudo` is what checks the syntax.

The final split is deliberate: `tw-gate` and `tw-status` are `NOPASSWD` because
the broker calls them non-interactively; `tw-store-job` requires your password
with no cached timestamp; `tw-new-job` and `tw-approve` run as you and are not
sudoers entries.

### 4. Build the runtime venv

```bash
sudo bash bootstrap/build-runtime-venv.sh
```

This creates `/opt/test-writer/requirements.lock` with hashes, creates
`/opt/test-writer/venv`, and installs the pinned packages. It prints
`RUNTIME_VENV: PASS` and the top-level versions. It does not touch the store or
sudoers.

### 5. Run the M0 and M1-M3 self-tests as the owner

From the source directory:

```bash
python3 selftests/run_all.py
```

The final lines must be:

```
M0_SELFTESTS: PASS
M1M3_SELFTESTS: PASS
```

These tests run rootless as your normal account and write only to a temporary
directory. If `/usr/bin/bwrap` or `/opt/test-writer/venv/bin/python` is missing,
the sandbox cases skip with an explicit message; that is not a pass.

### 6. Run the M0 acceptance probes as tw-grader

Stage the probes where `tw-grader` can read them:

```bash
sudo install -d -o tw-grader -g tw-grader -m 0755 /var/lib/test-writer/m0-probes
sudo cp selftests/probes/*.py /var/lib/test-writer/m0-probes/
```

Run the environment probe:

```bash
sudo -u tw-grader python3 /opt/test-writer/grader/sandbox_run.py <<'JSON'
{"mode":"probe","probe":"/var/lib/test-writer/m0-probes/env_probe.py","limits":{"wall_seconds":30}}
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

## M3 acceptance

Run both commands from the source directory; they are rootless and use temporary
directories:

```bash
python3 fixtures/build_fixtures.py --verify
python3 selftests/run_all.py
```

Expected final lines:

```
FIXTURES_VERIFY: PASS
M0_SELFTESTS: PASS
M1M3_SELFTESTS: PASS
```

`run_all.py` must also report `OK` with all 152 tests passing. The deterministic
fixture verdicts are:

- J1 — `PROVEN`.
- J2 — `UNPROVEN` with `NO_DETECTOR_HIT_ON_VULN`.
- J3 — `REFUTED`.
- J4 — `PROVEN`.

The same run covers the red-team cases and the lint/finish/busy/closed/budget
refusals. A missing bubblewrap or runtime venv skips the sandbox cases and is
not an acceptance pass.

### Owner review before accepting PROVEN

The two approved refs are owner-supplied inputs, not a hostile-target boundary.
Before accepting a `PROVEN` verdict, review both refs (vulnerable and patched)
and confirm that no reachable module:

- touches `sys.modules["plugin"]` or any plugin attribute;
- writes outside the snapshot during import or collection;
- calls `os._exit` or `os.abort`.

Record the reviewed ref hashes with the job. This target-collusion residual is
an M3 limitation: the harness and the target share one interpreter, so a
malicious snapshot could forge harness state. A separate-process judge that
would remove this residual is out of scope for M3 and belongs to M6, which is
not claimed here.

## Rollback

Only run this if you want to remove the installation. It deletes the store and
the runtime tree, so any job data in `/var/lib/test-writer` is lost.

```bash
sudo rm -f /etc/sudoers.d/test-writer
sudo rm -rf /opt/test-writer
sudo rm -rf /var/lib/test-writer
sudo userdel tw-grader
sudo groupdel tw-grader
```

Removing the source directory or the branch is a normal repository operation and
is handled separately.

## What is never done automatically

The repository and the agent never:

- run `sudo` or ask for a password;
- create or delete users and groups;
- write or install a sudoers file;
- install packages or reach the network;
- merge the branch;
- delete `/opt/test-writer` or `/var/lib/test-writer`.

Those actions are owner-only and are listed above.
