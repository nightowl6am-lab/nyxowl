# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

To report a security issue in Nyxowl (`nyxowl`), please use GitHub's **Private Vulnerability Reporting** feature on the repository's **Security -> Advisories** tab, or email the maintainers with reproduction steps and affected versions.

We aim to acknowledge reports within 48 hours and issue a fix and regression test in `tests/security/` within 7 days for critical/high findings.

---

## Security Architecture Summary

See [`docs/threat-model.md`](./docs/threat-model.md) for the complete threat model and residual risk analysis.

1. **Secret Blindfold:** Agents are blocked from reading `.env` and `.env.*` secret files via host permission rules (`deny` before `allow` in Claude Code; `.env.example` after `.env*` in OpenCode) and `nyxowl hook guard`. Agents inspect environment variable shapes exclusively via `nyx_env_inspect`.
2. **Output Redactor:** Every MCP tool output passes through both exact-value redaction (against local `.env` values) and pattern/entropy redaction (`sk-*`, `ghp_*`, `AKIA*`, `eyJ*`, PEM blocks).
3. **Tainted Web Research & SSRF Firewall:** Only `nyx-product` (a side-effect-free subagent with `edit/write/bash: deny`) can invoke `nyx_web_fetch`. `nyx_web_fetch` blocks private/loopback/link-local/CGNAT IPs on every redirect hop, strips prompt-injection vectors, and stores Blackboard entries as `untrusted` until promoted by `nyxowl`.
4. **Dependency Supply-Chain Guard:** `nyx_dep_guard` checks registry existence, package age, Levenshtein typosquat distance against bundled top-package corpora, install scripts, and OSV advisories. `nyxowl hook guard` blocks package installation commands without a corresponding approval row in SQLite.
5. **Cryptographic Receipts:** `verify`, `seam`, `slop`, and `exploit` receipts are signed with HMAC-SHA256 using `~/.nyxowl/secrets/receipt.key` (`0600`) and bound to the full working-tree Git hash (`GIT_INDEX_FILE` temp index).
