import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NyxError } from "./errors.ts";
import { ensureNyxHome } from "./paths.ts";

export type ReceiptKind = "verify" | "seam" | "slop" | "exploit";
export type ReceiptStatus = "GREEN" | "RED" | "NA";
export type SeamCoverage = "full" | "partial" | "none";

export interface ReceiptPayload {
  id: string;
  kind: ReceiptKind;
  status: ReceiptStatus;
  coverage?: SeamCoverage;
  /**
   * Free-form, human-readable statements about WHAT the receipt actually covered.
   * Notes are signed with the receipt and rendered verbatim in the PR body so a
   * reader can see the difference between "configured steps ran" and "the
   * surface was exercised".
   */
  coverageNotes?: string[];
  /**
   * Known gaps, open issues, and reasons the evidence is weaker than it looks.
   * Limitations are signed with the receipt and rendered verbatim in the PR body.
   */
  limitations?: string[];
  worktree: string;
  branch: string;
  treeHash: string;
  baseSha: string;
  commandsHash: string;
  evidenceArtifactId: string | null;
  naJustification?: string;
  createdAt: string;
}

export interface SignedReceipt extends ReceiptPayload {
  hmac: string;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a standard 26-character lexicographically sortable ULID using `node:crypto`.
 */
export function generateUlid(nowMs: number = Date.now()): string {
  let time = nowMs;
  let timeChars = "";
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeChars = CROCKFORD_BASE32[mod]! + timeChars;
    time = Math.floor(time / 32);
  }

  const randBytes = crypto.randomBytes(16);
  let randChars = "";
  for (let i = 0; i < 16; i++) {
    randChars += CROCKFORD_BASE32[randBytes[i]! & 31]!;
  }
  return timeChars + randChars;
}

/**
 * Deterministic canonical JSON serialization with lexicographically sorted keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Ensures `~/.nyxowl/secrets/receipt.key` exists with mode 0600 and returns the 32-byte key buffer.
 */
export function ensureReceiptKey(overrideHome?: string): Buffer {
  const layout = ensureNyxHome(overrideHome);
  if (fs.existsSync(layout.receiptKeyPath)) {
    const hex = fs.readFileSync(layout.receiptKeyPath, "utf8").trim();
    if (hex.length >= 64) {
      return Buffer.from(hex, "hex");
    }
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(layout.receiptKeyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.receiptKeyPath, key.toString("hex") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(layout.receiptKeyPath, 0o600);
  } catch {
    // Ignore on filesystems without POSIX permissions
  }
  return key;
}

export function extractReceiptPayload(receipt: ReceiptPayload | SignedReceipt): ReceiptPayload {
  const payload: ReceiptPayload = {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    worktree: receipt.worktree,
    branch: receipt.branch,
    treeHash: receipt.treeHash,
    baseSha: receipt.baseSha,
    commandsHash: receipt.commandsHash,
    evidenceArtifactId: receipt.evidenceArtifactId,
    createdAt: receipt.createdAt,
  };
  if (receipt.coverage !== undefined) {
    payload.coverage = receipt.coverage;
  }
  // The optional evidence fields are included ONLY when defined. A receipt that
  // predates them therefore canonicalizes to exactly the same JSON — and
  // therefore to exactly the same HMAC — as before this change.
  if (receipt.coverageNotes !== undefined) {
    payload.coverageNotes = [...receipt.coverageNotes];
  }
  if (receipt.limitations !== undefined) {
    payload.limitations = [...receipt.limitations];
  }
  if (receipt.naJustification !== undefined) {
    payload.naJustification = receipt.naJustification;
  }
  return payload;
}

/**
 * Encodes an optional list of receipt notes for storage in a TEXT column.
 * `undefined` maps to SQL NULL so an absent list is distinguishable from an
 * empty one.
 */
export function encodeOptionalNoteList(
  values: readonly string[] | undefined,
): string | null {
  if (values === undefined) {
    return null;
  }
  return JSON.stringify([...values]);
}

/**
 * Decodes a TEXT column produced by {@link encodeOptionalNoteList}.
 * Returns `undefined` for NULL, empty, or unparsable content so a corrupted
 * row can never fabricate evidence.
 */
export function decodeOptionalNoteList(
  raw: string | null | undefined,
): string[] | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return undefined;
  }
}

/**
 * Coverage a receipt note talks about.
 *
 * - `configured-step`: the configured verification steps (typecheck, lint, test,
 *   build, seam layers, ...) that the gate actually ran.
 * - `surface`: the running surface (browser, HTTP runtime, ...) that was or was
 *   not exercised.
 */
export type ReceiptNoteScope = "configured-step" | "surface";

/** Prefix marking a coverage note as being about the running surface. */
export const SURFACE_NOTE_PREFIX = "surface:";

/** Prefix marking a coverage note as being about the configured steps. */
export const CONFIGURED_STEP_NOTE_PREFIX = "configured-step:";

