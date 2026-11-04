# Nyxowl Threat Model

This document details the security boundaries, adversary capabilities, mitigations, and residual risks in **Nyxowl (`nyxowl`)**.

---

## 1. Trust Boundaries

1. **User Main Checkout (Protected Read-Only Boundary):**
   - The user's main working tree may contain uncommitted work in progress.
   - `nyxowl hook edit-guard` blocks direct edits to the main checkout during a Nyxowl session. All code modifications occur inside isolated Git worktrees (`~/.nyxowl/worktrees/<repo-id>/<slug>/` on Tier A/B hosts, or `<repo>/.nyxowl/worktrees/<slug>/` on Tier C hosts).
2. **Local Secrets & Nyxowl State (`~/.nyxowl/secrets/`, `~/.nyxowl/projects/`, `.env*`):**
   - `.env` and `.env.*` (excluding `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*credentials*.json`, `~/.nyxowl/secrets/receipt.key` (`0600`), and `~/.nyxowl/projects/<repo-id>/state.db` are off-limits to agents.
   - Enforced at three layers:
     1. Host-level permission rules (`deny` before `allow` in Claude Code; `.env.example` after `.env*` in OpenCode).
     2. Pre-tool execution hooks (`nyxowl hook guard` and `nyxowl hook edit-guard`) parsing compound shell commands via `shell-quote`.
     3. Exact-Value + Entropy Output Redactor (`src/core/redact.ts`) applied to every MCP tool response and subprocess output stream.
3. **External Web & Third-Party Content (Untrusted Data Boundary):**
   - Only `nyx-product` (a tainted, side-effect-free subagent with `edit/write/bash: deny`) has access to `nyx_web_fetch`.
   - `nyx_web_fetch` enforces an SSRF firewall blocking private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), link-local/cloud metadata (`169.254.0.0/16`), and CGNAT (`100.64.0.0/10`) addresses on initial DNS resolution **and** every HTTP redirect hop.
   - HTML is stripped to readable text via `linkedom` + `@mozilla/readability`, scrubbed for hidden Unicode/bidi/comment prompt injections (`src/mcp/engines/shield/sanitize.ts`), and wrapped in `<untrusted_data>`.
   - Entries written to the Blackboard by `nyx-product` are stored with `trust = 'untrusted'`. Writer subagents (`nyx-db`, `nyx-api`, `nyx-ui`, `nyx-designer`, `nyx-devops`) cannot read `untrusted` entries until `nyxowl` reviews and promotes them (`promote: true`).

---

## 2. Supply-Chain & Slopsquatting Defense

- Hallucinated or typosquatted package names are a primary vector for AI-assisted supply-chain compromise.
- `nyx_dep_guard` checks:
  - Package existence and age (`>= 14` days),
  - Levenshtein distance (`<= 2`) against bundled top-package corpora (`data/popular-packages/*.json`),
  - Presence of `preinstall`/`install`/`postinstall` lifecycle scripts,
  - Known vulnerabilities via OSV.dev,
  - **Fail-closed offline:** if registries are unreachable, `nyx_dep_guard` rejects the dependency rather than silently approving.
- `nyxowl hook guard` intercepts `npm i`, `pnpm add`, `yarn add`, `bun add`, `pip install`, `uv add`, `poetry add`, `cargo add`, `go get`, `gem install`, and `composer require` and blocks execution unless an approved row exists in `dep_approvals`.

---

## 3. Cryptographic Receipts & PR Gate

- Every `verify`, `seam`, `slop`, and `exploit` gate produces a `SignedReceipt` signed with `HMAC-SHA256(receipt.key, canonicalJSON(payload))`.
- Each receipt binds to the full working-tree Git hash (`GIT_INDEX_FILE` temporary index including untracked non-ignored files).
- Any subsequent file modification changes `treeHash`, automatically invalidating stale receipts.
- `nyx_worktree_pr` and `nyxowl receipts verify` re-compute the tree hash and verify every HMAC signature before pushing or opening a pull request.

---

## 4. Residual Risks

1. **Hook Evasion on Non-Sandboxed Hosts (Tier B/C):** Pattern-based shell guards can potentially be bypassed via obfuscated scripts on hosts without an OS-level filesystem sandbox. Nyxowl mitigates this by preferring Tier A sandboxed hosts (`claude`, `opencode`, `agy`), displaying the active host's Security Tier at launch, and running the Output Redactor and Diff Secret Scanner inside the trusted MCP server process.
2. **Orchestrator Promotion Review:** While `nyx-product` cannot execute commands or edit files, `nyxowl` reads sanitized summaries when deciding whether to promote a Blackboard entry.
3. **Host Config Drift:** Coding hosts evolve rapidly. `nyxowl doctor` compares installed host versions against `docs/host-matrix.md` and warns when a major version exceeds the last verified release.
