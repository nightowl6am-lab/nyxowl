# Updating Nyxowl

Nyxowl is installed and updated through npm. It has no self-update command; npm owns installation, so upgrading the package is the only supported update path.

## Requirements

- Linux (including WSL2); no other operating system is supported
- Node.js **>= 22.13**
- Git **>= 2.30**
- npm (bundled with Node.js)

## Standard upgrade

```bash
npm install -g nyxowl@latest
```

Alternatively, if the global package is already installed:

```bash
npm update -g nyxowl
```

Verify the upgrade and relaunch:

```bash
nyxowl --version
nyxowl doctor
nyxowl /path/to/project
```

`nyxowl doctor` checks runtimes, reports OpenCode status, reports the 11 skill packages (10 native, 1 inline), reports Test-Writer runtime status, and performs a live MCP `ListTools` round-trip against the in-process server (it reports the number of tools actually listed, not a hardcoded count). The OpenCode package is regenerated on every run, so a stale config is replaced.

If `nyxowl doctor` or the first run after an upgrade reports that the Test-Writer runtime is missing, install it as your normal user (no root or sudo):

```bash
nyxowl testwriter install
```

Use `nyxowl testwriter status` to inspect the install root, wrappers, venv, and store.

## No-install / npx

You can run a specific release without a global install:

```bash
npx nyxowl@latest /path/to/project
npx nyxowl@1.0.0 /path/to/project
```

Pin a version when you need reproducible behavior across machines.

## Check and pin versions

```bash
npm view nyxowl version      # latest published version
npm outdated -g nyxowl       # compare your global install
npm install -g nyxowl@1.0.0  # install an exact version
```

Nyxowl follows [Semantic Versioning](https://semver.org/): patch releases contain fixes, minor releases add backward-compatible features, and major releases may include breaking changes. Review [`CHANGELOG.md`](../CHANGELOG.md) before moving across a major version.

## What persists

Upgrades do not reset your local state. Nyxowl keeps it under `~/.nyxowl/` (override with the `NYXOWL_HOME` environment variable):

- The HMAC-SHA256 receipt signing key in `~/.nyxowl/secrets/receipt.key`.
- Global configuration in `~/.nyxowl/config.json`.
- Per-project SQLite state under `~/.nyxowl/projects/<repo-id>/`.
- Worktrees under `~/.nyxowl/worktrees/<repo-id>/`; these worktrees persist with the local Nyxowl state.
- Receipts and project artifacts.

Nyxowl does not modify repository files during an upgrade. Optional files written by `nyxowl init --project` are owned by that command, not by the upgrade.

## What regenerates

- `~/.nyxowl/hosts/opencode/` is regenerated when the version recorded in the install manifest differs from the running version. This happens on the next launch or on `nyxowl doctor`.
- The MCP server starts from the installed package on the next OpenCode session.

## Post-upgrade checklist

1. `nyxowl --version` — confirm the expected version.
2. `nyxowl doctor` — confirm OpenCode status, the 11 skill packages (10 native, 1 inline), and runtimes.
3. Relaunch OpenCode so it loads the regenerated package.
4. `nyxowl status [path]` — confirm worktrees, slices, locks, and receipts are intact.
5. If a repository moved, run `nyxowl relink <old-path> <new-path>`. The old path must still exist when you run the command (relink resolves the old repo id from it), so copy the repository to the new location first, run relink, and only then remove the old path.

## Rollback

Back up `~/.nyxowl` before changing versions, then install the previous release:

```bash
cp -a ~/.nyxowl ~/.nyxowl.backup
npm install -g nyxowl@<previous-version>
```

Local SQLite schema migrations are forward-only (`PRAGMA user_version`; only migration 1 exists today). A downgrade after a future schema-changing release may not be able to read state written by the newer version, so restore the backup if that happens.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| Node.js is too old | Install Node.js >= 22.13 and rerun the command. |
| `nyxowl doctor` reports OpenCode version drift | Update the OpenCode binary, or treat the warning as advisory until the adapter is verified against the new major version. |
| OpenCode configuration looks stale | Relaunch OpenCode; `nyxowl doctor` also regenerates the package when the install-manifest version differs. |
| Stale worktrees | `nyxowl worktree list` inspects recorded worktrees; `prune` is currently an alias of `list` and does not delete anything. `nyxowl worktree remove <slug>` only marks the database record removed; delete any leftover directory manually. |
| Repository moved, state missing | Copy the repository to the new path first, run `nyxowl relink <old-path> <new-path>` while the old path still exists, then remove the old path. Relink cannot resolve the old repo id once the old path is gone. |
| Full reset | Back up `~/.nyxowl` first (see Rollback); `nyxowl uninstall [--purge] [--yes]` restores user configs and removes Nyxowl files. |
| Source installer | Build and run from the checkout instead of npm; source installers do not use the published package. |

## Security

- Install only the official `nyxowl` npm package.
- Verify `nyxowl --version` and run `nyxowl doctor` after upgrading.
- Do not pipe untrusted install scripts into a shell.
- There is no self-update command; npm owns installation and package integrity.
