/** Loading/empty/error/aria-live/focus-visible state audit (nyx-ui fixture). */

const STATE_PATTERNS = {
  loading: /\bloading\b|isLoading/i,
  empty: /\bempty\b|no results/i,
  error: /\berror\b|isError/i,
  "aria-live": /aria-live/i,
  "focus-visible": /focus-visible/i,
};

export function analyzeUiState(source) {
  const text = String(source);
  const checks = {};
  const missing = [];
  for (const [state, pattern] of Object.entries(STATE_PATTERNS)) {
    const present = pattern.test(text);
    checks[state] = present;
    if (!present) missing.push(state);
  }
  return { checks, missing };
}

export function run(artifact) {
  const missing = Array.isArray(artifact?.missing) ? artifact.missing : [];
  const errors = [];
  if (!missing.includes("error")) errors.push("missing must include error state");
  return { ok: errors.length === 0, errors };
}
