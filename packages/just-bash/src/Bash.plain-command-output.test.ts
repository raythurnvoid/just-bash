import { describe, expect, it, vi } from "vitest";
import { Bash, type BashOptions } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";
import type { ExecResult } from "./types.js";

function createBash(options: BashOptions = {}) {
  const output = { stdout: "", stderr: "" };
  const bash = new Bash({
    customCommands: [
      defineCommand("cp", async () => ({
        stdout: "copy\n",
        stderr: "note\n",
        exitCode: 0,
      })),
    ],
    onOutput: (stream, text) => {
      output[stream] += text;
    },
    ...options,
  });
  return { bash, output };
}

describe("plain-command output and limits", () => {
  it("streams verbose and trace text once across suspension and resume", async () => {
    const { bash, output } = createBash();
    const paused = await bash.exec("set -xv; cp src dest; printf after", {
      onPlainCommand: () => "suspend",
    });
    expect(paused.stderr).toBe("cp src dest\n+ cp src dest\n");
    expect(output).toEqual({ stdout: "", stderr: paused.stderr });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const result = await bash.resumePlainCommand(paused.continuation, {
      stdout: "copy\n",
      stderr: "note\n",
      exitCode: 0,
    });
    expect(result).toMatchObject({
      stdout: "copy\nafter",
      stderr: "note\nprintf after\n+ printf after\n",
      exitCode: 0,
    });
    expect(output).toEqual({
      stdout: paused.stdout + result.stdout,
      stderr: paused.stderr + result.stderr,
    });
  });

  it("streams expansion stderr only once when the host suspends or declines", async () => {
    for (const decision of ["suspend", "run"] as const) {
      const { bash, output } = createBash();
      const result = await bash.exec(
        'cp "$(printf expansion >&2; printf src)" dest',
        { onPlainCommand: () => decision },
      );
      expect(result.stderr).toBe(
        decision === "suspend" ? "expansion" : "expansionnote\n",
      );
      expect(output).toEqual({ stdout: result.stdout, stderr: result.stderr });
    }
  });

  it.each([
    9, 8,
  ])("charges trace output once before admission with a %s-byte budget", async (maxOutputSize) => {
    const { bash } = createBash({ executionLimits: { maxOutputSize } });
    const hook = vi.fn(() => "suspend" as const);
    const result = await bash.exec("set -x; cp a b", { onPlainCommand: hook });
    if (maxOutputSize === 9) {
      expect(result.stderr).toBe("+ cp a b\n");
      expect(hook).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ stdout: "", exitCode: 126 });
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it("does not accept old output accounting credit in a resumed result", async () => {
    const { bash } = createBash({ executionLimits: { maxOutputSize: 3 } });
    const paused = await bash.exec("cp src dest; touch /after", {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const result: ExecResult = {
      stdout: "abcd",
      stderr: "",
      exitCode: 0,
      internalOutputAccounting: { stdout: 4, stderr: 0 },
    };
    const resumed = await bash.resumePlainCommand(paused.continuation, result);
    expect(resumed).toMatchObject({ stdout: "", exitCode: 126 });
    expect(await bash.fs.exists("/after")).toBe(false);
  });

  it("counts completion output and later output in one resumed budget", async () => {
    const { bash } = createBash({ executionLimits: { maxOutputSize: 3 } });
    const paused = await bash.exec("cp src dest; printf cd; touch /after", {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const result = await bash.resumePlainCommand(paused.continuation, {
      stdout: "ab",
      stderr: "",
      exitCode: 0,
    });
    expect(result).toMatchObject({ stdout: "ab", exitCode: 126 });
    expect(await bash.fs.exists("/after")).toBe(false);
  });

  it("does not spend another command slot to deliver a stored result", async () => {
    const { bash } = createBash({ executionLimits: { maxCommandCount: 1 } });
    const paused = await bash.exec("cp src dest; printf after", {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const result = await bash.resumePlainCommand(paused.continuation, {
      stdout: "copy",
      stderr: "",
      exitCode: 0,
    });
    expect(result).toMatchObject({
      stdout: "copyafter",
      stderr: "",
      exitCode: 0,
    });
  });

  it("does not let a statement pause skip completion under set -e", async () => {
    const { bash } = createBash();
    const paused = await bash.exec("set -e; cp src dest; touch /after", {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const boundary = vi.fn(() => "stop" as const);
    const result = await bash.resumePlainCommand(
      paused.continuation,
      { stdout: "", stderr: "failed\n", exitCode: 9 },
      { onStatementBoundary: boundary },
    );
    expect(result).toMatchObject({
      stdout: "",
      stderr: "failed\n",
      exitCode: 9,
    });
    expect(boundary).not.toHaveBeenCalled();
    expect(await bash.fs.exists("/after")).toBe(false);
  });

  it("bounds an unresponsive host hook without running later statements", async () => {
    const execute = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const { bash } = createBash({
      customCommands: [defineCommand("cp", execute)],
      executionLimits: { maxExecutionTimeMs: 50, maxExtensionCleanupTimeMs: 1 },
    });
    const result = await bash.exec("cp src dest; touch /after", {
      onPlainCommand: () => new Promise(() => {}),
    });
    expect(result).toMatchObject({ stdout: "", exitCode: 124 });
    expect(execute).not.toHaveBeenCalled();
    expect(await bash.fs.exists("/after")).toBe(false);
  });

  it("keeps Abort distinct from host suspension", async () => {
    const { bash } = createBash();
    const abort = new AbortController();
    const result = await bash.exec("cp src dest; touch /after", {
      signal: abort.signal,
      onPlainCommand: () => {
        abort.abort();
        return "suspend";
      },
    });
    expect(result).toMatchObject({ stdout: "", exitCode: 124 });
    expect("continuation" in result).toBe(false);
    expect(await bash.fs.exists("/after")).toBe(false);
  });
});
