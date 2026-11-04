declare module "semver" {
  export function valid(version: string | null | undefined): string | null;
  export function gte(v1: string, v2: string): boolean;
  export function lt(v1: string, v2: string): boolean;
  export function major(v: string): number;
  export function minor(v: string): number;
  export function patch(v: string): number;
  export function satisfies(version: string, range: string): boolean;
}
