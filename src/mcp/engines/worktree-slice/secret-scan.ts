import { execCommand } from "../../../core/exec.ts";

export interface SecretFinding {
  ruleId: string;
  filePath: string;
  line: number;
  snippet: string;
}

const SECRET_SCAN_RULES: Array<{ id: string; regex: RegExp }> = [
  {
    id: "pem-private-key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: "github-token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}\b|\bgithub_pat_[A-Za-z0-9_]{50,255}\b/,
  },
  {
    id: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "gcp-api-key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
  },
  {
    id: "stripe-key",
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,99}\b/,
  },
  {
    id: "slack-token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,250}\b/,
  },
  {
    id: "ai-api-key",
    regex: /\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{16,200}\b/,
  },
  {
    id: "url-with-credentials",
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^@\s/]{4,}@[^\s/"']+/i,
  },
  {
    id: "hardcoded-secret-assignment",
    regex: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|db[_-]?password|database[_-]?password)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i,
  },
];

export function scanContentForSecrets(content: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of SECRET_SCAN_RULES) {
      if (rule.regex.test(line)) {
        findings.push({
          ruleId: rule.id,
          filePath,
          line: i + 1,
          snippet: line.slice(0, 80).replace(/[A-Za-z0-9]{8,}/g, "***"),
        });
      }
    }
  }
  return findings;
}

/**
 * Scans added lines in `git diff <baseRef>...HEAD` for planted secrets (§1.1.5, §6 Engine 4).
 */
export async function scanDiffForSecrets(
  worktreePath: string,
  baseRef: string,
): Promise<SecretFinding[]> {
  const diffRes = await execCommand(
    "git",
    ["diff", "--unified=0", `${baseRef}...HEAD`],
    { cwd: worktreePath, timeoutMs: 20_000 },
  );

  const rawDiff =
    diffRes.exitCode === 0
      ? diffRes.stdout
      : (
          await execCommand("git", ["diff", "--unified=0", baseRef], {
            cwd: worktreePath,
            timeoutMs: 20_000,
          })
        ).stdout;

  const findings: SecretFinding[] = [];
  let currentFile = "unknown";
  let currentLine = 0;

  for (const line of rawDiff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /\+(\d+)/.exec(line);
      if (match && match[1]) {
        currentLine = Number.parseInt(match[1], 10) - 1;
      }
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine++;
      const addedLine = line.slice(1);
      for (const rule of SECRET_SCAN_RULES) {
        if (rule.regex.test(addedLine)) {
          findings.push({
            ruleId: rule.id,
            filePath: currentFile,
            line: currentLine,
            snippet: addedLine.slice(0, 80).replace(/[A-Za-z0-9]{8,}/g, "***"),
          });
        }
      }
    }
  }

  return findings;
}
