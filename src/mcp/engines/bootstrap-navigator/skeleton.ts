import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { estimateTokens } from "../../../core/tokens.ts";
import { defineTool } from "../../tool.ts";
import { extractWasmSkeleton } from "./wasm-extractor.ts";

export interface SymbolSkeletonItem {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "method" | "struct" | "enum";
  signature: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

/** Hard cap on file bytes read into the skeleton pipeline (2 MiB). */
export const MAX_SKELETON_FILE_BYTES = 2 * 1024 * 1024;
/** Hard cap on lines in a skeleton source file. */
export const MAX_SKELETON_LINES = 50_000;
/** FIFO bound on cached skeletons to prevent unbounded memory growth. */
export const MAX_SKELETON_CACHE_ENTRIES = 256;

const skeletonCache = new Map<
  string,
  { symbols: SymbolSkeletonItem[]; outlineText: string }
>();

export function clearSkeletonCache(): void {
  skeletonCache.clear();
}

export function getSkeletonCacheSize(): number {
  return skeletonCache.size;
}

function cacheSkeleton(
  cacheKey: string,
  value: { symbols: SymbolSkeletonItem[]; outlineText: string },
): void {
  skeletonCache.set(cacheKey, value);
  if (skeletonCache.size > MAX_SKELETON_CACHE_ENTRIES) {
    const oldest = skeletonCache.keys().next().value;
    if (oldest !== undefined) skeletonCache.delete(oldest);
  }
}

function extractTsJsSkeleton(filePath: string, sourceText: string): SymbolSkeletonItem[] {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const symbols: SymbolSkeletonItem[] = [];

  const getLine = (pos: number): number =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;

  const hasExportModifier = (node: ts.Node): boolean => {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  };

  const compactSignature = (text: string): string =>
    text.replace(/\s+/g, " ").trim().slice(0, 140);

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const startLine = getLine(node.getStart(sf));
      const endLine = getLine(node.getEnd());
      const bodyStart = node.body ? node.body.getStart(sf) : node.getEnd();
      const rawSig = sourceText.slice(node.getStart(sf), bodyStart).trim();
      symbols.push({
        name: node.name.text,
        kind: "function",
        signature: compactSignature(rawSig),
        startLine,
        endLine,
        exported: hasExportModifier(node),
      });
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const startLine = getLine(node.getStart(sf));
      const endLine = getLine(node.getEnd());
      const exported = hasExportModifier(node);
      symbols.push({
        name: node.name.text,
        kind: "class",
        signature: `${exported ? "export " : ""}class ${node.name.text}`,
        startLine,
        endLine,
        exported,
      });

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const mStart = getLine(member.getStart(sf));
          const mEnd = getLine(member.getEnd());
          const mBodyStart = member.body ? member.body.getStart(sf) : member.getEnd();
          const mSig = sourceText.slice(member.getStart(sf), mBodyStart).trim();
          symbols.push({
            name: `${node.name.text}.${member.name.getText(sf)}`,
            kind: "method",
            signature: compactSignature(mSig),
            startLine: mStart,
            endLine: mEnd,
            exported,
          });
        }
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const startLine = getLine(node.getStart(sf));
      const endLine = getLine(node.getEnd());
      const exported = hasExportModifier(node);
      symbols.push({
        name: node.name.text,
        kind: "interface",
        signature: `${exported ? "export " : ""}interface ${node.name.text}`,
        startLine,
        endLine,
        exported,
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const startLine = getLine(node.getStart(sf));
      const endLine = getLine(node.getEnd());
      const exported = hasExportModifier(node);
      symbols.push({
        name: node.name.text,
        kind: "type",
        signature: `${exported ? "export " : ""}type ${node.name.text}`,
        startLine,
        endLine,
        exported,
      });
      return;
    }

    if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const startLine = getLine(node.getStart(sf));
          const endLine = getLine(node.getEnd());
          const isArrowOrFn =
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer));
          symbols.push({
            name: decl.name.text,
            kind: isArrowOrFn ? "function" : "const",
            signature: `${exported ? "export " : ""}const ${decl.name.text}`,
            startLine,
            endLine,
            exported,
          });
        }
      }
    }
  };

  ts.forEachChild(sf, visit);
  return symbols;
}

