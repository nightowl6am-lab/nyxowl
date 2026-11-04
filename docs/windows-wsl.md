# Running Nyxowl on Windows via WSL2

Nyxowl v1 supports **Linux** and **macOS** natively, and supports **Windows via WSL2 (Windows Subsystem for Linux 2)**.

Running `nyxowl` directly inside native Windows (`cmd.exe` or PowerShell outside WSL2) exits immediately with setup instructions for WSL2.

---

## Why WSL2?

Nyxowl's security and isolation guarantees rely on POSIX semantics:
- `0700` and `0600` filesystem permissions on `~/.nyxowl/` and `~/.nyxowl/secrets/receipt.key`,
- Symbolic links for `.env*` worktree provisioning without copying secrets,
- Process-group signaling (`-pid` `SIGTERM`/`SIGKILL`) for deterministic test timeout cleanup and `nyx_proc` daemon reaping,
- Host sandboxes (Bubblewrap / Seatbelt) and POSIX shell hook execution.

All of these work identically to Linux inside WSL2.

---

## 3-Step WSL2 Quickstart

### 1. Install WSL2 (Ubuntu)

Open PowerShell as Administrator and run:

```powershell
wsl --install -d Ubuntu
```

Restart if prompted, then open your **Ubuntu (WSL2)** terminal.

### 2. Install Node.js (>= 22.13) and Git (>= 2.30) inside WSL2

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 22
fnm use 22
sudo apt-get update && sudo apt-get install -y git ripgrep
```

### 3. Install and Run Nyxowl inside WSL2

Keep your repositories inside the WSL2 Linux filesystem (`~/projects/...`) rather than `/mnt/c/...` for fast Git worktree and SQLite WAL performance:

```bash
npm install -g nyxowl
nyxowl ~/projects/my-app
```

If you use **Cursor** or **VS Code / Antigravity** on Windows, connect to your WSL2 environment using the **Remote - WSL** extension and run `nyxowl` from the integrated WSL2 terminal.
