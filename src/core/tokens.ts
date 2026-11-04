import { NyxError } from "./errors.ts";

/**
 * Deterministic token estimator calibrated for code and English text.
 * Uses max(ceil(charCount / 4), wordAndPunctCount * 0.75) so neither dense code
 * nor prose underestimates token usage.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  const byChars = Math.ceil(text.length / 4);
  const segments = text
    .trim()
    .split(/\s+|[{}()[\].,;:!?<>=+\-*/&|^~"'`\\/]+/)
    .filter(Boolean);
  const bySegments = Math.ceil(segments.length * 0.85);
  return Math.max(byChars, bySegments);
}

export interface BudgetResult {
  text: string;
  truncated: boolean;
  estimatedTokens: number;
  originalTokens: number;
  overflowText?: string;
}

/**
 * Enforces a hard token budget on tool output.
 * When `text` exceeds `maxTokens`, truncates cleanly on line or character boundary
 * and returns the full text in `overflowText` so the caller can store it as an artifact.
 */
export function enforceTokenBudget(text: string, maxTokens: number): BudgetResult {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) {
    return {
      text,
      truncated: false,
      estimatedTokens: originalTokens,
      originalTokens,
    };
  }

  const maxChars = Math.max(64, Math.floor((maxTokens - 25) * 3.5));
  let cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.6) {
    cut = cut.slice(0, lastNewline);
  }

  return {
    text: cut,
    truncated: true,
    estimatedTokens: estimateTokens(cut),
    originalTokens,
    overflowText: text,
  };
}

/**
 * Validates that a digest or summary does not exceed `maxTokens`.
 * Per §1.5.5, oversized handoff/subagent digests are rejected, not truncated.
 */
export function assertWithinTokenBudget(
  text: string,
  maxTokens: number,
  label: string,
): number {
  const tokens = estimateTokens(text);
  if (tokens > maxTokens) {
    throw new NyxError(
      "ERR_BUDGET_EXCEEDED",
      `${label} exceeds token budget (${tokens} tokens > max ${maxTokens} tokens). Compress before submitting.`,
      { actualTokens: tokens, maxTokens, label },
    );
  }
  return tokens;
}
