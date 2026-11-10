import fs from "node:fs";
import path from "node:path";
import { NyxError } from "./errors.ts";
import { getNyxHomeLayout } from "./paths.ts";

export type HostId = "opencode";

export type GatePolicy = "required" | "auto" | "off";

export interface NyxConfig {
  version: 1;
  preferredHost: HostId | null;
  baseBranch: string;
  protectedBranches: string[];
  worktreeRoot: "auto" | "external" | "in-repo";
  commands: {
    typecheck: string | null;
    lint: string | null;
    test: string | null;
    build: string | null;
    /** Coverage test command (e.g. "npm run test:coverage"); CI parity default: from CI or package script. */
    coverage: string | null;
    /** Skills vendor verification command (e.g. "npm run skills:verify"). Default: null. */
    skills: string | null;
    /** Agent readiness test command (e.g. "npm run test:agents"). Default: null. */
    agents: string | null;
    /**
     * Browser/e2e test command (e.g. "npm run test:e2e"). When set (or when the
     * project exposes a test:e2e/e2e package script), nyx_verify_slice exercises
     * the running surface in addition to the code steps. Default: null.
     */
    e2e: string | null;
    /**
     * App start command launched with provisioned env on an isolated loopback
     * port before the e2e command runs (e.g. "node server.js"). Default: null —
     * the e2e command then owns its own server lifecycle.
     */
    browser: string | null;
  };
  provision: {
    install: "auto" | "off";
    linkEnv: boolean;
  };
  gates: {
    verify: GatePolicy;
    seam: GatePolicy;
    slop: GatePolicy;
    exploit: GatePolicy;
  };
  slop: {
    scope: "diff" | "full";
    disable: string[];
    advisoryAsBlocking: boolean;
  };
  github: {
    mode: "auto" | "app" | "gh" | "local";
    attribution: "coauthor" | "none";
    appId: string | null;
  };
  budgets: {
    maxToolOutputTokens: number;
    subagentSummaryTokens: number;
    handoffTokens: number;
    agentPromptTokens: number;
    maxToolCallsPerTask: number;
    /** Per-tool absolute overrides for maxToolOutputTokens. */
    toolOutputOverrides: Record<string, number>;
    /** Per-caller-role absolute overrides for maxToolOutputTokens. */
    roleOutputOverrides: Record<string, number>;
  };
  network: {
    depGuard: "fail-closed" | "warn";
    webFetchAllow: string[];
    webFetchDeny: string[];
    maxQueryChars: number;
  };
  deps: {
    allow: string[];
    deny: string[];
  };
  probe: {
    allowedHosts: string[];
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export const DEFAULT_CONFIG: NyxConfig = {
  version: 1,
  preferredHost: null,
  baseBranch: "auto",
  protectedBranches: ["main", "master", "production"],
  worktreeRoot: "auto",
  commands: {
    typecheck: null,
    lint: null,
    test: null,
    build: null,
    coverage: null,
    skills: null,
    agents: null,
    e2e: null,
    browser: null,
  },
  provision: {
    install: "auto",
    linkEnv: true,
  },
  gates: {
    verify: "required",
    seam: "required",
    slop: "required",
    exploit: "auto",
  },
  slop: {
    scope: "diff",
    disable: [],
    advisoryAsBlocking: false,
  },
  github: {
    mode: "auto",
    attribution: "coauthor",
    appId: null,
  },
  budgets: {
    maxToolOutputTokens: 6000,
    subagentSummaryTokens: 250,
    handoffTokens: 400,
    agentPromptTokens: 1200,
    maxToolCallsPerTask: 400,
    toolOutputOverrides: {},
    roleOutputOverrides: {},
  },
  network: {
    depGuard: "fail-closed",
    webFetchAllow: [],
    webFetchDeny: [],
    maxQueryChars: 256,
  },
  deps: {
    allow: [],
    deny: [],
  },
  probe: {
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
  },
};

const VALID_HOSTS = new Set<string>(["opencode"]);

const VALID_GATES = new Set<string>(["required", "auto", "off"]);

/**
 * Strips `//` and `/* ... * /` comments outside of string literals, plus trailing commas.
 */
export function parseJsonc<T = unknown>(raw: string, sourceLabel = "config"): T {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Strip trailing commas before } or ]
  const cleaned = out.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new NyxError(
      "ERR_CONFIG_INVALID",
      `Failed to parse JSONC in ${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateAndMergeConfig(
  base: NyxConfig,
  override: Record<string, unknown>,
  sourceLabel: string,
): NyxConfig {
  const next: NyxConfig = structuredClone(base);

  for (const [key, val] of Object.entries(override)) {
    if (key === "$schema" || val === undefined) {
      continue;
    }
    switch (key) {
      case "version": {
        if (val !== 1) {
          throw new NyxError(
            "ERR_CONFIG_INVALID",
            `${sourceLabel}: version must be 1, received ${String(val)}`,
          );
        }
        break;
      }
      case "preferredHost": {
        if (val !== null && (typeof val !== "string" || !VALID_HOSTS.has(val))) {
          throw new NyxError(
            "ERR_CONFIG_INVALID",
            `${sourceLabel}: invalid preferredHost "${String(val)}"`,
          );
        }
        next.preferredHost = val as HostId | null;
        break;
      }
      case "baseBranch": {
        if (typeof val !== "string" || val.trim().length === 0) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: baseBranch must be string`);
        }
        next.baseBranch = val.trim();
        break;
      }
      case "protectedBranches": {
        if (!Array.isArray(val) || !val.every((x) => typeof x === "string")) {
          throw new NyxError(
            "ERR_CONFIG_INVALID",
            `${sourceLabel}: protectedBranches must be string[]`,
          );
        }
        next.protectedBranches = [...val];
        break;
      }
      case "worktreeRoot": {
        if (val !== "auto" && val !== "external" && val !== "in-repo") {
          throw new NyxError(
            "ERR_CONFIG_INVALID",
            `${sourceLabel}: worktreeRoot must be auto | external | in-repo`,
          );
        }
        next.worktreeRoot = val;
        break;
      }
      case "commands": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: commands must be object`);
        }
        const cmdObj = val as Record<string, unknown>;
        for (const k of [
          "typecheck",
          "lint",
          "test",
          "build",
          "coverage",
          "skills",
          "agents",
          "e2e",
          "browser",
        ] as const) {
          if (k in cmdObj && cmdObj[k] !== undefined) {
            const v = cmdObj[k];
            if (v !== null && typeof v !== "string") {
              throw new NyxError(
                "ERR_CONFIG_INVALID",
                `${sourceLabel}: commands.${k} must be string or null`,
              );
            }
            next.commands[k] = v;
          }
        }
        break;
      }
      case "provision": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: provision must be object`);
        }
        const prov = val as Record<string, unknown>;
        if ("install" in prov && prov["install"] !== undefined) {
          if (prov["install"] !== "auto" && prov["install"] !== "off") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: provision.install must be auto | off`,
            );
          }
          next.provision.install = prov["install"];
        }
        if ("linkEnv" in prov && prov["linkEnv"] !== undefined) {
          if (typeof prov["linkEnv"] !== "boolean") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: provision.linkEnv must be boolean`,
            );
          }
          next.provision.linkEnv = prov["linkEnv"];
        }
        break;
      }
      case "gates": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: gates must be object`);
        }
        const gObj = val as Record<string, unknown>;
        for (const k of ["verify", "seam", "slop", "exploit"] as const) {
          if (k in gObj && gObj[k] !== undefined) {
            const v = gObj[k];
            if (typeof v !== "string" || !VALID_GATES.has(v)) {
              throw new NyxError(
                "ERR_CONFIG_INVALID",
                `${sourceLabel}: gates.${k} must be required | auto | off`,
              );
            }
            next.gates[k] = v as GatePolicy;
          }
        }
        break;
      }
      case "slop": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: slop must be object`);
        }
        const sObj = val as Record<string, unknown>;
        if ("scope" in sObj && sObj["scope"] !== undefined) {
          if (sObj["scope"] !== "diff" && sObj["scope"] !== "full") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: slop.scope must be diff | full`,
            );
          }
          next.slop.scope = sObj["scope"];
        }
        if ("disable" in sObj && sObj["disable"] !== undefined) {
          if (!Array.isArray(sObj["disable"]) || !sObj["disable"].every((x) => typeof x === "string")) {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: slop.disable must be string[]`,
            );
          }
          next.slop.disable = [...sObj["disable"]];
        }
        if ("advisoryAsBlocking" in sObj && sObj["advisoryAsBlocking"] !== undefined) {
          if (typeof sObj["advisoryAsBlocking"] !== "boolean") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: slop.advisoryAsBlocking must be boolean`,
            );
          }
          next.slop.advisoryAsBlocking = sObj["advisoryAsBlocking"];
        }
        break;
      }
      case "github": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: github must be object`);
        }
        const ghObj = val as Record<string, unknown>;
        if ("mode" in ghObj && ghObj["mode"] !== undefined) {
          const m = ghObj["mode"];
          if (m !== "auto" && m !== "app" && m !== "gh" && m !== "local") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: github.mode must be auto | app | gh | local`,
            );
          }
          next.github.mode = m;
        }
        if ("attribution" in ghObj && ghObj["attribution"] !== undefined) {
          const a = ghObj["attribution"];
          if (a !== "coauthor" && a !== "none") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: github.attribution must be coauthor | none`,
            );
          }
          next.github.attribution = a;
        }
        if ("appId" in ghObj && ghObj["appId"] !== undefined) {
          const appId = ghObj["appId"];
          if (appId !== null && typeof appId !== "string") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: github.appId must be string or null`,
            );
          }
          next.github.appId = appId;
        }
        break;
      }
      case "budgets": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: budgets must be object`);
        }
        const bObj = val as Record<string, unknown>;
        for (const k of [
          "maxToolOutputTokens",
          "subagentSummaryTokens",
          "handoffTokens",
          "agentPromptTokens",
          "maxToolCallsPerTask",
        ] as const) {
          if (k in bObj && bObj[k] !== undefined) {
            const v = bObj[k];
            if (typeof v !== "number" || !Number.isInteger(v) || v < 10) {
              throw new NyxError(
                "ERR_CONFIG_INVALID",
                `${sourceLabel}: budgets.${k} must be a positive integer >= 10`,
              );
            }
            next.budgets[k] = v;
          }
        }
        for (const k of ["toolOutputOverrides", "roleOutputOverrides"] as const) {
          if (k in bObj && bObj[k] !== undefined) {
            const raw = bObj[k];
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
              throw new NyxError(
                "ERR_CONFIG_INVALID",
                `${sourceLabel}: budgets.${k} must be an object mapping names to positive integer budgets`,
              );
            }
            const merged: Record<string, number> = {};
            for (const [name, num] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof name !== "string" || name.trim().length === 0) {
                throw new NyxError(
                  "ERR_CONFIG_INVALID",
                  `${sourceLabel}: budgets.${k} keys must be non-empty names`,
                );
              }
              if (typeof num !== "number" || !Number.isInteger(num) || num < 10) {
                throw new NyxError(
                  "ERR_CONFIG_INVALID",
                  `${sourceLabel}: budgets.${k}.${name} must be a positive integer >= 10`,
                );
              }
              merged[name] = num;
            }
            next.budgets[k] = merged;
          }
        }
        break;
      }
      case "network": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: network must be object`);
        }
        const nObj = val as Record<string, unknown>;
        if ("depGuard" in nObj && nObj["depGuard"] !== undefined) {
          if (nObj["depGuard"] !== "fail-closed" && nObj["depGuard"] !== "warn") {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: network.depGuard must be fail-closed | warn`,
            );
          }
          next.network.depGuard = nObj["depGuard"];
        }
        if ("webFetchAllow" in nObj && nObj["webFetchAllow"] !== undefined) {
          if (
            !Array.isArray(nObj["webFetchAllow"]) ||
            !nObj["webFetchAllow"].every((x) => typeof x === "string")
          ) {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: network.webFetchAllow must be string[]`,
            );
          }
          next.network.webFetchAllow = [...nObj["webFetchAllow"]];
        }
        if ("webFetchDeny" in nObj && nObj["webFetchDeny"] !== undefined) {
          if (
            !Array.isArray(nObj["webFetchDeny"]) ||
            !nObj["webFetchDeny"].every((x) => typeof x === "string")
          ) {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: network.webFetchDeny must be string[]`,
            );
          }
          next.network.webFetchDeny = [...nObj["webFetchDeny"]];
        }
        if ("maxQueryChars" in nObj && nObj["maxQueryChars"] !== undefined) {
          const v = nObj["maxQueryChars"];
          if (typeof v !== "number" || !Number.isInteger(v) || v < 16) {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: network.maxQueryChars must be integer >= 16`,
            );
          }
          next.network.maxQueryChars = v;
        }
        break;
      }
      case "deps": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: deps must be object`);
        }
        const dObj = val as Record<string, unknown>;
        if ("allow" in dObj && dObj["allow"] !== undefined) {
          if (!Array.isArray(dObj["allow"]) || !dObj["allow"].every((x) => typeof x === "string")) {
            throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: deps.allow must be string[]`);
          }
          next.deps.allow = [...dObj["allow"]];
        }
        if ("deny" in dObj && dObj["deny"] !== undefined) {
          if (!Array.isArray(dObj["deny"]) || !dObj["deny"].every((x) => typeof x === "string")) {
            throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: deps.deny must be string[]`);
          }
          next.deps.deny = [...dObj["deny"]];
        }
        break;
      }
      case "probe": {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: probe must be object`);
        }
        const pObj = val as Record<string, unknown>;
        if ("allowedHosts" in pObj && pObj["allowedHosts"] !== undefined) {
          if (
            !Array.isArray(pObj["allowedHosts"]) ||
            !pObj["allowedHosts"].every((x) => typeof x === "string")
          ) {
            throw new NyxError(
              "ERR_CONFIG_INVALID",
              `${sourceLabel}: probe.allowedHosts must be string[]`,
            );
          }
          next.probe.allowedHosts = [...pObj["allowedHosts"]];
        }
        break;
      }
      default:
        throw new NyxError("ERR_CONFIG_INVALID", `${sourceLabel}: unknown config key "${key}"`);
    }
  }

  return next;
}

export const DEFAULT_NYXOWL_CONFIG = DEFAULT_CONFIG;

export interface LoadConfigOptions {
  projectPath?: string;
  projectRoot?: string;
  nyxHome?: string;
  nyxowlHome?: string;
  cliOverrides?: DeepPartial<NyxConfig>;
}

/**
 * Precedence (§7.4):
 * built-in defaults < ~/.nyxowl/config.json < <repo>/.nyxowl/config.json < CLI flags.
 */
export function loadConfig(options: LoadConfigOptions = {}): NyxConfig {
  let current = structuredClone(DEFAULT_CONFIG);

  const homeLayout = getNyxHomeLayout(options.nyxHome ?? options.nyxowlHome);
  if (fs.existsSync(homeLayout.configPath)) {
    const rawGlobal = fs.readFileSync(homeLayout.configPath, "utf8");
    const parsedGlobal = parseJsonc<Record<string, unknown>>(rawGlobal, homeLayout.configPath);
    current = validateAndMergeConfig(current, parsedGlobal, homeLayout.configPath);
  }

  const projRoot = options.projectPath ?? options.projectRoot;
  if (projRoot) {
    const repoConfigPath = path.join(projRoot, ".nyxowl", "config.json");
    if (fs.existsSync(repoConfigPath)) {
      const rawRepo = fs.readFileSync(repoConfigPath, "utf8");
      const parsedRepo = parseJsonc<Record<string, unknown>>(rawRepo, repoConfigPath);
      current = validateAndMergeConfig(current, parsedRepo, repoConfigPath);
    }
  }

  if (options.cliOverrides) {
    current = validateAndMergeConfig(
      current,
      options.cliOverrides as Record<string, unknown>,
      "cliOverrides",
    );
  }

  return current;
}

export const loadNyxowlConfig = loadConfig;
