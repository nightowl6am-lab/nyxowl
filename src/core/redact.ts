import fs from "node:fs";
import path from "node:path";

const SAFE_ENV_FILENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);

const KNOWN_SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "PEM_PRIVATE_KEY",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    name: "GITHUB_TOKEN",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}\b|\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g,
  },
  {
    name: "AWS_ACCESS_KEY",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "GCP_API_KEY",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  {
    name: "STRIPE_KEY",
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,99}\b/g,
  },
  {
    name: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,250}\b/g,
  },
  {
    name: "AI_API_KEY",
    regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,200}\b/g,
  },
  {
    name: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: "URL_CREDENTIALS",
    regex: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@[^\s/]+)/g,
  },
];

const KEY_VALUE_SECRET_REGEX =
  /\b((?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|database[_-]?url|db[_-]?password)[A-Za-z0-9_-]*\s*[:=]\s*["']?)([^\s"',;]{8,})(["']?)/gi;

export function isSecretEnvFileName(fileName: string): boolean {
  const base = path.basename(fileName);
  if (SAFE_ENV_FILENAMES.has(base)) {
    return false;
  }
  return base === ".env" || base.startsWith(".env.");
}

export function parseDotEnvEntries(content: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = cleaned.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = cleaned.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    entries.push({ key, value });
  }
  return entries;
}

const NON_SECRET_LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "development",
  "production",
  "test",
  "staging",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

export class Redactor {
  private readonly exactValues: string[];

  constructor(secretValues: Iterable<string> = []) {
    const unique = new Set<string>();
    for (const val of secretValues) {
      const trimmed = val.trim();
      if (trimmed.length >= 4 && !NON_SECRET_LITERALS.has(trimmed.toLowerCase())) {
        unique.add(trimmed);
      }
    }
    // Sort longest first so substring secrets don't partially clobber longer secrets
    this.exactValues = [...unique].sort((a, b) => b.length - a.length);
  }

  public static fromDirectories(dirs: string[]): Redactor {
    const values: string[] = [];
    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) {
        continue;
      }
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() && !entry.isSymbolicLink()) {
            continue;
          }
          if (!isSecretEnvFileName(entry.name)) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          const content = fs.readFileSync(fullPath, "utf8");
          for (const parsed of parseDotEnvEntries(content)) {
            if (parsed.value.length >= 4) {
              values.push(parsed.value);
            }
          }
        }
      } catch {
        // Ignore unreadable directory
      }
    }
    return new Redactor(values);
  }

  public redact(input: string): string {
    if (!input) {
      return input;
    }
    let out = input;

    // 1. Exact loaded .env values (plus base64 and URL-encoded forms)
    for (const secret of this.exactValues) {
      if (out.includes(secret)) {
        out = out.split(secret).join("[REDACTED:ENV_SECRET]");
      }
      const b64 = Buffer.from(secret, "utf8").toString("base64");
      if (b64.length >= 8 && out.includes(b64)) {
        out = out.split(b64).join("[REDACTED:ENV_SECRET_B64]");
      }
      const urlEnc = encodeURIComponent(secret);
      if (urlEnc !== secret && urlEnc.length >= 6 && out.includes(urlEnc)) {
        out = out.split(urlEnc).join("[REDACTED:ENV_SECRET_URL]");
      }
    }

    // 2. Known token & credential formats
    for (const pattern of KNOWN_SECRET_PATTERNS) {
      if (pattern.name === "URL_CREDENTIALS") {
        out = out.replace(pattern.regex, "$1[REDACTED:URL_CREDENTIAL]$3");
      } else {
        out = out.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
      }
    }

    // 3. Key-value secret assignments
    out = out.replace(
      KEY_VALUE_SECRET_REGEX,
      (_match, prefix: string, val: string, suffix: string) => {
        if (val.startsWith("[REDACTED:")) {
          return `${prefix}${val}${suffix}`;
        }
        return `${prefix}[REDACTED:SECRET_VALUE]${suffix}`;
      },
    );

    return out;
  }

  public redactObject<T>(value: T): T {
    if (typeof value === "string") {
      return this.redact(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactObject(item)) as unknown as T;
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.redactObject(v);
      }
      return result as T;
    }
    return value;
  }
}