function extractPolyglotSkeleton(filePath: string, sourceText: string): SymbolSkeletonItem[] {
  const lines = sourceText.split(/\r?\n/);
  const symbols: SymbolSkeletonItem[] = [];
  const ext = path.extname(filePath).toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const startLine = i + 1;

    if (ext === ".py") {
      const pyMatch = /^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?(?:\s*->\s*[^:]+)?:/.exec(
        trimmed,
      );
      if (pyMatch && pyMatch[1] && pyMatch[2]) {
        const indent = line.search(/\S|$/);
        let endLine = startLine;
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]!;
          if (next.trim().length === 0 || next.trim().startsWith("#")) continue;
          const nextIndent = next.search(/\S|$/);
          if (nextIndent <= indent) break;
          endLine = j + 1;
        }
        symbols.push({
          name: pyMatch[2],
          kind: pyMatch[1] === "class" ? "class" : "function",
          signature: trimmed.slice(0, 120),
          startLine,
          endLine,
          exported: !pyMatch[2].startsWith("_"),
        });
      }
      continue;
    }

    if (ext === ".go") {
      const goMatch = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^{]*/.exec(trimmed);
      const goTypeMatch = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/.exec(trimmed);
      if (goMatch && goMatch[1]) {
        let endLine = startLine;
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]!) {
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
          endLine = j + 1;
          if (j > i && depth <= 0) break;
        }
        const name = goMatch[1];
        symbols.push({
          name,
          kind: "function",
          signature: trimmed.replace(/\s*\{$/, "").slice(0, 120),
          startLine,
          endLine,
          exported: /^[A-Z]/.test(name),
        });
      } else if (goTypeMatch && goTypeMatch[1] && goTypeMatch[2]) {
        let endLine = startLine;
        for (let j = i + 1; j < lines.length; j++) {
          endLine = j + 1;
          if (lines[j]!.trim().startsWith("}")) break;
        }
        const name = goTypeMatch[1];
        symbols.push({
          name,
          kind: goTypeMatch[2] === "interface" ? "interface" : "struct",
          signature: `${goTypeMatch[2]} ${name}`,
          startLine,
          endLine,
          exported: /^[A-Z]/.test(name),
        });
      }
      continue;
    }

    // Rust / Java / C# / Ruby / PHP fallback outline
    const genericMatch =
      /^(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait|class|interface|function)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        trimmed,
      );
    if (genericMatch && genericMatch[1] && genericMatch[2]) {
      let endLine = startLine;
      for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
        endLine = j + 1;
        if (/^(?:\}|end\b)/.test(lines[j]!.trim())) break;
      }
      symbols.push({
        name: genericMatch[2],
        kind:
          genericMatch[1] === "struct"
            ? "struct"
            : genericMatch[1] === "enum"
              ? "enum"
              : genericMatch[1] === "class"
                ? "class"
                : genericMatch[1] === "interface" || genericMatch[1] === "trait"
                  ? "interface"
                  : "function",
        signature: trimmed.replace(/\s*\{$/, "").slice(0, 120),
        startLine,
        endLine,
        exported: trimmed.startsWith("pub ") || trimmed.startsWith("export "),
      });
    }
  }

  return symbols;
}

