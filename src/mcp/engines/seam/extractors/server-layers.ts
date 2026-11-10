import fs from "node:fs";
import path from "node:path";
import { maskJsComments } from "./index.ts";

/**
 * Server-side seam candidates: functions that run on the server but are
 * reachable from the client. Before this extractor the seam engine was blind
 * to them — Next.js server actions, Remix loaders and server-side data loaders
 * (getServerSideProps / getStaticProps / server components) are API surfaces,
 * yet none of them contributed API or call candidates to the seam graph.
 */
export type ServerCandidateKind = "server-action" | "loader";

export interface ServerCandidate {
  kind: ServerCandidateKind;
  name: string;
  filePath: string;
  line: number;
}

const FILE_SUFFIX_RE = /\.(?:tsx?|jsx?|mjs)$/;

const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

function readSourceFile(fullPath: string): string | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) return null;
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
}

function isScannableFile(rel: string): boolean {
  return (
    FILE_SUFFIX_RE.test(rel) &&
    !/(?:\.test|\.spec)\.|(?:^|\/)(?:tests?|__tests__)\/|\/\.next\//i.test(rel)
  );
}

function lineNumberForOffset(masked: string, matchIndex: number): number {
  let line = 1;
  const bounded = Math.min(matchIndex, masked.length);
  for (let i = 0; i < bounded; i++) {
    if (masked[i] === "\n") line++;
  }
  return line;
}

function addCandidate(
  candidates: ServerCandidate[],
  seen: Set<string>,
  filePath: string,
  kind: ServerCandidateKind,
  name: string,
  masked: string,
  matchIndex: number,
): void {
  const key = `${kind}:${filePath}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    kind,
    name,
    filePath,
    line: lineNumberForOffset(masked, matchIndex),
  });
}

/**
 * Extracts server actions ("use server" files and inline directives) and
 * server-side data loaders (getServerSideProps / getStaticProps, Remix-style
 * `loader` functions, and Next.js App Router server components that fetch or
 * query data). These candidates represent the server-side API surface and are
 * reported so seam coverage stays honest.
 */
export function extractServerCandidates(worktreePath: string, relFiles: string[]): ServerCandidate[] {
  const candidates: ServerCandidate[] = [];
  const seen = new Set<string>();

  for (const rel of relFiles) {
    if (!isScannableFile(rel)) continue;
    const full = path.join(worktreePath, rel);
    const text = readSourceFile(full);
    if (text === null) continue;

    const masked = maskJsComments(text);
    const normRel = rel.replace(/\\/g, "/");

    // 1. Server actions: whole-file "use server" directive or inline
    //    "use server" inside an (async) function body.
    if (/["']use server["']\s*;?/.test(masked)) {
      const exportedFn =
        /export\s+(?:default\s+)?async\s+function\s+([A-Za-z_$][\w$]*)/g;
      let m: RegExpExecArray | null;
      while ((m = exportedFn.exec(masked)) !== null) {
        if (m[1] && m.index !== undefined) {
          addCandidate(candidates, seen, rel, "server-action", m[1], masked, m.index);
        }
      }

      const exportedConst = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*async/g;
      while ((m = exportedConst.exec(masked)) !== null) {
        if (m[1] && m.index !== undefined) {
          addCandidate(candidates, seen, rel, "server-action", m[1], masked, m.index);
        }
      }

      const inlineAction =
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)[^{]*\{\s*["']use server["']\s*;?/g;
      while ((m = inlineAction.exec(masked)) !== null) {
        if (m[1] && m.index !== undefined) {
          addCandidate(candidates, seen, rel, "server-action", m[1], masked, m.index);
        }
      }
    }

    // 2. Data loaders: getServerSideProps / getStaticProps in Pages Router,
    //    Remix-style exported `loader` functions.
    const loaderRe =
      /export\s+(?:default\s+)?(?:async\s+)?function\s+(getServerSideProps|getStaticProps|loader)\s*\(/g;
    let lm: RegExpExecArray | null;
    while ((lm = loaderRe.exec(masked)) !== null) {
      const name = lm[1];
      if (name) addCandidate(candidates, seen, rel, "loader", name, masked, lm.index);
    }

    const loaderConst = /export\s+const\s+loader\s*=\s*async/g;
    while ((lm = loaderConst.exec(masked)) !== null) {
      if (lm.index !== undefined) {
        addCandidate(candidates, seen, rel, "loader", "loader", masked, lm.index);
      }
    }

    // 3. Next.js App Router server components (page/layout) that fetch or
    //    query data server-side. "use client" files are excluded.
    const appComponentMatch =
      /(?:^|\/)(?:src\/)?app(?:\/.*)?\/(?:page|layout)\.(?:tsx|jsx|ts|js)$/.exec(normRel);
    if (appComponentMatch && !/["']use client["']/.test(masked)) {
      const doesServerData =
        /\bawait\b/.test(masked) &&
        /\b(?:fetch\s*\(|prisma\.|db\.|supabase|\.from\s*\(|\.rpc\s*\(|query\s*\()/.test(masked);
      if (doesServerData) {
        addCandidate(candidates, seen, rel, "loader", "default", masked, 0);
      }
    }
  }

  return candidates;
}

/**
 * Classifies extracted server candidates into supported-but-unchecked layers.
 * These layers are supported (we detect them) but their client-invocation seam
 * is not yet cross-checked, so they must be reported as unsupported instead of
 * silently appearing as absent.
 */
export function serverCandidateSummary(
  candidates: ServerCandidate[],
): { layer: string; reason: string }[] {
  const actions = candidates.filter((candidate) => candidate.kind === "server-action");
  const loaders = candidates.filter((candidate) => candidate.kind === "loader");

  const summary: { layer: string; reason: string }[] = [];
  if (actions.length > 0) {
    summary.push({
      layer: "server-actions",
      reason: `${actions.length} server action(s) ("use server") detected; cross-checking client invocations of server actions is unsupported`,
    });
  }
  if (loaders.length > 0) {
    summary.push({
      layer: "server-loaders",
      reason: `${loaders.length} server-side data loader(s) or server component(s) detected; cross-checking loader call candidates is unsupported, DB queries from loaders are still checked via the db-query seam`,
    });
  }
  return summary;
}
