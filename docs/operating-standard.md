# Operating Standard

This standard is binding for every Nyxowl delivery, regardless of repository,
stack, team, or change size. A gate verdict is evidence, not encouragement: it
must certify the surface it names, in its own words, with counts, and it must
name what it did not exercise.

## Verdict vocabulary

Three words are never interchangeable:

- **VERIFIED** — the gate executed the check under its own control and the
  evidence binds to the current tree. State the counts (`ran/configured`,
  `passed/failed/skipped`) and the surface exercised.
- **NOT VERIFIED** — the check exists but was not run, was not configured, could
  not run, or covered only part of the surface. Say why and how much was missed.
- **NA (justified)** — the check does not apply to this tree. The justification
  must be machine-checkable (for example, DNA reports no HTTP surface).

A verdict that exercises a subset reports `partial` or `none` with counts. It is
never described as "full coverage" unless the tool itself reports `full`.

## Scope vocabulary

- **full** — every configured step and surface in scope ran and passed.
- **narrowed** — an explicitly configured subset ran (`verify.scopeSteps`). The
  receipt records the exact selection and is never `full`, even when every
  selected step passes.
- **not-applicable** — no configured step applies. The justification must be
  machine-checkable, and passing unrelated steps cannot stand in for it.

Prerequisites and state are resolved before execution. Unmet prerequisites fail
closed with a machine-readable configuration or environment reason; they never
produce a code-failure RED or a GREEN with an unstated narrower scope.

## Required outcomes

### 1. Evidence completeness

Every receipt states the configured checks, the checks actually run, the pass and
fail counts, and the surface that was exercised. Partial and `NA` are reported
separately. Missing evidence is a limitation on the verdict, not a silent pass.

### 2. Execution ownership

Verification runs the real commands and, for a surface, the real running
application under the gate's control. The authoritative gate must be able to run
the complete configured suite (typecheck, lint, test/coverage, build) without
deferring certification to an external pipeline. Deployment-shaped evidence
(production build, production headers, production caching) is part of the normal
verdict, not a manual afterthought. If a step depends on CI-only services, record
it as not verified and say so.

### 3. Role capability parity

A role may issue a machine-backed verdict only when it can execute the check that
verdict depends on. Read-only analysis may inform a decision, but it cannot
substitute for execution. Dispatch a check only to an owner whose tools can run
it; if no capable owner exists, the gate is not verified.

### 4. Analysis depth

Architectural review covers the layers the application actually has: data access,
the client/server boundary, request and response contracts, server-side
mutations, and routing with typed navigation. The report states which layers were
inspected statically and which were executed.

### 5. Adversarial realism

Security review attacks as an authenticated, in-scope user by default, with
credentials isolated from receipts, logs, artifacts, and transcripts. It covers
abuse controls (authorization, IDOR, mass assignment, replay, rate limiting,
lockout, CORS with credentials), not only reachability and headers.
Unauthenticated probing alone is a limitation, never full security evidence.

### 6. Runtime user experience

Interface review includes rendered behaviour: responsive breakpoints,
right-to-left layout, keyboard operation, focus order and visibility, assistive
technology naming, and contrast. Source-level inspection alone is recorded as a
limitation.

### 7. Determinism

Seeds and fixtures are independent of wall-clock age, insertion order, execution
order, locale, and timezone. A test whose result changes with time or environment
is a defect; record the seed and the failure.

### 8. Performance evidence

Latency and payload measurements on production builds at realistic and scaled
data volumes are part of the delivery verdict, with stated budgets. An
optimization that needs a schema, infrastructure, or dependency change is an
owner decision argued with the measured numbers.

### 9. Budget and lifecycle

A slice's plan covers the full lifecycle including cleanup. Leave no
worktree, branch, process, temporary file, or lock behind. Negative finishing is
a defect even when the code is correct.

### 10. Plan fidelity

Work starts from an explicit sliced plan. Every slice has acceptance criteria and
a defined scope. A phase is never handed over as an unsliced week of
deliverables.

### 11. Decision hygiene

Reversible engineering judgements are made and recorded. Product, market,
pricing, legal, and irreversible security decisions go to research or the owner
with the exact missing decision named. Business behaviour is never invented.

### 12. Truth over cheerfulness

Report numbers, not adjectives. Report the exact error when something fails and
say when a check did not run. No claim is made from expectation, and no receipt,
verdict, or measurement is inferred.

### 13. Credential discipline

No credential appears in a URL, log, artifact, commit, or transcript. A
pre-authentication or no-script fallback that exposes credentials is a release
blocker, not a hardening note.

### 14. Context discipline

Use skeletons, diffs, and traces before whole files. Keep summaries and handoffs
within budget. Stop at acceptance criteria and receipts instead of continuing to
polish.

### 15. Consistency of standard

The same bar applies to every project, stack, and team. Production-grade means
verified behaviour, measured performance, audited security, accessible
interface, and honest evidence, regardless of how small the change looks.

## Gate acceptance checklist

Before a PR is opened, the orchestrator confirms:

1. Each receipt names its status, coverage (`full`/`partial`/`none`), counts, and
   limitations; `NA` carries a machine-checkable justification.
2. The verify receipt ran the complete configured suite, including build, and
   states any surface or deployment check that did not run.
3. Review roles executed the checks behind their verdicts; a read-only role did
   not certify execution.
4. Security evidence is authenticated or explicitly marked unauthenticated.
5. UI evidence includes rendered behaviour or explicitly marks it not verified.
6. Performance evidence includes measured numbers and budgets, or an explicit
   not-verified limitation and the owner decision it needs.
7. Cleanup is complete: no worktree, branch, process, or lock is left behind.
8. Every caveat appears in the human summary and in `openIssues`, not only in an
   artifact.
