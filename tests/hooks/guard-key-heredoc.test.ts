import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateShellCommandGuard,
  isSecretFilePath,
  stripHeredocBodies,
} from "../../src/cli/hooks/guard.ts";

describe("Shell guard: .key member expressions and heredoc bodies", () => {
  let tmpRoot = "";
  let projectDir = "";
  let nyxowlHome = "";

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-guard-key-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    projectDir = path.join(tmpRoot, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function evaluate(command: string): ReturnType<typeof evaluateShellCommandGuard> {
    return evaluateShellCommandGuard(command, {
      cwd: projectDir,
      projectPath: projectDir,
      nyxowlHome,
    });
  }

  it("allows .key member expressions that are not file paths", () => {
    for (const command of [
      'node -e "x.key"',
      'node -e "console.log(item.key)"',
      'node -e "e.key"',
    ]) {
      expect(evaluate(command).decision, command).toBe("allow");
    }

    expect(isSecretFilePath("x.key")).toBe(false);
    expect(isSecretFilePath("item.key")).toBe(false);
    expect(isSecretFilePath("e.key")).toBe(false);
  });

  it("allows a heredoc body containing member expressions", () => {
    const heredoc = [
      "cat > notes.txt <<'EOF'",
      "e.key",
      "item.key",
      "x.key",
      "EOF",
    ].join("\n");
    expect(evaluate(heredoc).decision).toBe("allow");

    // Heredoc contents are data, so a command-looking line inside the body is not executed.
    const commandBody = [
      "cat > notes.txt <<EOF",
      "cat .env",
      "EOF",
    ].join("\n");
    expect(evaluate(commandBody).decision).toBe("allow");

    expect(stripHeredocBodies(heredoc)).not.toContain("e.key");
  });

  it("blocks heredoc bodies fed to shell and language interpreters", () => {
    const cases = [
      ["bash", "cat .env"],
      ["node", 'require("fs").readFileSync(".env")'],
      ["python", 'open(".env").read()'],
    ] as const;

    for (const [interpreter, body] of cases) {
      const command = `${interpreter} <<EOF\n${body}\nEOF`;
      expect(evaluate(command).decision, command).toBe("deny");
    }
  });

  it("blocks real private-key paths", () => {
    for (const command of [
      "cat server.key",
      "cat private.key",
      "cat certs/private.key",
      "cat ./server.key",
      "cat ~/.ssh/server.key",
      "cat --key=server.key",
    ]) {
      expect(evaluate(command).decision, command).toBe("deny");
    }

    expect(isSecretFilePath("server.key")).toBe(true);
    expect(isSecretFilePath("certs/private.key")).toBe(true);
    expect(isSecretFilePath("~/.ssh/server.key")).toBe(true);
  });

  it("still blocks real .env paths and env dumps", () => {
    for (const command of ["cat .env", "cat .env.local", "printenv", "env"]) {
      expect(evaluate(command).decision, command).toBe("deny");
    }

    expect(isSecretFilePath(".env")).toBe(true);
    expect(isSecretFilePath(".env.production")).toBe(true);
    expect(isSecretFilePath(".env.example")).toBe(false);
  });

  it("keeps certificate, SSH, cloud-credential, and nyxowl-state blocking", () => {
    for (const command of [
      "cat certs/private.pem",
      "cat id_rsa",
      "cat id_ed25519",
      "cat ~/.aws/credentials",
      "cat ~/.nyxowl/secrets/receipt.key",
      "cat ~/.nyxowl/projects/demo/state.db",
    ]) {
      expect(evaluate(command).decision, command).toBe("deny");
    }
  });
});
