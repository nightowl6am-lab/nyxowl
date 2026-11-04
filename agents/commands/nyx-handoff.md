---
name: nyx-handoff
description: "Write a <=400-token task-boundary handoff digest to SQLite and HANDOFF.md, release locks, and compact context."
---

# /nyx-handoff

Summarize the completed task, changed files, key architectural decisions, next task, and cryptographic receipt IDs into `nyx_task_handoff` (<= 400 tokens) and trigger context compaction.
