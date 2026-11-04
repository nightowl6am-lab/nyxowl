#!/usr/bin/env node
import { assertSupportedNode } from "./preflight.ts";

// Keep this wrapper free of static imports that load `node:sqlite` so that
// unsupported Node versions get a friendly upgrade message instead of
// ERR_UNKNOWN_BUILTIN_MODULE at module resolution time.
assertSupportedNode(process.versions.node);

const { runCli } = await import("./index.ts");

try {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Nyxowl CLI error: ${message}\n`);
  process.exitCode = 1;
}
