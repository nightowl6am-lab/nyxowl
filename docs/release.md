# Release Checklist

This checklist is the operational companion to [`PLAN.md`](../PLAN.md). It
covers tagging, publishing, verification, and rollback. Do not publish a
release that fails any gate below.

## 1. Preconditions

- [ ] The work is merged to `main` and the working tree is clean.
- [ ] `CHANGELOG.md` has honest entries for every user-visible change.
- [ ] Full M7 is not claimed anywhere unless PR D has landed.
- [ ] The version in `package.json` is the intended release version.
- [ ] `docs/updating.md` and `README.md` describe the current CLI behavior.

## 2. Tag and version consistency

The release tag **must** be `vX.Y.Z` and **must** equal the `package.json`
version:

```bash
PKG_VERSION=$(node -p "require('./package.json').version")
test "v${PKG_VERSION}" = "vX.Y.Z"   # replace with the actual tag
```

The release workflow performs the same check before publishing. A mismatched
tag aborts the release.

## 3. Local gates

Run every gate from the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm pack --dry-run
python3 -m compileall -q test-writer
python3 test-writer/fixtures/build_fixtures.py --verify
python3 test-writer/selftests/run_all.py
```

Use an existing Test-Writer venv via `TW_VENV_PYTHON` when the self-tests need
one; do not install a new venv just for the release check. Record a `SKIP`
honestly if a prerequisite is unavailable.

Expected highlights:

- Vitest coverage satisfies the global thresholds and the per-glob gates
  (`src/core/**` and `src/mcp/engines/**` at 85% lines/branches, `src/cli/**`
  at 75% lines/branches).
- `npm pack --dry-run` lists the intended runtime, agents, schemas, data
  grammars, docs, Test-Writer assets, `PLAN.md`, and `CHANGELOG.md`.
- `test-writer/fixtures/build_fixtures.py --verify` prints
  `FIXTURES_VERIFY: PASS`.
- The rootless self-tests print `M0_SELFTESTS: PASS` and
  `M1M3_SELFTESTS: PASS`.

## 4. CI gates

The `CI` workflow must be green on the release commit. It runs on Node
`22.13.1` and `24.x` on Linux and includes:

- typecheck, lint, coverage, and build;
- pack-and-install smoke from the packed tarball;
- the fresh-HOME lifecycle matrix (`doctor`, `init --project`,
  copy + `relink`, `uninstall --yes`, `uninstall --purge --yes`) on Node
  `22.13.1`.

The release workflow must also stay green for the tag.

## 5. Packed-artifact smoke

Before publishing, confirm the packed artifact behaves like the checkout:

```bash
TARBALL=$(npm pack --ignore-scripts)
SMOKE_DIR=$(mktemp -d)
npm install --prefix "$SMOKE_DIR" --ignore-scripts "./$TARBALL"
export NYXOWL_HOME="$(mktemp -d)/nyxowl-home"
export NYXOWL_TESTWRITER_INSTALL=0
"$SMOKE_DIR/node_modules/.bin/nyxowl" --version
"$SMOKE_DIR/node_modules/.bin/nyxowl" doctor
```

`doctor` must print `MCP Smoke Test: OK (38 tools listed)` and
`Skill slots: 11`, create `~/.nyxowl` with mode `0700`, and create
`secrets/receipt.key` with mode `0600`.

## 6. Publish with provenance

Publish from the release workflow, which uses npm provenance:

```bash
npm publish --provenance --access public --ignore-scripts
```

The workflow requires `id-token: write` and the `NPM_TOKEN` secret. Verify the
published package on the registry before announcing the release.

## 7. Post-publish verification

- [ ] `npm view nyxowl version` reports the released version.
- [ ] A clean install of the published package passes `--version` and
      `doctor` with a temporary `NYXOWL_HOME`.
- [ ] The provenance attestation is attached to the published package.
- [ ] The GitHub release note links `PLAN.md` and `CHANGELOG.md`.

## 8. Rollback

If a release is broken:

1. Stop the rollout and announce the affected version.
2. `npm deprecate nyxowl@<bad-version> "Reason and replacement version"`.
3. Publish a fixed patch release with a higher version; do not reuse a
   published version number.
4. If local state was written by a newer schema, tell users to restore their
   `~/.nyxowl` backup taken before the upgrade. SQLite migrations are
   forward-only today (`PRAGMA user_version`; only migration 1 exists).
5. Keep the previous release installable for users who need to pin:

   ```bash
   npm install -g nyxowl@<previous-version>
   ```

## 9. Deprecation

When retiring a release or a documented behavior:

- Mark the version with `npm deprecate` and name the replacement.
- Update `CHANGELOG.md` and `docs/updating.md`.
- Keep `~/.nyxowl` state migrations forward-only unless a tested rollback path
  exists.
