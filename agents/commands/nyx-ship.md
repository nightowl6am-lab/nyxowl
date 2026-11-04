---
name: nyx-ship
description: "Execute a complete vertical-slice feature or bugfix in an isolated worktree and open a receipt-gated PR."
---

# /nyx-ship

Run `nyx_context_hydrate` and `nyx_dna_get`, start an isolated worktree via `nyx_worktree_start`, coordinate the required Blackboard contracts and writer slices (`nyx_slice_checkpoint` -> implement -> `nyx_verify_slice` -> `nyx_slop_check` -> `nyx_seam_check` -> `nyx_exploit_probe`), and open a receipt-verified PR via `nyx_worktree_pr`.
