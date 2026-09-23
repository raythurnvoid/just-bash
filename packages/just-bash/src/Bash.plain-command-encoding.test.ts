import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";

const copy = defineCommand("cp", async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

describe("plain-command output encoding", () => {
  it.each([
    "text",
    "bytes",
  ] as const)("resumes %s output with the normal decoding and live output", async (stdoutKind) => {
    const live = { stdout: "", stderr: "" };
    const bash = new Bash({
      customCommands: [copy],
      onOutput: (stream, text) => {
        live[stream] += text;
      },
    });
    const paused = await bash.exec('printf "é"; cp src dest; printf "界"', {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    expect(paused.stdout).toBe("é");
    const result = await bash.resumePlainCommand(paused.continuation, {
      stdout: stdoutKind === "text" ? "ñ" : "\xc3\xb1",
      stdoutKind,
      stderr: "ça",
      exitCode: 0,
    });
    expect(result).toMatchObject({ stdout: "ñ界", stderr: "ça", exitCode: 0 });
    expect(live).toEqual({ stdout: "éñ界", stderr: "ça" });
  });

  it("counts text completion bytes exactly", async () => {
    for (const maxOutputSize of [2, 1]) {
      const bash = new Bash({
        customCommands: [copy],
        executionLimits: { maxOutputSize },
      });
      const paused = await bash.exec("cp src dest", {
        onPlainCommand: () => "suspend",
      });
      if (!("continuation" in paused)) throw new Error("Expected suspension");
      const result = await bash.resumePlainCommand(paused.continuation, {
        stdout: "é",
        stdoutKind: "text",
        stderr: "",
        exitCode: 0,
      });
      expect(result).toMatchObject({
        stdout: maxOutputSize === 2 ? "é" : "",
        exitCode: maxOutputSize === 2 ? 0 : 126,
      });
    }
  });

  it.each([
    1, 2, 3,
  ])("uses normal binary result accounting with budget %s", async (maxOutputSize) => {
    const completion = {
      stdout: "\xc3\xa9",
      stdoutKind: "bytes" as const,
      stderr: "",
      exitCode: 0,
    };
    const options = {
      customCommands: [defineCommand("cp", async () => ({ ...completion }))],
      executionLimits: { maxOutputSize },
    };
    const normal = await new Bash(options).exec("cp src dest");
    const bash = new Bash(options);
    const paused = await bash.exec("cp src dest", {
      onPlainCommand: () => "suspend",
    });
    if (!("continuation" in paused)) throw new Error("Expected suspension");
    const resumed = await bash.resumePlainCommand(
      paused.continuation,
      completion,
    );
    expect(resumed).toEqual(normal);
    expect(resumed).toMatchObject({
      stdout: maxOutputSize === 3 ? "é" : "",
      exitCode: maxOutputSize === 3 ? 0 : 126,
    });
  });

  it.each([
    4, 5, 6, 7, 8,
  ])("does not add an expansion stderr charge when declining with budget %s", async (maxOutputSize) => {
    const options = {
      customCommands: [copy],
      executionLimits: { maxOutputSize },
    };
    const script = 'cp "$(printf err >&2; printf x)" dest';
    const normal = await new Bash(options).exec(script);
    const declined = await new Bash(options).exec(script, {
      onPlainCommand: () => "run",
    });
    expect(declined).toMatchObject({
      stdout: normal.stdout,
      exitCode: normal.exitCode,
    });
    expect(normal.stderr).toBe(
      maxOutputSize >= 7
        ? "err"
        : `bash: pipeline: total output size exceeded (>${maxOutputSize} bytes), increase executionLimits.maxOutputSize\n`,
    );
    expect(declined.stderr).toBe(
      maxOutputSize >= 7
        ? "err"
        : `bash: plain command: total output size exceeded (>${maxOutputSize} bytes), increase executionLimits.maxOutputSize\n`,
    );
  });
});
