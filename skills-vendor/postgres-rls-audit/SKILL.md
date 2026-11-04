---
name: postgres-rls-audit
description: >-
  Deterministic static audit of PostgreSQL/Supabase SQL for Row Level Security
  vulnerabilities: RLS not enabled, missing or tautological policies, privilege
  escalation, anonymous write paths, search_path hijacking in SECURITY DEFINER
  functions, and views that bypass RLS. Use whenever creating, modifying, or
  reviewing SQL migrations, schema files, Supabase policies, grants, or RLS
  rules — and on any task claiming to verify tenant/data isolation. REPORT ONLY:
  never apply its suggested fixes automatically.
metadata:
  version: "2.0.0-reos"
  project: real-estate-os
---

# PostgreSQL & Supabase RLS Security Audit

Static, read-only, deterministic analysis of `.sql` files. It models tables, RLS
flags, policies, grants, roles, extensions, and functions, then reports findings
with file, line, severity, and a suggested fix.

## Why this skill exists here

The `security` skill's own scanner does **not** support `.sql` — across the Phase 2
batch 1 review it scanned 2 of 25 files and reported `files_skipped: 23`. Every
behavioural claim about RLS in that batch had to be verified by hand against a
running database.

This tool closes that gap. On the 13 batch-1 migrations it parses 13/13 files with
0 unparsed statements, where the `security` scanner saw none of them.

**It does not replace the pgTAP suite.** The pgTAP tests in `supabase/tests/` are
the behavioural control; this is a static second opinion that runs before them.

---

## CRITICAL: report only, never auto-remediate

**Never apply a `fix` string from this tool's output, and never re-run it in a loop
trying to drive the exit code to `0`.**

This is not a style linter. Its suggestions are generic PostgreSQL advice written
without knowledge of this project's schema, and several of them are actively wrong
here. An automated fix loop on RLS code will rewrite security policy to satisfy a
linter. A real example: this tool reports `POL001` (always-true read policy) on
`roles`, `permissions`, and `role_permissions`, and suggests replacing the predicate
with `(select auth.uid()) = user_id`. Those three tables are **global reference
data with no owner column**. Applying that "fix" makes the entire role and
permission catalogue readable only by a row's own owner, which does not exist —
it breaks the authorization spine for every user in every agency.

Procedure:

1. Run the audit with `--json`. It is read-only and safe.
2. Report every finding to the reviewer verbatim, with file and line.
3. **Stop.** Do not fix anything. Do not re-run to get a different exit code.
4. Treat `HIGH` as *unconfirmed until checked against the live database catalog*.
   Static analysis cannot see default privileges, function overloads, roles other
   than `anon`/`authenticated`/`public`, or logic inside policy expressions.
5. `INFO` findings are observations, not defects.

---

## Running it

```bash
python3 ~/.agents/skills/postgres-rls-audit/scripts/rls_audit.py <path-or-dir> --exposed public
python3 ~/.agents/skills/postgres-rls-audit/scripts/rls_audit.py <path-or-dir> --exposed public --json
```

| Flag | Default | Purpose |
|---|---|---|
| `paths` | *required* | `.sql` file or directory, e.g. `supabase/migrations` |
| `--exposed` | `public` | API-exposed schemas, comma-separated |
| `--json` | `false` | Structured output: file, line, severity, code, fix |
| `--self-test` | `false` | Built-in verification of the auditor itself |

**Use `--exposed public` for this project.** `docs/backend-schema.md` §89 puts the
helper functions in a non-exposed `private` schema; reporting it as exposed
produces noise about functions clients cannot reach.

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | CLEAN — no `HIGH` findings | Not proof of security. Read the LIMITATIONS block. |
| `1` | At least one `HIGH` finding | Report it. Do not fix it. |
| `2` | COVERAGE PROBLEM — unparsed statement, unreadable file, or 0 files | **Never treat as clean.** Hand-review the named statements. |

---

## Known accepted findings in this project

These are expected and correct. Reporting them again is noise; **fixing them is a
regression.** If you see them, note them in one line and move on.

| Code | Where | Why it is correct |
|---|---|---|
| `POL001` | `roles`, `permissions`, `role_permissions` (migration `20261010193451`) | Global reference data, deliberately readable by any authenticated user. Not tenant data. |
| `RLS004` | all six tables | `FORCE ROW LEVEL SECURITY` is deliberately omitted. Agency creation and user provisioning are server-side `service_role` paths that must bypass RLS. |
| `COV002` | `enable_rls_agencies.sql`, `enable_rls_users.sql`, `enable_rls_agency_memberships.sql` | Column-level grants are used deliberately. The tool cannot model them. |
| `GRT003` | all six tables | **Known false negative.** The tool fails to attribute existing grants to tables. Explicit `revoke … truncate, references, trigger, maintain` statements *are* present in the `enable_rls_*` migrations. Do not conclude the privilege baseline is undefined. |

---

## Known limitations

- **PostgreSQL 17 `MAINTAIN` is not modelled.** The tool's privilege set is
  `{SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER}`. `MAINTAIN`
  permits `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`, a tenant-wide stall RLS cannot
  prevent. **This project revokes `maintain` explicitly**; the tool cannot confirm
  it. Verify in the catalog.
- **`GRT003` false negatives** — see the accepted-findings table above.
- **`references/live-checks.sql` does not exist.** The script's output tells you to
  run it. It does not ship with this skill. Ignore that pointer; query the live
  catalog through pgTAP in `supabase/tests/` instead.
- Static only: it cannot see the live database, default privileges set outside
  these files, overloaded signatures, or runtime logic inside policy expressions.
- **Query the catalog, never enumerate privileges from memory.** This tool has a
  hard-coded privilege list, which is exactly the failure mode that has already
  cost two rounds of review on this project.

---

## Project workflow

When this skill runs on `real-estate-os`:

1. Audit `supabase/migrations/` only. Do not audit `supabase/tests/` — those are
   assertions, not schema.
2. Run it **after** writing migrations, **before** running `pnpm test:db`.
3. Report findings. Change nothing.
4. Confirm any `HIGH` finding against the running database before treating it as real.
5. If exit code is `2`, the result is not a clean result. Say so.

---

## Rules reference

See [`references/rules.md`](./references/rules.md) for all 25 finding codes,
severities, and rationale.