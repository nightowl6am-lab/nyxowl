import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/core/config.ts";
import { computeRepoId } from "../../src/core/git.ts";
import { getProjectLayout } from "../../src/core/paths.ts";
import { nyxArtifactReadTool } from "../../src/mcp/engines/context/artifacts.ts";
import {
  defineTool,
  invokeToolDefinition,
  resolveToolOutputBudget,
} from "../../src/mcp/tool.ts";

let tmpRoot: string;
let nyxHome: string;
let repoPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-tool-trunc-"));
  nyxHome = path.join(tmpRoot, "home");
  repoPath = path.join(tmpRoot, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setBudgetConfig(budgets: Record<string, unknown>): void {
  fs.mkdirSync(path.join(repoPath, ".nyxowl"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, ".nyxowl", "config.json"),
    JSON.stringify({ version: 1, budgets }),
    "utf8",
  );
}

function makeHeavyTool(items: string[]) {
  // Strict schema: any _truncated/_overflowArtifactId pollution in
  // structuredContent must fail outputSchema validation (the old bug).
  const heavyOutputSchema = z.strictObject({ items: z.array(z.string()) });
  return defineTool({
    name: "nyx_test_heavy",
    description: "Emits an oversized array to force output truncation.",
    annotations: {
      title: "Heavy Output",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.strictObject({}),
    outputSchema: heavyOutputSchema,
    handler: () => ({ items }),
  });
}

function makeHeavyItems(): string[] {
  return Array.from({ length: 400 }, (_, i) => `item-${i}-${"a".repeat(40)}`);
}

function extractArtifactId(text: string): string {
  const m = text.match(/artifactId="([A-Za-z0-9]+)"/);
  expect(m, `content text must contain a recoverable artifactId: ${text}`).not.toBeNull();
  return m![1]!;
}

describe("Tool truncation keeps structuredContent schema-shaped", () => {
  it("forces a tiny budget, keeps outputSchema valid, stores the full payload, and pages it", async () => {
    // Tiny global budget to force truncation on a text payload far above it;
    // the paging role is exempted so nyx_artifact_read itself returns the chunk.
    setBudgetConfig({
      maxToolOutputTokens: 30,
      roleOutputOverrides: { "test-reader": 9000 },
    });
    const items = makeHeavyItems();
    const tool = makeHeavyTool(items);
    const serializedFull = JSON.stringify({ items }, null, 2);

    const response = await invokeToolDefinition(
      tool,
      {},
      { nyxHome, defaultProjectPath: repoPath },
    );

    expect(response.isError).toBeFalsy();
    const structured = response.structuredContent as Record<string, unknown>;

    // (a) structuredContent strictly matches the advertised output schema.
    const parsed = tool.outputSchema.safeParse(structured);
    expect(parsed.success).toBe(true);
    expect(structured["_truncated"]).toBeUndefined();
    expect(structured["_overflowArtifactId"]).toBeUndefined();

    const contentText = response.content[0]!.text;

    // (b) the artifactId is recoverable from the content text.
    const artifactId = extractArtifactId(contentText);
    expect(contentText).toContain("nyx_artifact_read");

    // (c) the stored artifact file contains the FULL original payload.
    const repoId = await computeRepoId(repoPath);
    const layout = getProjectLayout(repoId, nyxHome);
    const artifactFile = path.join(layout.artifactsDir, `${artifactId}.txt`);
    expect(fs.existsSync(artifactFile)).toBe(true);
    const stored = fs.readFileSync(artifactFile, "utf8");
    expect(stored).toBe(serializedFull);
    expect(stored).toContain("item-399-");

    // (d) nyx_artifact_read can page through every byte of it.
    const readOptions = {
      nyxHome,
      defaultProjectPath: repoPath,
      callerRole: "test-reader",
    };    const page1 = await invokeToolDefinition(
      nyxArtifactReadTool,
      { artifactId, offset: 0, limit: 64 },
      readOptions,
    );
    expect(page1.isError).toBeFalsy();
    expect(page1.content[0]!.text).toContain("item-0-");
    expect(page1.content[0]!.text).toContain('"hasMore": true');

    const page2 = await invokeToolDefinition(
      nyxArtifactReadTool,
      { artifactId, offset: 64, limit: 16384 },
      readOptions,
    );
    expect(page2.isError).toBeFalsy();
    expect(page2.content[0]!.text).toContain("item-200-");
    const page2Structured = page2.structuredContent as { totalBytes: number; hasMore: boolean };
    expect(page2Structured["hasMore"]).toBe(true);

    // Final page reaches the end of the artifact.
    const tailOffset = page2Structured["totalBytes"] - 64;
    const page3 = await invokeToolDefinition(
      nyxArtifactReadTool,
      { artifactId, offset: tailOffset, limit: 16384 },
      readOptions,
    );
    expect(page3.isError).toBeFalsy();
    expect(page3.content[0]!.text).toContain("item-399-");
    expect(page3.content[0]!.text).toContain('"hasMore": false');
  });

  it("returns a bounded truncated preview and not the full output in content text", async () => {
    setBudgetConfig({ maxToolOutputTokens: 30 });
    const tool = makeHeavyTool(makeHeavyItems());

    const response = await invokeToolDefinition(
      tool,
      {},
      { nyxHome, defaultProjectPath: repoPath },
    );
    const text = response.content[0]!.text;

    expect(text).toContain("[TRUNCATED");
    expect(text.length).toBeLessThan(1000);
    expect(text).not.toContain(`"${makeHeavyItems()[399]!}"`);
  });
});

describe("Config budgets: default raise and per-tool/per-role overrides", () => {
  it("raises the default maxToolOutputTokens to 6000", () => {
    const cfg = loadConfig({ projectPath: repoPath, nyxHome });
    expect(cfg.budgets.maxToolOutputTokens).toBe(6000);
  });

  it("resolves tool override > role override > global default", () => {
    const cfg = loadConfig({
      projectPath: repoPath,
      nyxHome,
      cliOverrides: {
        budgets: {
          maxToolOutputTokens: 30,
          toolOutputOverrides: { nyx_test_heavy: 6000 },
          roleOutputOverrides: { "nyx-worker": 1200 },
        },
      },
    });

    // Tool override wins over the role override.
    expect(resolveToolOutputBudget(cfg.budgets, "nyx_test_heavy", "nyx-worker")).toBe(6000);
    // Role override wins over the global default.
    expect(resolveToolOutputBudget(cfg.budgets, "nyx_test_other", "nyx-worker")).toBe(1200);
    // Global default applies when neither override matches.
    expect(resolveToolOutputBudget(cfg.budgets, "nyx_test_other", "nyx-sec")).toBe(30);
  });

  it("enforces the precedence through an actual tool invocation", async () => {
    setBudgetConfig({
      maxToolOutputTokens: 30,
      roleOutputOverrides: { "nyx-worker": 9000 },
    });
    const tool = makeHeavyTool(makeHeavyItems());

    // No role override: truncates against the global default (30).
    const truncated = await invokeToolDefinition(
      tool,
      {},
      { nyxHome, defaultProjectPath: repoPath },
    );
    expect(truncated.content[0]!.text).toContain("30-token budget");

    // Caller-role override lifts the budget far above the payload.
    const lifted = await invokeToolDefinition(
      tool,
      {},
      { nyxHome, defaultProjectPath: repoPath, callerRole: "nyx-worker" },
    );
    expect(lifted.isError).toBeFalsy();
    expect(lifted.content[0]!.text).not.toContain("[TRUNCATED");
    expect(lifted.structuredContent).toEqual({ items: makeHeavyItems() });
  });

  it("rejects override values below 10 or non-integers", () => {
    expect(() =>
      loadConfig({
        nyxHome,
        projectPath: repoPath,
        cliOverrides: { budgets: { toolOutputOverrides: { nyx_x: 5 } } },
      }),
    ).toThrowError(/budgets\.toolOutputOverrides\.nyx_x must be a positive integer >= 10/);

    expect(() =>
      loadConfig({
        nyxHome,
        projectPath: repoPath,
        cliOverrides: { budgets: { roleOutputOverrides: { "nyx-work": 5.5 } } },
      }),
    ).toThrowError(/budgets\.roleOutputOverrides\.nyx-work must be a positive integer >= 10/);

    expect(() =>
      loadConfig({
        nyxHome,
        projectPath: repoPath,
        cliOverrides: { budgets: { toolOutputOverrides: [] as unknown as Record<string, number> } },
      }),
    ).toThrowError(/must be an object/);
  });
});
