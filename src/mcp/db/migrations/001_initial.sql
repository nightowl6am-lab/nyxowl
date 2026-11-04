CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dna (
  repo_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  dna_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  task_slug TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  root TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slices (
  slice_id TEXT PRIMARY KEY,
  task_slug TEXT NOT NULL,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_slug TEXT NOT NULL,
  slice_id TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  normalized_error TEXT NOT NULL,
  strike_count INTEGER NOT NULL,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(task_slug, slice_id, signature_hash)
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  coverage TEXT,
  worktree TEXT NOT NULL,
  branch TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  commands_hash TEXT NOT NULL,
  evidence_artifact_id TEXT,
  na_justification TEXT,
  created_at TEXT NOT NULL,
  hmac TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_tree ON receipts(tree_hash, kind);

CREATE TABLE IF NOT EXISTS dep_approvals (
  pkg_key TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  approved INTEGER NOT NULL,
  findings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blackboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  category TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  author_role TEXT NOT NULL,
  trust TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(key, version)
);

CREATE INDEX IF NOT EXISTS idx_blackboard_key ON blackboard(key, version DESC);

CREATE TABLE IF NOT EXISTS locks (
  file_path TEXT PRIMARY KEY,
  owner_role TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  completed_task TEXT NOT NULL,
  files_changed_json TEXT NOT NULL,
  key_decisions_json TEXT NOT NULL,
  next_task TEXT NOT NULL,
  receipts_json TEXT NOT NULL,
  digest_markdown TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  source_url TEXT NOT NULL,
  sanitized_summary TEXT NOT NULL,
  api_contract TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_fetch_url ON web_fetch_log(url);

CREATE TABLE IF NOT EXISTS procs (
  name TEXT PRIMARY KEY,
  worktree_path TEXT NOT NULL,
  pid INTEGER NOT NULL,
  port INTEGER,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  log_artifact_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  role TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER NOT NULL
);
