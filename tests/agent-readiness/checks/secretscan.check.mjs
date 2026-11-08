/** Inert secret scanner used by the nyx-sec readiness fixture. */

const PATTERNS = [
  { code: "NYX_SEC_CANARY", regex: /NYX-SEC-CANARY-[A-F0-9]{16}/g },
  { code: "RSA_PRIVATE_KEY", regex: /BEGIN RSA PRIVATE KEY/g },
  { code: "GITHUB_TOKEN", regex: /ghp_[A-Za-z0-9]{36}/g },
];

export function scanSecrets(text) {
  const findings = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    const matches = String(text).match(pattern.regex);
    if (matches) {
      findings.push({ code: pattern.code, count: matches.length });
    }
  }
  return findings;
}

export function run(artifact) {
  const findings = Array.isArray(artifact?.findings) ? artifact.findings : [];
  const errors = [];
  if (!findings.some((finding) => finding?.code === "NYX_SEC_CANARY")) {
    errors.push("missing NYX_SEC_CANARY finding");
  }
  if (!findings.some((finding) => finding?.code === "AUTHZ_MISSING_OWNER_SCOPE")) {
    errors.push("missing AUTHZ_MISSING_OWNER_SCOPE finding");
  }
  return { ok: errors.length === 0, errors };
}
