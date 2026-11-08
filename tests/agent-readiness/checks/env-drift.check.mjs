/** .env.example vs config-source key drift (nyx-devops readiness fixture). */

const EXAMPLE_KEY = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm;
const CONFIG_KEY = /\b(?:process\.env|env)(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g;

function exampleKeys(text) {
  return new Set([...String(text).matchAll(EXAMPLE_KEY)].map((match) => match[1]));
}

function configKeys(source) {
  const keys = new Set();
  for (const match of String(source).matchAll(CONFIG_KEY)) {
    keys.add(match[1] ?? match[2]);
  }
  return keys;
}

export function diffEnvKeys(exampleText, configSource) {
  const expected = exampleKeys(exampleText);
  const used = configKeys(configSource);
  const missing = [...expected].filter((key) => !used.has(key)).sort();
  const extra = [...used].filter((key) => !expected.has(key)).sort();
  return { missing, extra };
}

export function run(artifact) {
  const missing = Array.isArray(artifact?.missing) ? artifact.missing : [];
  const extra = Array.isArray(artifact?.extra) ? artifact.extra : [];
  const errors = [];
  if (!missing.includes("FEATURE_X")) errors.push("missing must include FEATURE_X");
  if (!extra.includes("FEATURE_Y")) errors.push("extra must include FEATURE_Y");
  return { ok: errors.length === 0, errors };
}
