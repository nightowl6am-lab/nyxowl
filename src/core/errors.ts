export type ErrorCode =
  | "ERR_INVALID_INPUT"
  | "ERR_CONFIG_INVALID"
  | "ERR_PREFLIGHT_FAILED"
  | "ERR_NOT_GIT_REPO"
  | "ERR_ALREADY_GIT_REPO"
  | "ERR_FOLDER_NOT_EMPTY"
  | "ERR_WORKTREE_EXISTS"
  | "ERR_WORKTREE_NOT_FOUND"
  | "ERR_WORKTREE_DIRTY"
  | "ERR_SLICE_NOT_FOUND"
  | "ERR_RECEIPT_INVALID"
  | "ERR_RECEIPT_STALE_TREE"
  | "ERR_RECEIPT_MISSING"
  | "ERR_SECRET_DETECTED"
  | "ERR_REDLINE_BLOCKED"
  | "ERR_LOCK_CONFLICT"
  | "ERR_BLACKBOARD_UNTRUSTED"
  | "ERR_BLACKBOARD_UNAUTHORIZED"
  | "ERR_BLACKBOARD_CITATION_INVALID"
  | "ERR_BUDGET_EXCEEDED"
  | "ERR_DOOM_LOOP_ESCALATION"
  | "ERR_SSRF_BLOCKED"
  | "ERR_NETWORK_BLOCKED"
  | "ERR_DEP_REJECTED"
  | "ERR_PROBE_TARGET_FORBIDDEN"
  | "ERR_EXEC_TIMEOUT"
  | "ERR_EXEC_FAILED"
  | "ERR_GIT_FAILED"
  | "ERR_HOST_UNSUPPORTED"
  | "ERR_DB_FAILURE"
  | "ERR_ARTIFACT_NOT_FOUND"
  | "ERR_FILE_TOO_LARGE"
  | "ERR_TESTWRITER_UNAVAILABLE"
  | "ERR_TESTWRITER_PROTOCOL"
  | "ERR_TESTWRITER_TEST_MISSING"
  | "ERR_INTERNAL";

export class NyxError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "NyxError";
    this.code = code;
    this.details = details;
  }

  public toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function toNyxError(err: unknown, fallbackCode: ErrorCode = "ERR_INTERNAL"): NyxError {
  if (err instanceof NyxError) {
    return err;
  }
  if (err instanceof Error) {
    return new NyxError(fallbackCode, err.message);
  }
  return new NyxError(fallbackCode, String(err));
}