export async function computeFileSkeleton(filePath: string): Promise<{
  symbols: SymbolSkeletonItem[];
  outlineText: string;
  originalTokens: number;
  skeletonTokens: number;
  reductionRatio: number;
}> {
  const absFile = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absFile);
  } catch {
    throw new NyxError("ERR_INVALID_INPUT", `File "${absFile}" does not exist`);
  }
  if (!stat.isFile()) {
    throw new NyxError("ERR_INVALID_INPUT", `File "${absFile}" does not exist`);
  }
  if (stat.size > MAX_SKELETON_FILE_BYTES) {
    throw new NyxError(
      "ERR_FILE_TOO_LARGE",
      `File "${absFile}" is ${stat.size} bytes, exceeding the ${MAX_SKELETON_FILE_BYTES}-byte skeleton limit.`,
    );
  }

  const sourceText = fs.readFileSync(absFile, "utf8");
  if (sourceText.split(/\r?\n/).length > MAX_SKELETON_LINES) {
    throw new NyxError(
      "ERR_FILE_TOO_LARGE",
      `File "${absFile}" exceeds the ${MAX_SKELETON_LINES}-line skeleton limit.`,
    );
  }
  const ext = path.extname(absFile).toLowerCase();
  const contentHash = crypto.createHash("sha256").update(sourceText).digest("hex");
  // Identical bytes can mean different things per language (e.g. the same text
  // parsed as Python for `.py` and by the legacy regex outline for `.txt`), so
  // the extension is part of the key to prevent cross-extractor collisions.
  const cacheKey = `${ext}:${contentHash}`;

  const cached = skeletonCache.get(cacheKey);
  const originalTokens = Math.max(1, estimateTokens(sourceText));

  if (cached) {
    const skeletonTokens = estimateTokens(cached.outlineText);
    return {
      symbols: cached.symbols,
      outlineText: cached.outlineText,
      originalTokens,
      skeletonTokens,
      reductionRatio: Number(((1 - skeletonTokens / originalTokens) * 100).toFixed(2)),
    };
  }

  const isTsJs = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext);
  const isWasmLanguage = [".py", ".go", ".rs"].includes(ext);

  let symbols: SymbolSkeletonItem[];
  if (isTsJs) {
    symbols = extractTsJsSkeleton(absFile, sourceText);
  } else if (isWasmLanguage) {
    // Prefer the tree-sitter skeleton, but keep the legacy outline when a
    // grammar is unavailable or yields no symbols for a file it can outline.
    const legacySymbols = extractPolyglotSkeleton(absFile, sourceText);
    const wasmSymbols = await extractWasmSkeleton(absFile, sourceText);
    symbols =
      wasmSymbols && (wasmSymbols.length > 0 || legacySymbols.length === 0)
        ? wasmSymbols
        : legacySymbols;
  } else {
    symbols = extractPolyglotSkeleton(absFile, sourceText);
  }

  const outlineLines = symbols.map(
    (s) => `L${s.startLine}-L${s.endLine}: ${s.signature}`,
  );
  const outlineText = outlineLines.join("\n");
  cacheSkeleton(cacheKey, { symbols, outlineText });

  const skeletonTokens = estimateTokens(outlineText);
  const reductionRatio = Number(((1 - skeletonTokens / originalTokens) * 100).toFixed(2));

  return {
    symbols,
    outlineText,
    originalTokens,
    skeletonTokens,
    reductionRatio,
  };
}

export const symbolSkeletonInputSchema = z.object({
  filePath: z.string().min(1),
  repoPath: z.string().optional(),
});

export const symbolSkeletonOutputSchema = z.object({
  filePath: z.string(),
  originalTokens: z.number().int(),
  skeletonTokens: z.number().int(),
  reductionPercent: z.number(),
  outline: z.string(),
  symbols: z.array(
    z.object({
      name: z.string(),
      kind: z.enum([
        "function",
        "class",
        "interface",
        "type",
        "const",
        "method",
        "struct",
        "enum",
      ]),
      signature: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      exported: z.boolean(),
    }),
  ),
});

export const nyxSymbolSkeletonTool = defineTool({
  name: "nyx_symbol_skeleton",
  description: "Returns surgical AST symbol signatures with L<start>-L<end> line ranges (>=80% token reduction).",
  annotations: {
    title: "Surgical Symbol Skeleton",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: symbolSkeletonInputSchema,
  outputSchema: symbolSkeletonOutputSchema,
  handler: async (input) => {
    const res = await computeFileSkeleton(input.filePath);
    return {
      filePath: input.filePath,
      originalTokens: res.originalTokens,
      skeletonTokens: res.skeletonTokens,
      reductionPercent: res.reductionRatio,
      outline: res.outlineText,
      symbols: res.symbols,
    };
  },
});
