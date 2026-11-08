export function flakyValue(seed) {
  return seed === 1 ? "alpha" : "beta";
}

export function stableValue(_seed) {
  return "stable";
}