/** Prefix marking a coverage note as recording that the surface WAS exercised. */
export const SURFACE_EXERCISED_NOTE_PREFIX = "surface:exercised:";

/** Prefix marking a coverage note as recording that the surface was NOT exercised. */
export const SURFACE_NOT_EXERCISED_NOTE_PREFIX = "surface:not-exercised:";

/**
 * Classifies a coverage note by its optional scope prefix.
 *
 * A note that starts with `surface:` describes the running surface (browser /
 * HTTP runtime). A note that starts with `configured-step:` describes the
 * configured verification steps. Any other note is a configured-step note,
 * because that is what a gate's coverage note is about by default.
 *
 * The note itself is never modified: callers render the original string so the
 * evidence stays verbatim.
 */
export function classifyCoverageNote(note: string): ReceiptNoteScope {
  const trimmed = note.trimStart().toLowerCase();
  if (trimmed.startsWith(SURFACE_NOTE_PREFIX)) {
    return "surface";
  }
  if (trimmed.startsWith(CONFIGURED_STEP_NOTE_PREFIX)) {
    return "configured-step";
  }
  return "configured-step";
}

/**
 * Whether the running surface was exercised, according to the coverage notes.
 *
 * - `exercised`: a note explicitly records that the surface was exercised.
 * - `not-exercised`: a note explicitly records that it was not.
 * - `not-reported`: no note says either way.
 *
 * Conservative by design: an explicit "not exercised" always wins, so a gate
 * can never make the PR body claim surface coverage that was not recorded.
 */
export function classifySurfaceExercise(
  notes: readonly string[] | undefined,
): "exercised" | "not-exercised" | "not-reported" {
  if (!notes || notes.length === 0) {
    return "not-reported";
  }
  let sawExercised = false;
  for (const note of notes) {
    const trimmed = note.trimStart().toLowerCase();
    if (trimmed.startsWith(SURFACE_NOT_EXERCISED_NOTE_PREFIX)) {
      return "not-exercised";
    }
    if (trimmed.startsWith(SURFACE_EXERCISED_NOTE_PREFIX)) {
      sawExercised = true;
    }
  }
  return sawExercised ? "exercised" : "not-reported";
}

export function computeReceiptHmac(payload: ReceiptPayload, key: Buffer): string {
  const canonical = canonicalJson(extractReceiptPayload(payload));
  return crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

export function signReceipt(payload: ReceiptPayload, key: Buffer): SignedReceipt {
  if (payload.status === "NA" && (!payload.naJustification || !payload.naJustification.trim())) {
    throw new NyxError(
      "ERR_RECEIPT_INVALID",
      `Receipt of kind "${payload.kind}" with status NA requires a machine-checkable naJustification`,
    );
  }
  const cleanPayload = extractReceiptPayload(payload);
  const hmac = computeReceiptHmac(cleanPayload, key);
  return {
    ...cleanPayload,
    hmac,
  };
}

export interface VerifyReceiptOptions {
  expectedTreeHash?: string;
  requireGreenOrNa?: boolean;
  httpSurface?: boolean;
}

export interface VerifyReceiptResult {
  valid: boolean;
  reason?: string;
}

export function verifyReceipt(
  receipt: SignedReceipt,
  key: Buffer,
  options: VerifyReceiptOptions = {},
): VerifyReceiptResult {
  if (!receipt || typeof receipt.hmac !== "string" || receipt.hmac.length !== 64) {
    return { valid: false, reason: "Missing or malformed HMAC signature" };
  }

  const expectedHmac = computeReceiptHmac(receipt, key);
  const actualBuf = Buffer.from(receipt.hmac, "hex");
  const expectedBuf = Buffer.from(expectedHmac, "hex");
  if (
    actualBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return { valid: false, reason: "HMAC signature mismatch (tampered receipt)" };
  }

  if (options.expectedTreeHash && receipt.treeHash !== options.expectedTreeHash) {
    return {
      valid: false,
      reason: `Receipt treeHash (${receipt.treeHash.slice(0, 12)}) does not match current HEAD/working tree (${options.expectedTreeHash.slice(0, 12)})`,
    };
  }

  if (receipt.status === "NA") {
    if (!receipt.naJustification || !receipt.naJustification.trim()) {
      return { valid: false, reason: "NA receipt is missing naJustification" };
    }
    if (receipt.kind === "exploit" && options.httpSurface === true) {
      return {
        valid: false,
        reason: "exploit receipt cannot be NA when DNA httpSurface is true",
      };
    }
  }

  if (options.requireGreenOrNa && receipt.status === "RED") {
    return {
      valid: false,
      reason: `Receipt "${receipt.id}" (${receipt.kind}) has status RED`,
    };
  }

  return { valid: true };
}

export function verifyReceiptHmac(
  key: Buffer,
  payload: ReceiptPayload,
  hmac: string,
): boolean {
  return verifyReceipt({ ...payload, hmac }, key).valid;
}
