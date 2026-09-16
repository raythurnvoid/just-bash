import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import type { InterpreterStateSnapshot } from "./interpreter/state-snapshot.js";
import type { StatementBoundary } from "./interpreter/statement-boundary.js";

/**
 * A bash whose boundary hook records what it received and runs everything.
 * `sleep` is stubbed so a script may name long sleeps.
 */
function createBash() {
  const boundaries: {
    script: string;
    remaining: string;
    after: string;
    sleepMs: number | null;
  }[] = [];
  const bash = new Bash({
    cwd: "/docs",
    files: { "/docs/file": "docs" },
    sleep: async () => {},
  });
  const onStatementBoundary = (boundary: StatementBoundary) => {
    boundaries.push({
      script: boundary.script,
      remaining: boundary.remainingScript(),
      after: boundary.scriptAfter(),
      sleepMs: boundary.sleepMs,
    });
    return "run" as const;
  };
  return { bash, boundaries, onStatementBoundary };
}

describe("onStatementBoundary", () => {
  it("fires before each top-level statement with the text still to run", async () => {
    const { bash, boundaries, onStatementBoundary } = createBash();
    const result = await bash.exec(
      "x=1\necho $x\ncat <<EOF\nheredoc $x\nEOF\nfor i in 1 2; do echo $i; done",
      { onStatementBoundary },
    );
    expect(result.stdout).toBe("1\nheredoc 1\n1\n2\n");
    const loop = "for i in 1 2; do echo $i; done";
    // A heredoc statement's text ends with the newline of its terminator line.
    const heredoc = "cat <<EOF\nheredoc $x\nEOF\n";
    expect(boundaries).toEqual([
      {
        script: "x=1",
        remaining: `x=1\necho $x\n${heredoc}\n${loop}`,
        after: `echo $x\n${heredoc}\n${loop}`,
        sleepMs: null,
      },
      {
        script: "echo $x",
        remaining: `echo $x\n${heredoc}\n${loop}`,
        after: `${heredoc}\n${loop}`,
        sleepMs: null,
      },
      {
        script: heredoc,
        remaining: `${heredoc}\n${loop}`,
        after: loop,
        sleepMs: null,
      },
      { script: loop, remaining: loop, after: "", sleepMs: null },
    ]);
  });

  it("sees the body of a bare top-level group, and never a nested script", async () => {
    const { bash, boundaries, onStatementBoundary } = createBash();
    const result = await bash.exec(
      "{ a=1; eval 'b=2; c=3'; bash -c 'echo nested'; echo $a$b$c; }",
      { onStatementBoundary },
    );
    expect(result.stdout).toBe("nested\n123\n");
    expect(boundaries.map((boundary) => boundary.script)).toEqual([
      "a=1",
      "eval 'b=2; c=3'",
      "bash -c 'echo nested'",
      "echo $a$b$c",
    ]);
  });

  it("keeps a redirected group, a subshell and a pipeline as one statement", async () => {
    const { bash, boundaries, onStatementBoundary } = createBash();
    await bash.exec(
      "{ echo a; echo b; } > /docs/out\n( echo c; echo d )\necho e | cat",
      { onStatementBoundary },
    );
    expect(boundaries.map((boundary) => boundary.script)).toEqual([
      "{ echo a; echo b; } > /docs/out",
      "( echo c; echo d )",
      "echo e | cat",
    ]);
  });

  it("reports the milliseconds of a bare literal sleep only", async () => {
    const { bash, boundaries, onStatementBoundary } = createBash();
    await bash.exec(
      [
        "sleep 30",
        "sleep 1m 2s",
        "sleep '3'",
        "n=1",
        "sleep $n",
        "sleep 1 | cat",
        "sleep 1 > /dev/null",
        "sleep 1 && true",
        "! sleep 1",
        "sleep",
      ].join("\n"),
      { onStatementBoundary },
    );
    expect(boundaries.map((boundary) => boundary.sleepMs)).toEqual([
      30_000,
      62_000,
      3_000,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("stop ends the exec before the statement, and the rest runs later from the snapshot", async () => {
    const { bash } = createBash();
    let snapshot: InterpreterStateSnapshot | undefined;
    let rest = "";
    const result = await bash.exec(
      "x=1\ncd /\necho before $x\nfalse\necho after $x $?",
      {
        onStatementBoundary: (boundary) => {
          if (boundary.script !== "false") return "run";
          snapshot = boundary.snapshot();
          rest = boundary.remainingScript();
          return "stop";
        },
      },
    );
    expect(result.stdout).toBe("before 1\n");
    expect(result.exitCode).toBe(0);
    expect(rest).toBe("false\necho after $x $?");
    expect(snapshot?.env).toContainEqual({ name: "x", value: "1" });

    const resumed = await bash.exec(rest, { restoreState: snapshot });
    expect(resumed.stdout).toBe("after 1 1\n");
    expect(resumed.exitCode).toBe(0);
  });

  it("does not fire for a nested exec", async () => {
    const { bash, boundaries, onStatementBoundary } = createBash();
    await bash.exec("bash -c 'echo one; echo two'", { onStatementBoundary });
    expect(boundaries.map((boundary) => boundary.script)).toEqual([
      "bash -c 'echo one; echo two'",
    ]);
  });
});
