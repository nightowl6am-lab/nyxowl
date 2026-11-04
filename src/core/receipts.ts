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
  if (receipt.naJustification !== undefined) {
    payload.naJustification = receipt.naJustification;
  }
  return payload;
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
