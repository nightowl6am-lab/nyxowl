/** Seed-replay flake detector (nyx-probe readiness fixture). */

export const DEFAULT_SEEDS = [1, 2];

export function detectFlake(fn, seeds = DEFAULT_SEEDS) {
  const outputs = seeds.map((seed) => {
    const value = fn(seed);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  const distinct = new Set(outputs);
  if (distinct.size <= 1) return [];
  return [
    {
      code: "FLAKE_DIVERGENCE",
      seeds: [...seeds],
      outputs,
    },
  ];
}

export function run(artifact) {
  const errors = [];
  if (artifact?.diverges !== true) errors.push("diverges must be true");
  const seeds = Array.isArray(artifact?.seeds) ? artifact.seeds : [];
  if (!seeds.includes(1) || !seeds.includes(2)) errors.push("seeds must include 1 and 2");
  return { ok: errors.length === 0, errors };
}
