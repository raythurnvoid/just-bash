import { describe, expect, it, vi } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";
import type { BackgroundLaunch } from "./interpreter/state-snapshot.js";

describe("plain-command eligibility", () => {
  it.each([
    ["logical tail", "cp src dest && true"],
    ["logical head", "true && cp src dest"],
    ["logical or", "false || cp src dest"],
    ["pipeline", "cp src dest | cat"],
    ["loop", "for x in 1; do cp src dest; done"],
    ["while", "n=0; while ((n++ < 1)); do cp src dest; done"],
    ["if", "if true; then cp src dest; fi"],
    ["case", "case x in x) cp src dest;; esac"],
    ["function", "f() { cp src dest; }; f"],
    ["nested shell", "bash -c 'cp src dest'"],
    ["eval", "eval 'cp src dest'"],
    ["source", "source /work/source.sh"],
    ["substitution", 'echo "$(cp src dest)"'],
    ["redirect", "cp src dest > /work/out"],
    ["input", "cp src dest < /work/src"],
    ["assignment", "X=1 cp src dest"],
    ["negation", "! cp src dest"],
    ["time", "time cp src dest"],
    ["subshell", "( cp src dest )"],
    ["redirected group", "{ cp src dest; } > /work/out"],
    ["descriptor", "exec 3> /work/out; cp src dest"],
    ["process substitution", "cp <(printf src) dest"],
    ["dynamic name", 'name=cp; "$name" src dest'],
    ["wrapper", "command cp src dest"],
  ])("keeps %s bounded", async (_name, source) => {
    const execute = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const bash = new Bash({
      cwd: "/work",
      files: { "/work/src": "source", "/work/source.sh": "cp src dest" },
      customCommands: [defineCommand("cp", execute)],
    });
    const onPlainCommand = vi.fn(() => "suspend" as const);
    const result = await bash.exec(source, { onPlainCommand });
    expect(onPlainCommand).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect("exitCode" in result).toBe(true);
  });

  it.each([
    ["function", "cp() { printf shadow; }; cp src dest"],
    ["alias", "shopt -s expand_aliases; alias cp='printf shadow'; cp"],
    ["PATH script", "PATH=/work:/usr/bin:/bin; cp src dest"],
  ])("does not suspend a %s shadow", async (_name, source) => {
    const execute = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const bash = new Bash({
      files: { "/work/cp": "#!/bin/bash\nprintf shadow" },
      customCommands: [defineCommand("cp", execute)],
    });
    await bash.fs.chmod("/work/cp", 0o755);
    const onPlainCommand = vi.fn(() => "suspend" as const);
    const result = await bash.exec(source, { onPlainCommand });
    expect(result).toMatchObject({ stdout: "shadow", stderr: "", exitCode: 0 });
    expect(onPlainCommand).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps missing commands and untrusted extensions out of the hook", async () => {
    const execute = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const bash = new Bash({
      customCommands: [defineCommand("cp", execute, { trusted: false })],
    });
    const onPlainCommand = vi.fn(() => "suspend" as const);
    const missing = await bash.exec("PATH=/nowhere; cp src dest", {
      onPlainCommand,
    });
    expect(missing).toMatchObject({
      stdout: "",
      stderr: "bash: cp: command not found\n",
      exitCode: 127,
    });
    await bash.exec("cp src dest", { onPlainCommand });
    expect(onPlainCommand).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("resolves the direct command once before invoking the hook", async () => {
    const bash = new Bash({
      customCommands: [
        defineCommand("cp", async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ],
    });
    const stat = vi.spyOn(bash.fs, "stat");
    const hook = vi.fn(() => "run" as const);
    const result = await bash.exec("cp src dest", { onPlainCommand: hook });
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(
      stat.mock.calls.filter(([path]) => path === "/usr/bin/cp"),
    ).toHaveLength(1);
  });

  it.each([
    "cp src dest &",
    "{ printf before; cp src dest; printf after; } &",
  ])("supports the existing background launch: %s", async (source) => {
    const bash = new Bash({
      customCommands: [
        defineCommand("cp", async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ],
    });
    const launch = vi.fn(async (_launch: BackgroundLaunch) => ({
      jobNumber: 3,
      stderr: "",
    }));
    await bash.exec(source, { onBackground: launch });
    const [background] = launch.mock.calls[0];
    const result = await bash.exec(background.script, {
      cwd: background.cwd,
      restoreState: background.snapshot,
      onPlainCommand: () => "suspend",
    });
    expect("exitCode" in result).toBe(false);
    expect(result.stdout).toBe(source.startsWith("{") ? "before" : "");
    expect(result.stderr).toBe("");
  });
});
