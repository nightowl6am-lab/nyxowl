# Third-Party Notices

This project includes third-party skills and reference data distributed under permissive open-source licenses (MIT and Apache-2.0).

## Vendored Third-Party Skills (`skills-vendor/`)

All vendored skills are integrity-checked via SHA-256 against `agents/skills/registry.json`:

1. **`git-authoring`** — License: Apache-2.0 — Source: `https://github.com/antigravity-skills/git-authoring` (Antigravity Community / Contributors)
2. **`technical-documentation`** — License: Apache-2.0 — Source: `https://github.com/antigravity-skills/technical-documentation` (Antigravity Community / Contributors)
3. **`handling-untrusted-content`** — License: Apache-2.0 — Source: `https://github.com/antigravity-skills/handling-untrusted-content` (Antigravity Community / Contributors)
4. **`domain-modeling`** — License: MIT — Source: `https://github.com/antigravity-skills/domain-modeling` (Antigravity Community / Contributors)
5. **`codebase-design`** — License: MIT — Source: `https://github.com/antigravity-skills/codebase-design` (Antigravity Community / Contributors)
6. **`frontend-ui-engineering`** — License: MIT — Source: `https://github.com/antigravity-skills/frontend-ui-engineering` (Antigravity Community / Contributors)
7. **`web-design-guidelines`** — License: MIT — Source: `https://github.com/vercel-labs/agent-skills` (Copyright (c) Vercel, Inc.)
8. **`database-migrations`** — License: MIT — Source: `https://github.com/antigravity-skills/database-migrations` (Antigravity Community / Contributors)
9. **`supabase-postgres-best-practices`** — License: MIT — Source: `https://github.com/supabase/agent-skills` (Copyright (c) Supabase, Inc.)
10. **`postgres-rls-audit`** — License: MIT — Source: `https://github.com/supabase/agent-skills` (Copyright (c) Supabase, Inc.)
11. **`fastify-best-practices`** — License: MIT — Source: `https://github.com/fastify/agent-skills` (Copyright (c) Fastify Contributors)
12. **`supabase`** — License: MIT — Source: `https://github.com/supabase/agent-skills` (Copyright (c) Supabase, Inc.)
13. **`upstash-redis-js`** — License: MIT — Source: `https://github.com/upstash/agent-skills` (Copyright (c) Upstash, Inc.)
14. **`upstash-ratelimit-js`** — License: MIT — Source: `https://github.com/upstash/agent-skills` (Copyright (c) Upstash, Inc.)
15. **`security`** — License: Apache-2.0 — Source: `https://github.com/antigravity-skills/security` (Antigravity Community / Contributors)
16. **`playwright-behavior`** — License: Apache-2.0 — Source: `https://github.com/antigravity-skills/playwright-behavior` (Antigravity Community / Contributors)

## Bundled Reference Data (`data/popular-packages/`)

- `data/popular-packages/{npm,pypi,crates,go,rubygems,packagist}.json`: Top package names per ecosystem used by `nyx_dep_guard` for Levenshtein typosquatting and slopsquatting detection. Factual package identifier lists, distributed under Apache-2.0.
