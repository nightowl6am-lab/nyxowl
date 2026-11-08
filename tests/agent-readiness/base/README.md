# Agent Readiness Base Fixture

Inert sample project used by the deterministic agent-readiness checks and the
local-only live OpenCode harness. Nothing here is executed during
`npm run test:agents`; the live harness copies it into a temporary repository.

Contents:

- `migrations/001_init.sql`: one table without RLS and one tautological policy.
- `src/applyPatch.ts` / `src/consumer.ts`: export/import seam mismatch.
- `src/loadConfig.ts`: reads three environment keys, one of which is not declared.
- `src/routes.ts`: `/:id` route without an owner/tenant predicate.
- `src/tokens.css`: one failing AA contrast pair and one passing pair.
- `src/component.tsx`: loading, empty, aria-live, and focus-visible but no error state.
- `src/flaky.mjs`: one seed-dependent function and one stable function.
- `fixtures/*`: inert canary, injection text, and a tautological pytest sample.
- `stacktrace.txt`: deterministic failing-test stack trace.

Never place a real secret or a non-loopback URL in this directory.
