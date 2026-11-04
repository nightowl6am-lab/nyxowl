import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "cli/bin": "src/cli/bin.ts",
    "mcp/server": "src/mcp/server.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  async onSuccess() {
    // tsup's removeNodeProtocol plugin strips `node:` from `node:sqlite`,
    // which requires the `node:` prefix in Node 22/24. Restore `node:sqlite` in dist/*.js.
    const distDir = path.resolve("dist");
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          const raw = fs.readFileSync(full, "utf8");
          const fixed = raw
            .replace(/from\s+["']sqlite["']/g, 'from "node:sqlite"')
            .replace(/require\(["']sqlite["']\)/g, 'require("node:sqlite")');
          if (fixed !== raw) {
            fs.writeFileSync(full, fixed, "utf8");
          }
        }
      }
    };
    walk(distDir);
    for (const cliEntry of ["index.js", "bin.js"]) {
      const cliBin = path.join(distDir, "cli", cliEntry);
      if (fs.existsSync(cliBin)) {
        fs.chmodSync(cliBin, 0o755);
      }
    }
  },
});
