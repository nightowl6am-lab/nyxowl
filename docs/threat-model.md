# Nyxowl Threat Model

This document details the security boundaries, adversary capabilities, mitigations, and residual risks in **Nyxowl (`nyxowl`)**.

---

## 1. Trust Boundaries

1. **User Main Checkout (Protected Read-Only Boundary):**
   - The user's main working tree may contain uncommitted work in progress.
   - `nyxowl hook edit-guard` blocks direct edits to the main checkout during a Nyxowl session. All code modifications occur inside isolated external Git worktrees (`~/.nyxowl/worktrees/<repo-id>/<slug>/`).
2. **Local Secrets & Nyxowl State (`~/.nyxowl/secrets/`, `~/.nyxowl/projects/`, `.env*`):**
   - `.env` and `.env.*` (excluding `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*credentials*.json`, `~/.nyxowl/secrets/receipt.key` (`0600`), and `~/.nyxowl/projects/<repo-id>/state.db` are off-limits to agents.
   - Enforced at three layers:
     1. OpenCode v2.2.5 permission rules (ordered last-match-wins; `.env.example` after `.env*`).
     2. Pre-tool execution hooks (`nyxowl hook guard` and `nyxowl hook edit-guard`) parsing compound shell commands via `shell-quote`.
     3. Exact-Value + Entropy Output Redactor (`src/core/redact.ts`) applied to every MCP tool response and subprocess output stream.
3. **External Web & Third-Party Content (Untrusted Data Boundary):**
   - Only `nyx-product` (a tainted, side-effect-free subagent with `edit/write/bash: deny`) has access to `nyx_web_fetch`.
   - `nyx_web_fetch` enforces an SSRF firewall blocking private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), link-local/cloud metadata (`169.254.0.0/16`), and CGNAT (`100.64.0.0/10`) addresses on initial DNS resolution **and** every HTTP redirect hop.
   - HTML is stripped to readable text via `linkedom` + `@mozilla/readability`, scrubbed for hidden Unicode/bidi/comment prompt injections (`src/mcp/engines/shield/sanitize.ts`), and wrapped in `<untrusted_data>`.
   - Entries written to the Blackboard by `nyx-product` are stored with `trust = 'untrusted'`. Writer subagents (`nyx-db`, `nyx-api`, `nyx-ui`, `nyx-designer`, `nyx-devops`) cannot read `untrusted` entries until `nyxowl` reviews and promotes them (`promote: true`).
4. **Test-Writer Proof Boundary:**
   - `nyx-testwriter` has no host read/edit/write/shell/webfetch tools. Its only tools are five `nyx_testwriter_*` MCP tools.
   - Those tools broker fixed `<install>/bin/tw-gate` and `tw-status` wrappers. The runtime is installed rootlessly under `~/.nyxowl/test-writer` and every wrapper runs directly as the owner; there is no separate grader OS user and no privilege transition. The store is `<install>/store` (`0700`) and is owner-readable; the subagent still has no host filesystem tools.
   - The subagent sees only the approved spec, detector, interface, helper API, and budget. It never sees target implementation bodies, variants, mutants, raw grader output, or the canary.
   - Proof tests are grader evidence, not repository regression tests: they depend on the grader-only `detector` fixture and must not be added to the target's normal test discovery.
   - The barrier is information asymmetry and the fixed broker/tool boundary, not OS privilege separation: the owner is trusted and the LLM is the adversary. The broker fails closed when the runtime is absent, and sanitizes grader feedback to a fixed key set. No new receipt kind is introduced; the existing verify/seam/slop/exploit PR gate is unchanged.

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
- Vendored parser grammars are pinned in `data/grammars/manifest.json` (byte length + SHA-256). The manifest is read from the same directory as the `.wasm`, and only bytes matching the pinned size and digest are passed to `Parser.Language.load`. A missing/invalid manifest, missing entry, size mismatch, or hash mismatch fails closed to the legacy regex outline; unverified grammar bytes are never loaded. This also applies to `NYXOWL_GRAMMARS_DIR` overrides, which must ship their own manifest.

---

## 3. Cryptographic Receipts & PR Gate

- Every `verify`, `seam`, `slop`, and `exploit` gate produces a `SignedReceipt` signed with `HMAC-SHA256(receipt.key, canonicalJSON(payload))`.
- Each receipt binds to the full working-tree Git hash (`GIT_INDEX_FILE` temporary index including untracked non-ignored files).
- Any subsequent file modification changes `treeHash`, automatically invalidating stale receipts.
- `nyx_worktree_pr` and `nyxowl receipts verify` re-compute the tree hash and verify every HMAC signature before pushing or opening a pull request.

---

## 4. Residual Risks

1. **Hook Evasion in OpenCode v2.2.5:** OpenCode v2.2.5 provides no OS-level filesystem sandbox; pattern-based shell guards can potentially be bypassed via obfuscated scripts. Nyxowl mitigates this with ordered OpenCode permission rules (deny secret paths before broad allows), pre-tool `guard`/`edit-guard` hooks, worktree-only edits, red-line shell blocks, and the Output Redactor and Diff Secret Scanner running inside the trusted MCP server process. Reviewed permissions remain a defense-in-depth layer, not a kernel boundary, so the owner must still review every worktree change before merge.
2. **Orchestrator Promotion Review:** While `nyx-product` cannot execute commands or edit files, `nyxowl` reads sanitized summaries when deciding whether to promote a Blackboard entry.
3. **OpenCode Config Drift:** OpenCode evolves rapidly. `nyxowl doctor` compares the installed OpenCode version against `docs/host-matrix.md` and warns when a major version exceeds the last verified release (v2.2.5).
4. **Bounded Parsing/Skeleton Execution:** Hostile or pathologically deep source can exhaust memory or the call stack. Nyxowl rejects sources over 2,000,000 characters, ASTs deeper than 200 or larger than 50,000 named nodes (falling back to the legacy outline), and skeleton files over 2 MiB or 50,000 lines (`ERR_FILE_TOO_LARGE`). Grammar and skeleton caches are FIFO-bounded (32 and 256 entries). Residual risk: extremely large files are rejected rather than partially analyzed, so callers must inspect oversized files with narrower tooling.
