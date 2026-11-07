import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.ts";
import {
  ensureTestWriterRuntime,
  isTestWriterSourceReady,
  testWriterRoot,
  testWriterStatus,
} from "../../src/cli/testwriter.ts";

const WRAPPERS = [
  "tw-new-job",
  "tw-add-variant",
  "tw-approve",
  "tw-store-job",
  "tw-gate",
  "tw-status",
] as const;

function writeExecutable(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createFakeSource(sourceDir: string): void {
  fs.mkdirSync(path.join(sourceDir, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "bin"), { recursive: true });
  writeExecutable(path.join(sourceDir, "bin", "tw-gate"), "#!/usr/bin/env bash\nexit 0\n");

  writeExecutable(
    path.join(sourceDir, "bootstrap", "install-user.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': "${TW_INSTALL_ROOT:?}"',
      'mkdir -p "$TW_INSTALL_ROOT/bin" "$TW_INSTALL_ROOT/store"',
      'chmod 700 "$TW_INSTALL_ROOT/store"',
      "for name in tw-new-job tw-add-variant tw-approve tw-store-job tw-gate tw-status; do",
      `  printf '#!/usr/bin/env bash\\nexit 0\\n' > "$TW_INSTALL_ROOT/bin/$name"`,
      '  chmod 0755 "$TW_INSTALL_ROOT/bin/$name"',
      "done",
      'count_file="$TW_INSTALL_ROOT/install-count"',
      "count=0",
      'if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi',
      'echo $((count + 1)) > "$count_file"',
      'echo "USER_INSTALL: PASS"',
      "",
    ].join("\n"),
  );

  writeExecutable(
    path.join(sourceDir, "bootstrap", "build-user-venv.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': "${TW_INSTALL_ROOT:?}"',
      'mkdir -p "$TW_INSTALL_ROOT/venv/bin"',
      `printf '#!/usr/bin/env bash\\nexit 0\\n' > "$TW_INSTALL_ROOT/venv/bin/python"`,
      'chmod 0755 "$TW_INSTALL_ROOT/venv/bin/python"',
      'echo "USER_VENV: PASS"',
      "",
    ].join("\n"),
  );
}

describe("Test-Writer one-command install", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let sourceDir: string;

  beforeEach(() => {
    delete process.env["NYXOWL_TESTWRITER_INSTALL"];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-tw-install-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    sourceDir = path.join(tmpRoot, "package-root", "test-writer");
    createFakeSource(sourceDir);
  });

  afterEach(() => {
    delete process.env["NYXOWL_TESTWRITER_INSTALL"];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("installs idempotently, reruns with force, and reports status", async () => {
    const root = testWriterRoot(nyxowlHome);
    expect(root).toBe(path.join(nyxowlHome, "test-writer"));
    expect(isTestWriterSourceReady(sourceDir)).toBe(true);

    const before = testWriterStatus(root, sourceDir);
    expect(before.ready).toBe(false);
    expect(before.wrappers.every((wrapper) => !wrapper.executable)).toBe(true);

    const installed = await ensureTestWriterRuntime({ nyxowlHome, sourceDir });
    expect(installed.status).toBe("installed");
    expect(installed.root).toBe(root);
    expect(fs.readFileSync(path.join(root, "install-count"), "utf8").trim()).toBe("1");

    const status = testWriterStatus(root, sourceDir);
    expect(status.ready).toBe(true);
    expect(status.venv.ready).toBe(true);
    expect(status.wrappers.map((wrapper) => wrapper.name)).toEqual([...WRAPPERS]);
    expect(status.wrappers.every((wrapper) => wrapper.executable)).toBe(true);
    expect(fs.statSync(status.store).isDirectory()).toBe(true);

    const second = await ensureTestWriterRuntime({ nyxowlHome, sourceDir });
    expect(second.status).toBe("already-installed");
    expect(fs.readFileSync(path.join(root, "install-count"), "utf8").trim()).toBe("1");

    const forced = await ensureTestWriterRuntime({ nyxowlHome, sourceDir, force: true });
    expect(forced.status).toBe("installed");
    expect(fs.readFileSync(path.join(root, "install-count"), "utf8").trim()).toBe("2");
  });

  it("returns unavailable when the packaged source is missing", async () => {
    const emptySource = path.join(tmpRoot, "empty-source");
    fs.mkdirSync(emptySource, { recursive: true });
    const result = await ensureTestWriterRuntime({ nyxowlHome, sourceDir: emptySource });
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("install-user.sh");
    expect(testWriterStatus(testWriterRoot(nyxowlHome), emptySource).ready).toBe(false);
  });

  it("returns failed with the last stderr line when the venv cannot be built", async () => {
    writeExecutable(
      path.join(sourceDir, "bootstrap", "build-user-venv.sh"),
      [
        "#!/usr/bin/env bash",
        'echo "USER_VENV: FAIL (python3 not found)" >&2',
        "exit 1",
        "",
      ].join("\n"),
    );

    const result = await ensureTestWriterRuntime({ nyxowlHome, sourceDir });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("build-user-venv.sh");
    expect(result.message).toContain("USER_VENV: FAIL (python3 not found)");
    expect(testWriterStatus(testWriterRoot(nyxowlHome), sourceDir).ready).toBe(false);
  });

  it("honours the disabled option and only ignores NYXOWL_TESTWRITER_INSTALL=0 for explicit installs", async () => {
    const byOption = await ensureTestWriterRuntime({
      nyxowlHome,
      sourceDir,
      install: false,
    });
    expect(byOption.status).toBe("disabled");
    expect(fs.existsSync(path.join(nyxowlHome, "test-writer", "install-count"))).toBe(false);

    process.env["NYXOWL_TESTWRITER_INSTALL"] = "0";
    const autoByEnv = await ensureTestWriterRuntime({ nyxowlHome, sourceDir });
    expect(autoByEnv.status).toBe("disabled");
    expect(fs.existsSync(path.join(nyxowlHome, "test-writer", "install-count"))).toBe(false);

    const explicitOverride = await ensureTestWriterRuntime({
      nyxowlHome,
      sourceDir,
      install: true,
    });
    expect(explicitOverride.status).toBe("installed");
    expect(fs.readFileSync(path.join(nyxowlHome, "test-writer", "install-count"), "utf8").trim()).toBe(
      "1",
    );
  });

  it("is idempotent from the CLI, reruns with --force, and explicit install overrides the env opt-out", async () => {
    const root = path.join(nyxowlHome, "test-writer");
    const countFile = path.join(root, "install-count");

    const first = await runCli(["testwriter", "install"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Test-Writer: installed");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("1");

    const second = await runCli(["testwriter", "install"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Test-Writer: ready");
    expect(second.stdout).not.toContain("USER_INSTALL: PASS");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("1");

    const forced = await runCli(["testwriter", "install", "--force"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
    });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Test-Writer: installed");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("2");

    process.env["NYXOWL_TESTWRITER_INSTALL"] = "0";
    fs.rmSync(root, { recursive: true, force: true });
    const envOverride = await runCli(["testwriter", "install"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
    });
    expect(envOverride.exitCode).toBe(0);
    expect(envOverride.stdout).toContain("Test-Writer: installed");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("1");

    const disabled = await runCli(["testwriter", "install"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
      installTestWriter: false,
    });
    expect(disabled.exitCode).toBe(1);
    expect(disabled.stdout).toContain("disabled");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("1");
  });

  it("supports nyxowl testwriter status and install without touching the real HOME", async () => {
    const statusBefore = await runCli(["testwriter", "status"], { nyxowlHome });
    expect(statusBefore.exitCode).toBe(0);
    expect(statusBefore.stdout).toContain("Test-Writer: not ready");
    expect(statusBefore.stdout).toContain(path.join(nyxowlHome, "test-writer"));

    const install = await runCli(["testwriter", "install"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
      installTestWriter: true,
    });
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("Test-Writer: installed");

    const statusAfter = await runCli(["testwriter", "status"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
    });
    expect(statusAfter.exitCode).toBe(0);
    expect(statusAfter.stdout).toContain("Test-Writer: ready");
    expect(statusAfter.stdout).toContain("6/6 executable");
  });

  it("adds a ready Test-Writer line to doctor/setup under the temp nyxowlHome", async () => {
    const doctor = await runCli(["doctor"], {
      nyxowlHome,
      testWriterSourceDir: sourceDir,
      installTestWriter: true,
    });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain(
      `Test-Writer: ready at ${path.join(nyxowlHome, "test-writer")}`,
    );
    const root = path.join(nyxowlHome, "test-writer");
    expect(fs.existsSync(path.join(root, "venv", "bin", "python"))).toBe(true);
    expect(fs.existsSync(path.join(root, "store"))).toBe(true);
  });
});
