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

## Using it from Nyxowl

1. `nyxowl` checks the project DNA for a Python entry point. If the target is
   not Python, it records `nyx-testwriter: NA (non-Python target)` and skips the
   job.
2. `nyxowl` prepares the job with `nyx_testwriter_prepare` using the worktree,
   the vulnerable and patched 40-hex commit hashes, the `module.function` entry
   point, and a six-section spec.
3. You review the spec and variants, then run `tw-approve <id>` in a terminal.
   The primary cannot approve the job or read its variants.
4. `nyxowl` dispatches `nyx-testwriter` with exactly `TW_JOB <id>`, then reads
   the terminal verdict and flags from `nyx_testwriter_status`. The subagent's
   own summary is not evidence.
5. On `PROVEN`, the proof test and `REPORT.md` are attached as evidence for the
   promoted `security` Blackboard entry and the PR. The proof is not a normal
   regression test and is not added to the target's test discovery; it depends
   on the grader-only `detector` fixture.

## Current status

- M0 source is complete in this directory.
- The root install, sudoers review, runtime venv, and tw-grader acceptance run
  are still pending. They are listed in `PLAN_STATUS.md` as PENDING.
- M1 through M7 runtime work has not started.
- The `nyx-testwriter` agent and its seven `nyx_testwriter_*` tools are now
  registered in Nyxowl. The runtime is not usable until the owner steps below
  and M1-M3 are complete; host isolation is verified in M6.

## Owner steps, in order

### 1. Enter the source directory

After this branch is merged:

```bash
cd /home/ocagent/work/nyxowl/nyxowl/test-writer
```

Until then, use the worktree:

```bash
cd /home/ocagent/work/nyxowl/worktrees/nyxowl-test-writer-m0/test-writer
```

### 2. Create the service account and install the runtime tree

```bash
sudo bash bootstrap/install-root.sh
```

This creates the `tw-grader` group and user, `/opt/test-writer`, and
`/var/lib/test-writer`. It does not write sudoers, does not build a venv, and
does not start a service. The script prints `ROOT_INSTALL: PASS` when it
succeeds.

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

### 4. Build the runtime venv

```bash
sudo bash bootstrap/build-runtime-venv.sh
```

This creates `/opt/test-writer/requirements.lock` with hashes, creates
`/opt/test-writer/venv`, and installs the pinned packages. It prints
`RUNTIME_VENV: PASS` and the top-level versions. It does not touch the store or
sudoers.

### 5. Run the M0 self-tests as the owner

From the source directory:

```bash
python3 selftests/run_all.py
```

The final line must be:

```
M0_SELFTESTS: PASS
```

These tests run rootless as your normal account and write only to a temporary
directory. If `/usr/bin/bwrap` is missing they skip with an explicit message;
that is not a pass.

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
