# Contributing to Nyxowl

Thank you for contributing to Nyxowl!

## Prerequisites

- **Node.js** `>= 22.13.0` (Node 22 LTS or Node 24)
- **Git** `>= 2.30.0`
- **OS:** Linux only (Windows via WSL2; see `docs/windows-wsl.md`)

## Development Workflow

```bash
# Install dependencies safely without running arbitrary lifecycle scripts
npm install --ignore-scripts

# Typecheck (strict TypeScript)
npm run typecheck

# Lint
npm run lint

# Run deterministic unit, contract, adapter, hook, and E2E tests
npm test

# Run tests with coverage enforcement
npm run test:coverage

# Build dist/ bundle
npm run build
```

## Quality & Security Rules

1. **Zero Native Addons & No `postinstall`:** Do not add native C++ dependencies (`better-sqlite3`, `node-gyp`) or `postinstall` scripts to `package.json`. Use built-in `node:sqlite`.
2. **Stdout Purity in MCP:** Never use `console.log` in `src/core/` or `src/mcp/`. All structured logs must write to `stderr` via `src/core/logger.ts`.
3. **Deterministic Tests Only:** All tests must run offline using temporary directories, local bare Git remotes, and fake host binaries.
4. **Zero-Slop Dogfooding:** Every pull request must pass `nyx_slop_check` and `nyx_verify_slice`.
5. **Conventional Commits:** Format commit messages as `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, or `docs(scope): ...`.
