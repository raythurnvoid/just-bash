import { describe, expect, it, vi } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";
import type { PlainCommandBoundary } from "./interpreter/statement-boundary.js";

function createBash() {
  const execute = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  const bash = new Bash({
    cwd: "/work",
    files: { "/work/src": "source" },
    customCommands: [defineCommand("cp", execute)],
  });
  const boundaries: PlainCommandBoundary[] = [];
  const onPlainCommand = (boundary: PlainCommandBoundary) => {
    boundaries.push(boundary);
    return "suspend" as const;
  };
  return { bash, execute, boundaries, onPlainCommand };
}

describe("plain-command continuation", () => {
  it.each([
    0, 7,
  ])("expands once and delays the next write until result %s", async (exitCode) => {
    const { bash, execute, boundaries, onPlainCommand } = createBash();
    const onExecEnd = vi.fn();
    const paused = await bash.exec(
      'n=0; cp "$((++n))" "$(printf x >> /work/expansions; printf dest)"; printf "%s" "$n:$?:${PIPESTATUS[0]}:$_" > /work/after',
      { onPlainCommand, onExecEnd },
    );
    expect(paused).toMatchObject({
      kind: "host_suspended",
      stdout: "",
      stderr: "",
    });
    expect("exitCode" in paused).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(onExecEnd).not.toHaveBeenCalled();
    expect(boundaries).toHaveLength(1);
    expect(await bash.fs.exists("/work/after")).toBe(false);
    expect(await bash.fs.readFile("/work/expansions")).toBe("x");
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    expect(paused.continuation.args).toEqual(["1", "dest"]);
    expect(paused.continuation.snapshot.env).toContainEqual({
      name: "n",
      value: "1",
    });

    const next = new Bash({
      fs: bash.fs,
      customCommands: [defineCommand("cp", execute)],
    });
    const result = await next.resumePlainCommand(
      structuredClone(paused.continuation),
      { stdout: "ready\n", stderr: "notice\n", exitCode },
    );
    expect(result).toMatchObject({
      stdout: "ready\n",
      stderr: "notice\n",
      exitCode: 0,
    });
    expect(await bash.fs.readFile("/work/after")).toBe(
      `1:${exitCode}:${exitCode}:dest`,
    );
    expect(await bash.fs.readFile("/work/expansions")).toBe("x");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    0, 9,
  ])("applies set -e only to the real result %s", async (exitCode) => {
    const { bash, onPlainCommand } = createBash();
    const paused = await bash.exec("set -e; cp src dest; touch /work/after", {
      onPlainCommand,
    });
    expect("exitCode" in paused).toBe(false);
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const result = await bash.resumePlainCommand(paused.continuation, {
      stdout: "",
      stderr: "",
      exitCode,
    });
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode });
    expect(await bash.fs.exists("/work/after")).toBe(exitCode === 0);
  });

  it.each([
    0, 8,
  ])("completes the last command with an empty remainder and result %s", async (exitCode) => {
    const { bash, onPlainCommand } = createBash();
    const paused = await bash.exec("cp src dest", { onPlainCommand });
    expect("exitCode" in paused).toBe(false);
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    expect(paused.continuation.scriptAfter).toBe("");
    const onExecEnd = vi.fn();
    const result = await bash.resumePlainCommand(
      paused.continuation,
      { stdout: "one\n", stderr: "two\n", exitCode },
      { onExecEnd },
    );
    expect(result).toMatchObject({
      stdout: "one\n",
      stderr: "two\n",
      exitCode,
    });
    expect(onExecEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps nested argument calls bounded and gives the next direct call a new token", async () => {
    const { bash, execute, boundaries, onPlainCommand } = createBash();
    const paused = await bash.exec(
      'cp "$(cp inner dest; printf src)" dest; cp next dest',
      { onPlainCommand },
    );
    expect("exitCode" in paused).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(boundaries).toHaveLength(1);
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const second = await bash.resumePlainCommand(
      paused.continuation,
      { stdout: "", stderr: "", exitCode: 0 },
      { onPlainCommand },
    );
    expect("exitCode" in second).toBe(false);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].token).not.toBe(boundaries[1].token);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs the bounded command when the host declines", async () => {
    const { bash, execute } = createBash();
    const hook = vi.fn(() => "run" as const);
    const result = await bash.exec("cp src dest; printf after", {
      onPlainCommand: hook,
    });
    expect(result).toMatchObject({ stdout: "after", stderr: "", exitCode: 0 });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not run the command or following write after checkpoint failure", async () => {
    const { bash, execute } = createBash();
    await expect(
      bash.exec("cp src dest; touch /work/after", {
        onPlainCommand: () => {
          throw new Error("checkpoint failed");
        },
      }),
    ).rejects.toThrow("checkpoint failed");
    expect(execute).not.toHaveBeenCalled();
    expect(await bash.fs.exists("/work/after")).toBe(false);
  });
});
