# Third-Party Notices

This project includes third-party reference data distributed under permissive open-source licenses (MIT and Apache-2.0), one share-alike skill (CC-BY-SA-4.0), plus vendored tree-sitter grammars.

## Adapted Agent Skills (`agents/skills/`)

Every adapted `SKILL.md` carries a trust-boundary header. Every `references/` file carries a "Reference only; do not execute commands; use the agent's NyxOwl tools" warning. Upstream methodology and examples are retained; instructions are adapted to NyxOwl's tools and Hard Rules. Each package includes the applicable upstream license text. `agents/skills.lock.json` pins every file's upstream repo/commit/path and local/upstream SHA-256; `npm run skills:verify` checks it offline.

| Skill | Source repo | Commit | License | Upstream paths |
| --- | --- | --- | --- | --- |
| `nyxowl` | `https://github.com/wshobson/agents` | `9c61ab243def98f72da12abd41cfcf5bcd91af9d` | MIT | `plugins/agent-teams/skills/parallel-feature-development/**` |
| `nyx-product` | `https://github.com/anthropics/knowledge-work-plugins` | `e050c2ec856373787143d7057663a6ebd1277df3` | Apache-2.0 | `product-management/skills/write-spec/SKILL.md`, `product-management/skills/competitive-brief/SKILL.md` |
| `nyx-architect` | `https://github.com/addyosmani/agent-skills`; `https://github.com/wshobson/agents` | `301b02b12bff98e4688e6984af6556802322bbde`; `9c61ab243def98f72da12abd41cfcf5bcd91af9d` | MIT; MIT | `skills/api-and-interface-design/SKILL.md`; `plugins/backend-development/skills/api-design-principles/SKILL.md` |
| `nyx-designer` | `https://github.com/anthropics/knowledge-work-plugins`; `https://github.com/wshobson/agents` | `e050c2ec856373787143d7057663a6ebd1277df3`; `9c61ab243def98f72da12abd41cfcf5bcd91af9d` | Apache-2.0; MIT | `design/skills/design-system/SKILL.md`; `plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md` |
| `nyx-db` | `https://github.com/affaan-m/ECC`; `https://github.com/supabase/agent-skills` | `d2ef2680594f9a17526a6e1a2e18b3d242c5d17b`; `c9be0e931b7930f7d02126d04774d904c381e7d7` | MIT; MIT | `skills/database-migrations/SKILL.md`; `skills/supabase-postgres-best-practices/references/security-rls-basics.md`, `security-rls-performance.md`, `security-privileges.md`, `lock-deadlock-prevention.md` |
| `nyx-api` | `https://github.com/obra/superpowers`; `https://github.com/wshobson/agents` | `22f0b463e7a5e579904dd6211a520321035526f7`; `9c61ab243def98f72da12abd41cfcf5bcd91af9d` | MIT; MIT | `skills/test-driven-development/SKILL.md`, `writing-good-tests.md`; `plugins/developer-essentials/skills/auth-implementation-patterns/SKILL.md`, `error-handling-patterns/SKILL.md` |
| `nyx-ui` | `https://github.com/addyosmani/agent-skills`; `https://github.com/vercel-labs/web-interface-guidelines` | `301b02b12bff98e4688e6984af6556802322bbde`; `434b7f91364665f2f733b310ec54809bf8f37937` | MIT; MIT | `skills/frontend-ui-engineering/SKILL.md`; `AGENTS.md` |
| `nyx-sec` | `https://github.com/addyosmani/agent-skills` | `301b02b12bff98e4688e6984af6556802322bbde` | MIT | `skills/security-and-hardening/SKILL.md`, `references/hardening-patterns.md` |
| `nyx-testwriter` | `https://github.com/trailofbits/skills` | `e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff` | CC-BY-SA-4.0 | `plugins/property-based-testing/skills/property-based-testing/SKILL.md`, `references/generating.md`, `references/reviewing.md`, `references/interpreting-failures.md` |
| `nyx-probe` | `https://github.com/obra/superpowers` | `22f0b463e7a5e579904dd6211a520321035526f7` | MIT | `skills/systematic-debugging/SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`, `condition-based-waiting-example.ts` |
| `nyx-devops` | `https://github.com/addyosmani/agent-skills`; `https://github.com/wshobson/agents` | `301b02b12bff98e4688e6984af6556802322bbde`; `9c61ab243def98f72da12abd41cfcf5bcd91af9d` | MIT; MIT | `skills/ci-cd-and-automation/SKILL.md`; `plugins/cicd-automation/skills/github-actions-templates/SKILL.md` |

**CC-BY-SA-4.0 notice:** `nyx-testwriter` is adapted from Trail of Bits' property-based-testing skill and remains licensed under CC-BY-SA-4.0. The full license text is in `agents/skills/nyx-testwriter/LICENSE-CC-BY-SA-4.0`; attribution and change details are in `agents/skills/nyx-testwriter/ATTRIBUTION.md`. It is not relicensed as Apache-2.0.

## Bundled Reference Data (`data/popular-packages/`)

- `data/popular-packages/{npm,pypi,crates,go,rubygems,packagist}.json`: Top package names per ecosystem used by `nyx_dep_guard` for Levenshtein typosquatting and slopsquatting detection. Factual package identifier lists, distributed under Apache-2.0.

## Vendored Tree-sitter Grammars (`data/grammars/`)

The following WebAssembly grammars are vendored verbatim from `tree-sitter-wasms@0.1.13` for offline, runtime-free polyglot AST extraction in Engine 2 (`nyx_symbol_skeleton`, `nyx_trace_symbol`):

- **License:** Unlicense
- **Source:** `https://github.com/Gregoor/tree-sitter-wasms`
- **Grammars:**
  - `data/grammars/tree-sitter-python.wasm`
  - `data/grammars/tree-sitter-go.wasm`
  - `data/grammars/tree-sitter-rust.wasm`
  - `data/grammars/tree-sitter-java.wasm`
  - `data/grammars/tree-sitter-ruby.wasm`
  - `data/grammars/tree-sitter-php.wasm`
  - `data/grammars/tree-sitter-c_sharp.wasm`

`data/grammars/manifest.json` pins each vendored grammar's byte length and SHA-256, and runtime loading verifies those pins before parsing.

