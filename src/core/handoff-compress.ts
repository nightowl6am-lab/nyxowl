import { estimateTokens } from "./tokens.ts";

export interface HandoffSubagentSummary {
  status: string;
  role: string;
  slice: string;
  filesChanged: string[];
  receipts: string[];
  contractsPublished: string[];
  openIssues: string[];
  nextAction: string;
}

export interface HandoffDigestInput {
  completedTask: string;
  filesChanged: string[];
  keyDecisions: string[];
  nextTask: string;
  receipts: string[];
  subagentSummary?: HandoffSubagentSummary;
}

export interface HandoffDigestResult {
  digestMarkdown: string;
  tokenCount: number;
  originalTokenCount: number;
  compressed: boolean;
  /** Deterministic description of what compression removed. */
  compressionNotes: string[];
}

interface RenderLimits {
  maxDecisions: number;
  maxFiles: number;
  maxReceipts: number;
  maxFieldChars: number;
  includeSubagent: boolean;
}

const FULL_LIMITS: RenderLimits = {
  maxDecisions: Number.POSITIVE_INFINITY,
  maxFiles: Number.POSITIVE_INFINITY,
  maxReceipts: Number.POSITIVE_INFINITY,
  maxFieldChars: Number.POSITIVE_INFINITY,
  includeSubagent: true,
};

/**
 * Progressive, deterministic compression stages. The order never depends on
 * timestamps, hashes, locale, or map iteration: the same input always yields
 * the same compressed digest.
 */
const COMPRESSION_STAGES: readonly RenderLimits[] = [
  { maxDecisions: 8, maxFiles: 20, maxReceipts: 20, maxFieldChars: 240, includeSubagent: true },
  { maxDecisions: 5, maxFiles: 12, maxReceipts: 12, maxFieldChars: 200, includeSubagent: true },
  { maxDecisions: 3, maxFiles: 8, maxReceipts: 8, maxFieldChars: 160, includeSubagent: false },
  { maxDecisions: 2, maxFiles: 5, maxReceipts: 5, maxFieldChars: 140, includeSubagent: false },
  { maxDecisions: 1, maxFiles: 3, maxReceipts: 3, maxFieldChars: 120, includeSubagent: false },
  { maxDecisions: 1, maxFiles: 2, maxReceipts: 2, maxFieldChars: 100, includeSubagent: false },
];

function truncateField(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function listWithOverflow(values: readonly string[], max: number, transform: (v: string) => string): string {
  if (values.length === 0) {
    return "none";
  }
  const shown = values.slice(0, max).map(transform);
  const omitted = values.length - shown.length;
  return `${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function renderDigest(
  input: HandoffDigestInput,
  limits: RenderLimits,
  compressedNote: string | null,
): string {
  const trim = (value: string): string => truncateField(value, limits.maxFieldChars);
  const digestLines = [
    `# Nyxowl Task Handoff`,
    `- **Completed:** ${trim(input.completedTask)}`,
    `- **Next:** ${trim(input.nextTask)}`,
    `- **Files (${input.filesChanged.length}):** ${listWithOverflow(input.filesChanged, limits.maxFiles, trim)}`,
    `- **Receipts:** ${listWithOverflow(input.receipts, limits.maxReceipts, trim)}`,
    `- **Decisions:**`,
    ...input.keyDecisions
      .slice(0, limits.maxDecisions)
      .map((decision, index) => `  - ${trim(decision)}${index === limits.maxDecisions - 1 && input.keyDecisions.length > limits.maxDecisions ? ` (+${input.keyDecisions.length - limits.maxDecisions} more)` : ""}`),
  ];
  if (input.keyDecisions.length === 0) {
    digestLines.push("  - none");
  }
  if (limits.includeSubagent && input.subagentSummary) {
    const summary = input.subagentSummary;
    digestLines.push(
      `- **Subagent (${trim(summary.role)} / ${trim(summary.slice)}):** ${trim(summary.status)} -> ${trim(summary.nextAction)}`,
    );
    if (summary.openIssues.length > 0) {
      digestLines.push(
        `- **Open issues:** ${listWithOverflow(summary.openIssues, 3, trim)}`,
      );
    }
  }
  if (compressedNote !== null) {
    digestLines.push(`- **Compressed:** ${compressedNote}`);
  }
  return digestLines.join("\n");
}

/**
 * Builds a handoff digest and deterministically compresses it when it exceeds
 * the token budget. Returns the same digest for the same input, always at or
 * under `maxTokens` (unless even the hard-truncated form cannot fit), while
 * keeping the exact next action near the top of the digest.
 */
export function buildHandoffDigest(
  input: HandoffDigestInput,
  maxTokens: number,
): HandoffDigestResult {
  const full = renderDigest(input, FULL_LIMITS, null);
  const originalTokenCount = estimateTokens(full);
  if (originalTokenCount <= maxTokens) {
    return {
      digestMarkdown: full,
      tokenCount: originalTokenCount,
      originalTokenCount,
      compressed: false,
      compressionNotes: [],
    };
  }

  const notes: string[] = [];
  for (const stage of COMPRESSION_STAGES) {
    const note = `yes — original ${originalTokenCount} tokens > budget ${maxTokens}; key decisions, files, and receipts capped deterministically`;
    const rendered = renderDigest(input, stage, note);
    const tokens = estimateTokens(rendered);
    if (tokens <= maxTokens) {
      return {
        digestMarkdown: rendered,
        tokenCount: tokens,
        originalTokenCount,
        compressed: true,
        compressionNotes: [note],
      };
    }
  }

  // Last resort: keep the actionable head (Completed, Next) and truncate the
  // tail deterministically. The marker tells a fresh session what was lost.
  const stage = COMPRESSION_STAGES[COMPRESSION_STAGES.length - 1]!;
  const note = `yes — original ${originalTokenCount} tokens > budget ${maxTokens}; hard-truncated tail, next action preserved`;
  let rendered = renderDigest(input, stage, note);
  const marker = "\n… [compressed: truncated tail]";
  const minChars = 80;
  while (estimateTokens(rendered) > maxTokens && rendered.length > minChars) {
    const nextLength = Math.max(minChars, Math.floor(rendered.length * 0.9));
    if (nextLength >= rendered.length) {
      break;
    }
    rendered = rendered.slice(0, nextLength) + marker;
  }
  notes.push("hard truncation applied after deterministic field compression");
  return {
    digestMarkdown: rendered,
    tokenCount: estimateTokens(rendered),
    originalTokenCount,
    compressed: true,
    compressionNotes: notes,
  };
}
