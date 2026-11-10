import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AVAILABLE_MODEL_VARIANTS,
  ERR_MODEL_UNAVAILABLE,
  NYX_MODEL_ROSTER,
  nyxModelPreflightTool,
  resolveModelVariant,
} from "../../src/core/model-preflight.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

let tmpRoot: string;
let nyxHome: string;
let repoPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-model-preflight-"));
  nyxHome = path.join(tmpRoot, "home");
  repoPath = path.join(tmpRoot, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const EXPECTED_ROSTER: Array<[string, string]> = [
  ["nyx-architect", "opencode-go/deepseek-v4.1-flash#high"],
  ["nyx-sec", "opencode-go/deepseek-v4.1-flash#high"],
  ["nyx-api", "opencode-go/glm-5.3-flash#high"],
  ["nyx-db", "opencode-go/glm-5.3-flash#high"],
  ["nyx-probe", "opencode-go/glm-5.3-flash#high"],
  ["nyx-devops", "opencode-go/deepseek-v4.1-flash#high"],
  ["nyx-ui", "opencode-go/deepseek-v4.1-flash#high"],
  ["nyx-designer", "opencode-go/qwen3.8-flash#xhigh"],
  ["nyx-product", "opencode-go/qwen3.8-flash#xhigh"],
  ["nyx-testwriter", "opencode-go/glm-5.3-flash#high"],
];

describe("roster resolution", () => {
  it("resolves every role to its exact roster model and variant (no substitutions)", () => {
    for (const [role, expectedResolved] of EXPECTED_ROSTER) {
      const res = resolveModelVariant({ role });
      expect(res.resolved, role).toBe(expectedResolved);
      expect(res.ok, role).toBe(true);
      expect(res.provider, role).toBe("opencode-go");
      expect(res.availableVariants, role).toEqual(
        res.variant === null
          ? ["none"]
          : AVAILABLE_MODEL_VARIANTS[res.model]!.map((v) => v ?? "none"),
      );
    }
  });

  it("exposes exactly the non-pro model roster strings", () => {
    expect(Object.keys(AVAILABLE_MODEL_VARIANTS).sort()).toEqual([
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "qwen3.8-flash",
    ]);
    expect(AVAILABLE_MODEL_VARIANTS["qwen3.8-flash"]).toEqual([null, "low", "medium", "xhigh"]);
    expect(Object.keys(NYX_MODEL_ROSTER)).toHaveLength(EXPECTED_ROSTER.length);
  });

  it("resolves qwen3.8-flash#xhigh for designer/product without substituting", () => {
    for (const role of ["nyx-designer", "nyx-product"]) {
      const res = resolveModelVariant({ role });
      expect(res.model).toBe("qwen3.8-flash");
      expect(res.variant).toBe("xhigh");
      expect(res.resolved).toBe(`opencode-go/qwen3.8-flash#xhigh`);
    }
  });
});

describe("loud rejections", () => {
  it("rejects an unknown role", () => {
    expect(() => resolveModelVariant({ role: "nyx-intern" })).toThrowError(/nyx-intern/);
  });

  it("rejects the removed pro models with the current model list", () => {
    for (const pro of ["mimo-v2.6-pro", "minimax-m3.1-flash", "qwen3.7-plus"]) {
      try {
        resolveModelVariant({ role: "nyx-probe", model: pro });
        expect.unreachable(`must reject the removed model ${pro}`);
      } catch (err) {
        const details = (err as {
          code?: string;
          details?: { availableModels: string[] };
        }).details;
        expect((err as { code?: string }).code).toBe(ERR_MODEL_UNAVAILABLE);
        expect(details?.availableModels).toEqual([
          "deepseek-v4.1-flash",
          "glm-5.3-flash",
          "qwen3.8-flash",
        ]);
      }
    }
  });

  it("rejects qwen3.8-flash#high and lists none|low|medium|xhigh without substituting", () => {
    try {
      resolveModelVariant({ role: "nyx-designer", model: "qwen3.8-flash", variant: "high" });
      expect.unreachable("must reject an unavailable variant");
    } catch (err) {
      const details = (err as { details?: { availableVariants: string[] } }).details;
      expect(details?.availableVariants).toEqual(["none", "low", "medium", "xhigh"]);
      const message = (err as { message: string }).message;
      expect(message).toContain("qwen3.8-flash");
      expect(message).not.toContain("qwen3.7-plus");
      expect(message).toContain("none | low | medium | xhigh");
      expect((err as { code?: string }).code).toBe(ERR_MODEL_UNAVAILABLE);
    }
  });

  it("rejects an unknown model entirely", () => {
    try {
      resolveModelVariant({ role: "nyx-api", model: "glmfake-9" });
      expect.unreachable("must reject an unavailable model");
    } catch (err) {
      const details = (err as { details?: { availableModels: string[] } }).details;
      expect(details?.availableModels).toContain("glm-5.3-flash");
      expect((err as { code?: string }).code).toBe(ERR_MODEL_UNAVAILABLE);
    }
  });

  it("rejects a variant-free request for a role that mandates a variant", () => {
    try {
      resolveModelVariant({ role: "nyx-api", variant: "low" });
      expect.unreachable("roster mandates #high for nyx-api");
    } catch (err) {
      expect((err as { details?: { expectedResolved: string } }).details?.expectedResolved).toBe(
        "opencode-go/glm-5.3-flash#high",
      );
    }
  });
});

describe("nyx_model_preflight tool", () => {
  it("exposes a schema-valid preflight tool via invokeToolDefinition", async () => {
    const response = await invokeToolDefinition(
      nyxModelPreflightTool,
      { role: "nyx-designer" },
      { nyxHome, defaultProjectPath: repoPath },
    );
    expect(response.isError).toBeFalsy();
    const structured = response.structuredContent as Record<string, unknown>;
    const parsed = nyxModelPreflightTool.outputSchema.safeParse(structured);
    expect(parsed.success).toBe(true);
    expect(structured["resolved"]).toBe("opencode-go/qwen3.8-flash#xhigh");
    expect(structured["ok"]).toBe(true);
    expect(structured["availableVariants"]).toEqual(["none", "low", "medium", "xhigh"]);
  });

  it("surfaces ERR_MODEL_UNAVAILABLE with unknown-model details removed from the roster", async () => {
    const response = await invokeToolDefinition(
      nyxModelPreflightTool,
      { role: "nyx-testwriter", model: "mimo-v2.6-pro" },
      { nyxHome, defaultProjectPath: repoPath },
    );
    expect(response.isError).toBe(true);
    const structured = response.structuredContent as Record<string, unknown>;
    expect(structured["code"]).toBe(ERR_MODEL_UNAVAILABLE);
    const details = structured["details"] as { availableModels?: string[] };
    expect(details["availableModels"]).toEqual([
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "qwen3.8-flash",
    ]);
    expect(structured["message"]).toContain("mimo-v2.6-pro");
  });

  it("surfaces ERR_MODEL_UNAVAILABLE with variant details through the tool error path", async () => {
    const response = await invokeToolDefinition(
      nyxModelPreflightTool,
      { role: "nyx-designer", model: "qwen3.8-flash", variant: "high" },
      { nyxHome, defaultProjectPath: repoPath },
    );
    expect(response.isError).toBe(true);
    const structured = response.structuredContent as Record<string, unknown>;
    expect(structured["code"]).toBe(ERR_MODEL_UNAVAILABLE);
    const details = structured["details"] as { availableVariants?: string[] };
    expect(details["availableVariants"]).toEqual(["none", "low", "medium", "xhigh"]);
    expect(structured["message"]).toContain("none | low | medium | xhigh");
  });
});
