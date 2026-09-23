import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";
import type {
  BashRunOutcome,
  PlainCommandHook,
} from "./interpreter/statement-boundary.js";
import type { BashExecResult } from "./types.js";

const onPlainCommand: PlainCommandHook = ({ continuation }) =>
  continuation.command === "cp" ? "suspend" : "run";

describe("plain-command lifecycle", () => {
  it("keeps normal and host-enabled exec return types separate", () => {
    const bash = new Bash();
    expectTypeOf(bash.exec("")).toEqualTypeOf<Promise<BashExecResult>>();
    expectTypeOf(bash.exec("", { onPlainCommand })).toEqualTypeOf<
      Promise<BashRunOutcome>
    >();
  });

  it("closes resources once without logging or reporting a finished exec", async () => {
    const cleanup = vi.fn();
    const info = vi.fn();
    const onExecEnd = vi.fn();
    const bash = new Bash({
      logger: { info, debug: () => {} },
      customCommands: [
        defineCommand("setup", async (_args, ctx) => {
          ctx.executionScope?.registerCleanup(cleanup);
          return { stdout: "before", stderr: "", exitCode: 0 };
        }),
        defineCommand("cp", async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ],
    });
    const paused = await bash.exec("setup; cp src dest", {
      onPlainCommand,
      onExecEnd,
    });
    expect(paused).toMatchObject({
      kind: "host_suspended",
      stdout: "before",
      stderr: "",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onExecEnd).not.toHaveBeenCalled();
    expect(
      info.mock.calls.filter(([message]) => message === "exit"),
    ).toHaveLength(0);
  });

  it.each([
    "failure",
    "abort",
  ])("returns a terminal result, not a mixed pause, after cleanup %s", async (mode) => {
    const controller = new AbortController();
    const onExecEnd = vi.fn();
    const bash = new Bash({
      customCommands: [
        defineCommand("setup", async (_args, ctx) => {
          ctx.executionScope?.registerCleanup(() => {
            if (mode === "abort") controller.abort();
            else throw new Error("private cleanup error");
          });
          return { stdout: "before", stderr: "", exitCode: 0 };
        }),
        defineCommand("cp", async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ],
    });
    const result = await bash.exec("setup; cp src dest; touch /after", {
      onPlainCommand,
      onExecEnd,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      stdout: "before",
      stderr:
        mode === "abort"
          ? "bash: execution aborted\n"
          : "bash: execution cleanup failed\n",
      exitCode: mode === "abort" ? 124 : 126,
    });
    expect("continuation" in result).toBe(false);
    expect("kind" in result).toBe(false);
    expect(onExecEnd).toHaveBeenCalledTimes(1);
    expect(await bash.fs.exists("/after")).toBe(false);
  });

  it("keeps the live cwd and token, then resumes at that directory", async () => {
    const token = Object.freeze({});
    const onCwdChange = vi.fn(async () => {});
    const bash = new Bash({
      files: { "/work/src": "source" },
      customCommands: [
        defineCommand("cp", async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ],
    });
    const paused = await bash.exec("cd /work; cp src dest; pwd", {
      onPlainCommand,
      cwdToken: token,
      onCwdChange,
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    expect(paused.continuation.cwd).toBe("/work");
    expect(paused.cwd?.path).toBe("/work");
    expect(paused.cwd?.token).not.toBe(token);
    const result = await bash.resumePlainCommand(
      paused.continuation,
      { stdout: "", stderr: "", exitCode: 0 },
      { cwdToken: paused.cwd?.token },
    );
    expect(result).toMatchObject({
      stdout: "/work\n",
      stderr: "",
      exitCode: 0,
    });
    expect(result.cwd?.token).toBe(paused.cwd?.token);
  });
});
