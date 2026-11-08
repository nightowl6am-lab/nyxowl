export interface RollbackPlan {
  readonly target: string;
  readonly steps: readonly string[];
}

export function rollbackPlan(target: string): RollbackPlan {
  return {
    target,
    steps: ["stop writers", "restore snapshot", "verify row counts"],
  };
}
