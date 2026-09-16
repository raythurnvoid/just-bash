import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

describe("cwd token", () => {
  function createBash() {
    const seen: string[] = [];
    const bash = new Bash({
      cwd: "/docs",
      files: { "/docs/file": "docs", "/archive/file": "archive" },
      customCommands: [
        {
          name: "capture",
          async execute(_args, ctx) {
            seen.push(ctx.cwd);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    return { bash, seen };
  }

  it("keeps the starting token without navigation or on failed cd", async () => {
    const { bash, seen } = createBash();
    const token = {};
    const result = await bash.exec("capture; PWD=/fake; cd /missing", {
      cwdToken: token,
    });
    expect(result.exitCode).toBe(1);
    expect(result.cwd?.path).toBe("/docs");
    expect(result.cwd?.token).toBe(token);
    expect(seen).toEqual(["/docs"]);
  });

  it.each([
    "cd .",
    "builtin cd .",
    "name=cd; $name .",
    "pushd /archive; popd",
  ])("changes the token for successful navigation: %s", async (command) => {
    const { bash, seen } = createBash();
    const token = {};
    const selections: Array<{ path: string; token: object; seen: string[] }> =
      [];
    const result = await bash.exec(`capture; ${command}; capture`, {
      cwdToken: token,
      onCwdChange: async (path, token) => {
        await Promise.resolve();
        selections.push({ path, token, seen: [...seen] });
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.cwd?.path).toBe("/docs");
    expect(seen).toEqual(["/docs", "/docs"]);
    expect(result.cwd?.token).toBe(selections.at(-1)?.token);
    expect(selections.map((selection) => selection.seen)).toEqual(
      selections.map(() => ["/docs"]),
    );
    expect(result.cwd?.token).toBeDefined();
    expect(result.cwd?.token).not.toBe(token);
  });

  it.each([
    "(cd /archive; capture)",
    "value=$(cd /archive; capture)",
    "value=x; value=${value/$(cd ..; capture)/y}",
    "cd /archive | capture",
    "capture | cd /archive",
    "bash -c 'cd /archive; capture'",
  ])("restores the outer directory and token after %s", async (command) => {
    const { bash } = createBash();
    const token = {};
    const result = await bash.exec(command, { cwdToken: token });
    expect(result.exitCode).toBe(0);
    expect(result.cwd?.path).toBe("/docs");
    expect(result.cwd?.token).toBe(token);
  });

  it.each([
    "{ cd /archive; }",
    "go() { cd /archive; }; go",
    "shopt -s lastpipe; capture | cd /archive",
    "cd /archive; exit 0",
    "set -e; cd /archive; false",
  ])("keeps navigation in the current shell: %s", async (command) => {
    const { bash } = createBash();
    const token = {};
    const result = await bash.exec(command, { cwdToken: token });
    expect(result.cwd?.path).toBe("/archive");
    expect(result.cwd?.token).toBeDefined();
    expect(result.cwd?.token).not.toBe(token);
  });

  it("returns the initial token for an empty script or a parse error", async () => {
    const { bash } = createBash();
    const token = {};
    for (const script of ["", "echo ${"]) {
      const result = await bash.exec(script, {
        cwd: "/archive",
        cwdToken: token,
      });
      expect(result.cwd?.path).toBe("/archive");
      expect(result.cwd?.token).toBe(token);
    }
  });

  it("does not add cwd data when tracking is disabled", async () => {
    const { bash } = createBash();
    const result = await bash.exec("cd /archive; capture");
    expect(result).not.toHaveProperty("cwd");
  });

  it("returns the current directory after cancellation", async () => {
    const abort = new AbortController();
    const bash = new Bash({
      cwd: "/docs",
      files: { "/archive/file": "archive" },
      sleep: async () => {
        abort.abort();
      },
    });
    const token = {};
    const result = await bash.exec("cd /archive; sleep 1; echo after", {
      cwdToken: token,
      signal: abort.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).not.toContain("after");
    expect(result.cwd?.path).toBe("/archive");
    expect(result.cwd?.token).toBeDefined();
    expect(result.cwd?.token).not.toBe(token);
  });
});
