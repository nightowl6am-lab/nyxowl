---
name: nyx-rewind
description: "Rewind the active worktree to a shadow slice checkpoint without touching git history, .env links, or node_modules."
---

# /nyx-rewind

Inspect available shadow checkpoints and invoke `nyx_slice_rewind` on the active worktree to restore the working tree to the selected `sliceId` while preserving `.env` symlinks and installed dependencies.
