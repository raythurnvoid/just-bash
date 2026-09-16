import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { InterpreterStateSnapshot } from "./state-snapshot.js";

/**
 * A bash whose `sleep` aborts the exec signal instead of waiting. `sleep`
 * then returns exit 0, so a missing abort check lets the rest of the
 * statement run.
 */
function createAbortingBash() {
  const abort = new AbortController();
  const marks: string[] = [];
  const bash = new Bash({
    cwd: "/w",
    files: { "/w/keep": "keep", "/w/lib.sh": "sleep 2" },
    sleep: async () => {
      abort.abort();
    },
    customCommands: [
      {
        name: "mark",
        async execute(args) {
          marks.push(args.join(" "));
          abort.abort();
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    ],
  });
  return { bash, signal: abort.signal, marks };
}

describe("abort propagation", () => {
  it.each([
    "sleep 2 && touch LEAK",
    "sleep 2 | touch LEAK",
    "{ sleep 2; echo x; } && touch LEAK",
    "if sleep 2; then echo x; fi && touch LEAK",
    "for x in 1; do sleep 2; echo x; done && touch LEAK",
    "touch ${a[$(sleep 2)]}",
    "echo $(( $(sleep 2) + 1 )) && touch LEAK",
    "eval 'sleep 2' || touch LEAK",
    "source lib.sh || touch LEAK",
    "x=$(sleep 2) || touch LEAK",
    "( sleep 2 ) || touch LEAK",
    "compgen -C 'sleep 2' || touch LEAK",
    "[[ $(sleep 2) == x ]] || touch LEAK",
    "(( $(sleep 2) + 1 )) || touch LEAK",
    'let "y = $(sleep 2) + 1" || touch LEAK',
    'declare -i y="$(sleep 2) + 1" || touch LEAK',
    "printf 'x\\n' | xargs -I {} bash -c 'sleep 2' && touch LEAK",
  ])("exits 124 without running the rest: %s", async (script) => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec(script, { signal });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
    const check = await bash.exec('test -e LEAK; echo "$?"');
    expect(check.stdout).toBe("1\n");
  });

  it("does not run a command whose word expansion was aborted", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec("v=/w/keep; rm ${v/x/$(sleep 2)}", {
      signal,
    });
    expect(result.exitCode).toBe(124);
    const check = await bash.exec("cat /w/keep");
    expect(check.stdout).toBe("keep");
  });

  it("runs a PATH script's abort through to the caller", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec(
      "printf 'sleep 2\\n' > job.sh; chmod +x job.sh; ./job.sh || touch LEAK",
      { signal },
    );
    expect(result.exitCode).toBe(124);
    const check = await bash.exec('test -e LEAK; echo "$?"');
    expect(check.stdout).toBe("1\n");
  });

  it("keeps the output produced before the abort", async () => {
    const { bash, signal } = createAbortingBash();
    const subshell = await bash.exec("( echo a; sleep 2 )", { signal });
    expect(subshell.exitCode).toBe(124);
    expect(subshell.stdout).toBe("a\n");
  });

  it("reports 124 when the abort lands in the last statement", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec("echo a; sleep 2", { signal });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("a\n");
  });

  it("does not leak captured text into the outer command", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec(
      'x=$(echo captured; sleep 2); echo "outer=$x"',
      { signal },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
  });

  it("restores prefix bindings before the abort leaves the command", async () => {
    const { bash, signal } = createAbortingBash();
    let snapshot: InterpreterStateSnapshot | undefined;
    await bash.exec("V=x eval 'sleep 2; echo'", {
      signal,
      onExecEnd: (s) => {
        snapshot = s;
      },
    });
    expect(snapshot?.env.find((entry) => entry.name === "V")).toBeUndefined();
  });

  it("does not put a |& stage's stderr in the stored stderr", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec("{ echo e >&2; sleep 9; } |& cat", {
      signal,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });

  it("keeps an earlier stage's stderr when a later stage aborts", async () => {
    const { bash, signal } = createAbortingBash();
    const result = await bash.exec("echo e >&2 | { sleep 9; }", { signal });
    expect(result.exitCode).toBe(124);
    // The cancelled stage reports the abort itself, after the earlier stage.
    expect(result.stderr).toBe("e\nbash: execution aborted\n");
  });

  it("stops xargs between items after an abort", async () => {
    const { bash, signal, marks } = createAbortingBash();
    await bash.exec("printf 'a\\nb\\n' | xargs -I {} mark {}", { signal });
    expect(marks).toEqual(["a"]);
  });

  it("stops find -exec between files after an abort", async () => {
    const { bash, signal, marks } = createAbortingBash();
    await bash.exec(
      "mkdir d; touch d/a d/b; find d -type f -exec mark {} \\;",
      { signal },
    );
    expect(marks).toHaveLength(1);
  });
});
