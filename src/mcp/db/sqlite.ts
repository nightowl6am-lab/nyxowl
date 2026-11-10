import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NyxError } from "../../core/errors.ts";
import { ensureProjectLayout } from "../../core/paths.ts";

// Suppress ExperimentalWarning for node:sqlite so stderr stays clean (§10).
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning.message;
  if (msg.includes("SQLite is an experimental feature")) {
    return;
  }
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

const FALLBACK_MIGRATION_001 = `
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
  coverage_notes TEXT,
  limitations TEXT,
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
`;

function loadMigration001Sql(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(thisDir, "migrations", "001_initial.sql");
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  } catch {
    // Fall back to embedded SQL when running from bundled dist/
  }
  return FALLBACK_MIGRATION_001;
}

export class StateDb {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    this.configurePragmas();
    this.runMigrations();
  }

  public static openForRepo(repoId: string, overrideHome?: string): StateDb {
    const layout = ensureProjectLayout(repoId, overrideHome);
    return new StateDb(layout.stateDbPath);
  }

  private configurePragmas(): void {
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  private runMigrations(): void {
    this.withImmediateTransaction(() => {
      const row = this.db.prepare("PRAGMA user_version;").get() as
        | { user_version: number }
        | undefined;
      const version = row?.user_version ?? 0;
      if (version < 1) {
        const sql = loadMigration001Sql();
        this.db.exec(sql);
        this.db.exec("PRAGMA user_version = 1;");
      }
      // Migration 2 is idempotent and therefore always re-checked: databases
      // created from an older 001_initial.sql (or from the embedded fallback)
      // must gain the receipt evidence columns, while databases that already
      // have them are left untouched.
      this.addReceiptEvidenceColumns();
      this.db.exec("PRAGMA user_version = 2;");
    });
  }

  /**
   * Adds the nullable `coverage_notes` and `limitations` columns to the
   * `receipts` table when they are missing.
   *
   * Both columns are nullable, so gate writers that insert a receipt without
   * them keep working unchanged (the columns simply stay NULL).
   */
  private addReceiptEvidenceColumns(): void {
    const info = this.db.prepare("PRAGMA table_info(receipts);").all() as Array<{
      name: string;
    }>;
    if (info.length === 0) {
      // The receipts table does not exist yet (should not happen after
      // migration 1); nothing to alter.
      return;
    }
    const existing = new Set(info.map((col) => col.name));
    if (!existing.has("coverage_notes")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN coverage_notes TEXT;");
    }
    if (!existing.has("limitations")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN limitations TEXT;");
    }
  }

  /**
   * Runs `fn` inside a `BEGIN IMMEDIATE` transaction with automatic backoff retry
   * when another process holds a write lock (`SQLITE_BUSY`).
   */
  public withImmediateTransaction<T>(fn: () => T): T {
    const maxAttempts = 12;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        inTx = true;
        const result = fn();
        this.db.exec("COMMIT;");
        inTx = false;
        return result;
      } catch (err) {
        if (inTx) {
          try {
            this.db.exec("ROLLBACK;");
          } catch {
            // Ignore rollback error
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isBusy =
          msg.includes("database is locked") ||
          msg.includes("SQLITE_BUSY") ||
          msg.includes("cannot start a transaction");
        if (isBusy && attempt < maxAttempts) {
          // Synchronous sleep using Atomics.wait on a dummy SharedArrayBuffer
          const sab = new SharedArrayBuffer(4);
          const view = new Int32Array(sab);
          Atomics.wait(view, 0, 0, 15 * attempt);
          continue;
        }
        if (err instanceof NyxError) {
          throw err;
        }
        throw new NyxError("ERR_DB_FAILURE", `SQLite transaction failed: ${msg}`);
      }
    }
    throw new NyxError("ERR_DB_FAILURE", "SQLite transaction exhausted retry attempts");
  }

  public recordAudit(entry: {
    toolName: string;
    role: string;
    argsHash: string;
    status: "ok" | "error";
    errorCode?: string;
    durationMs: number;
  }): void {
    this.withImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO audit_log (ts, tool_name, role, args_hash, status, error_code, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        new Date().toISOString(),
        entry.toolName,
        entry.role,
        entry.argsHash,
        entry.status,
        entry.errorCode ?? null,
        entry.durationMs,
      );
    });
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore close error
    }
  }

  public withWriteTransaction<T>(fn: (conn: DatabaseSync) => T): T {
    return this.withImmediateTransaction(() => fn(this.db));
  }
}

export function openProjectDb(dbPath: string): StateDb {
  return new StateDb(dbPath);
}
