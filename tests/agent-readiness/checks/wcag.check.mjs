/** Pure WCAG contrast checks used by the nyx-designer readiness fixture. */

export const AA_CONTRAST_THRESHOLD = 4.5;

function parseHex(hex) {
  const value = String(hex).trim().replace(/^#/, "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    throw new Error(`invalid hex color "${hex}"`);
  }
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
}

function channelLuminance(channel) {
  const sl = channel / 255;
  return sl <= 0.03928 ? sl / 12.92 : ((sl + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function evaluateTokenPairs(pairs, threshold = AA_CONTRAST_THRESHOLD) {
  return pairs
    .map((pair) => {
      const ratio = contrastRatio(pair.fg, pair.bg);
      return {
        code: ratio < threshold ? "CONTRAST_BELOW_AA" : null,
        name: pair.name ?? `${pair.fg}-on-${pair.bg}`,
        fg: pair.fg,
        bg: pair.bg,
        ratio,
        threshold,
        passes: ratio >= threshold,
      };
    })
    .filter((finding) => finding.code !== null);
}

export function run(artifact) {
  const pairs = Array.isArray(artifact?.pairs) ? artifact.pairs : [];
  const muted = pairs.find(
    (pair) =>
      String(pair?.fg).toLowerCase() === "#777777" &&
      String(pair?.bg).toLowerCase() === "#ffffff",
  );
  const errors = [];
  if (!muted) {
    errors.push("missing #777777 on #ffffff pair");
  } else {
    if (muted.passes !== false) errors.push("muted pair must fail AA");
    if (!(Number(muted.ratio) < AA_CONTRAST_THRESHOLD)) {
      errors.push("muted pair ratio must be below 4.5");
    }
  }
  return { ok: errors.length === 0, errors };
}
