import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import type {
  BackgroundLaunch,
  InterpreterStateSnapshot,
} from "./interpreter/state-snapshot.js";

/**
 * A bash whose `&` statements go to a recording hook. The hook answers
 * job numbers 1, 2, ... or refuses every launch with a stderr line.
 */
function createBash(options?: { refuse?: boolean }) {
  const launches: BackgroundLaunch[] = [];
  let nextJob = 1;
  const bash = new Bash({
    cwd: "/docs",
    files: { "/docs/file": "docs", "/archive/file": "archive" },
  });
  const onBackground = async (launch: BackgroundLaunch) => {
    launches.push(launch);
    if (options?.refuse) {
      return { jobNumber: null, stderr: "refused\n" };
    }
    return { jobNumber: nextJob++, stderr: "" };
  };
  return { bash, launches, onBackground };
}

describe("onBackground", () => {
  it("hands the statement text, the live cwd and a snapshot to the hook", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec(
      "x=7\ncd /archive\necho $x hi &\necho after",
      {
        onBackground,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("after\n");
    expect(launches).toHaveLength(1);
    expect(launches[0].script).toBe("echo $x hi ");
    expect(launches[0].cwd).toBe("/archive");
    expect(launches[0].snapshot.env).toContainEqual({ name: "x", value: "7" });
  });

  it("sets $? to 0 and $! to the job number", async () => {
    const { bash, onBackground } = createBash();
    const result = await bash.exec('sleep 1 &\necho "$? $!"', { onBackground });
    expect(result.stdout).toBe("0 1\n");
  });

  it("appends the hook stderr and exits 1 when the launch is refused", async () => {
    const { bash, onBackground } = createBash({ refuse: true });
    const result = await bash.exec('echo hi &\necho "code=$?"', {
      onBackground,
    });
    expect(result.stderr).toBe("refused\n");
    expect(result.stdout).toBe("code=1\n");
  });

  it("keeps $! across a command substitution and a PATH script", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec(
      [
        "echo a &",
        "x=$(echo b &)",
        'echo "after subst $!"',
        "printf 'echo c &\\n' > job.sh",
        "chmod +x job.sh",
        "./job.sh",
        'echo "after script $!"',
      ].join("\n"),
      { onBackground },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("after subst 1\nafter script 1\n");
    expect(launches.map((launch) => launch.script)).toEqual([
      "echo a ",
      "echo b ",
      "echo c ",
    ]);
  });

  it("does not let a pipeline stage set the parent's $!", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec('{ echo hi & } | cat\necho "pid=$!"', {
      onBackground,
    });
    expect(launches).toHaveLength(1);
    expect(result.stdout).toBe("pid=0\n");
  });

  it("is not inherited by a nested exec, which runs & inline", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec("bash -c 'echo inner &'\necho outer", {
      onBackground,
    });
    expect(launches).toHaveLength(0);
    expect(result.stdout).toBe("inner\nouter\n");
  });

  it("still echoes the background line under set -v", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec("set -v\necho hi &", { onBackground });
    expect(result.stderr).toBe("echo hi &\n");
    expect(launches).toHaveLength(1);
  });

  it("stops the script under set -e when the launch is refused", async () => {
    const { bash, onBackground } = createBash({ refuse: true });
    const result = await bash.exec("set -e\necho hi &\necho CONTINUED", {
      onBackground,
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("keeps ! out of the launch status for ! cmd &", async () => {
    const { bash, onBackground } = createBash();
    const result = await bash.exec('! echo hi &\necho "code=$?"', {
      onBackground,
    });
    expect(result.stdout).toBe("code=0\n");
  });

  it("reports 1 for a refused ! cmd & launch", async () => {
    const { bash, onBackground } = createBash({ refuse: true });
    const result = await bash.exec('! echo hi &\necho "code=$?"', {
      onBackground,
    });
    expect(result.stdout).toBe("code=1\n");
  });

  it("exempts ! cmd & from set -e when the launch is refused", async () => {
    const { bash, onBackground } = createBash({ refuse: true });
    const result = await bash.exec("set -e\n! echo hi &\necho CONTINUED", {
      onBackground,
    });
    expect(result.stdout).toBe("CONTINUED\n");
    expect(result.exitCode).toBe(0);
  });

  it("runs the statement inline when it has no source text", async () => {
    const { bash, launches, onBackground } = createBash();
    bash.registerTransformPlugin({
      name: "drop-source-text",
      transform({ ast }) {
        for (const statement of ast.statements) {
          delete statement.sourceText;
        }
        return { ast };
      },
    });
    const result = await bash.exec("echo hi &", { onBackground });
    expect(launches).toHaveLength(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("includes the heredoc body in the launched script", async () => {
    const { bash, launches, onBackground } = createBash();
    await bash.exec("cat <<EOF &\nline one\nEOF\n", { onBackground });
    expect(launches).toHaveLength(1);
    expect(launches[0].script).toBe("cat <<EOF \nline one\nEOF\n");
    const replay = await new Bash().exec(launches[0].script);
    expect(replay.stdout).toBe("line one\n");
  });

  it("leaves an earlier statement's heredoc body out of the launched script", async () => {
    const { bash, launches, onBackground } = createBash();
    const result = await bash.exec(
      "cat <<A; while read x; do\na\nA\necho $x\ndone <<B &\nb\nB\n",
      { onBackground },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("a\n");
    expect(launches).toHaveLength(1);

    // A's body lines would run as commands inside the loop, so stderr is what
    // proves the launched script carries B's body and nothing of A's.
    const replay = await new Bash().exec(launches[0].script);
    expect(replay.stderr).toBe("");
    expect(replay.stdout).toBe("b\n");
    expect(launches[0].script).toBe(
      "while read x; do\necho $x\ndone <<B \nb\nB\n",
    );
  });

  it("takes the snapshot per launch, so a loop variable is captured per job", async () => {
    const { bash, launches, onBackground } = createBash();
    await bash.exec("for i in 1 2; do echo $i & done", { onBackground });
    expect(launches).toHaveLength(2);
    expect(launches[0].snapshot.env).toContainEqual({ name: "i", value: "1" });
    expect(launches[1].snapshot.env).toContainEqual({ name: "i", value: "2" });
  });
});

describe("onExecEnd and restoreState", () => {
  it("reaches onExecEnd with the state at exit", async () => {
    const bash = new Bash();
    let snapshot: InterpreterStateSnapshot | undefined;
    const result = await bash.exec("x=5; exit 0", {
      onExecEnd: (s) => {
        snapshot = s;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(snapshot?.env).toContainEqual({ name: "x", value: "5" });
  });

  it("reproduces variables, attributes, options and functions", async () => {
    const bash = new Bash({ cwd: "/docs", files: { "/docs/file": "docs" } });
    let snapshot: InterpreterStateSnapshot | undefined;
    await bash.exec(
      [
        "x=5",
        "declare -i n=3",
        "declare -A m; m[k]=v",
        "readonly ro=1",
        "export ex=2",
        "shopt -s extglob",
        "set -o pipefail",
        'f() { echo "f=$x"; }',
        ": marker",
        "(exit 3)",
      ].join("\n"),
      {
        onExecEnd: (s) => {
          snapshot = s;
        },
      },
    );
    expect(snapshot?.functions).toEqual([
      { name: "f", text: 'f() { echo "f=$x"; }' },
    ]);
    expect(snapshot?.lastArg).toBe("marker");
    expect(snapshot?.lastExitCode).toBe(3);

    const second = await new Bash({ cwd: "/docs" }).exec(
      [
        'echo "$x|$n|${m[k]}|$ex|$_|$?"',
        "f",
        "declare -p n ro ex m",
        "shopt -q extglob && echo extglob_on",
        'false | true; echo "pipefail=$?"',
      ].join("\n"),
      { restoreState: snapshot },
    );
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe(
      [
        "5|3|v|2|marker|3",
        "f=5",
        'declare -i n="3"',
        'declare -r ro="1"',
        'declare -x ex="2"',
        "declare -A m=(['k']=v)",
        "extglob_on",
        "pipefail=1",
        "",
      ].join("\n"),
    );
  });

  it("reproduces the cd history and sets PWD to the exec cwd", async () => {
    const bash = new Bash({
      cwd: "/docs",
      files: { "/docs/file": "docs", "/archive/file": "archive" },
    });
    let snapshot: InterpreterStateSnapshot | undefined;
    const first = await bash.exec(
      "cd /archive\npushd /docs > /dev/null\ndirs",
      {
        onExecEnd: (s) => {
          snapshot = s;
        },
      },
    );
    expect(snapshot?.previousDir).toBe("/archive");

    const second = await bash.exec("dirs\ncd - > /dev/null\npwd", {
      cwd: "/docs",
      restoreState: snapshot,
    });
    expect(second.stdout).toBe(`${first.stdout}/archive\n`);

    const third = await bash.exec('echo "$PWD"', {
      cwd: "/archive",
      restoreState: snapshot,
    });
    expect(third.stdout).toBe("/archive\n");
  });
});

describe("job control builtins", () => {
  it("runs a registered wait command", async () => {
    const bash = new Bash({
      customCommands: [
        {
          name: "wait",
          async execute() {
            return { stdout: "custom wait\n", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("wait");
    expect(result.stdout).toBe("custom wait\n");
  });

  it("keeps wait as a no-op when nothing is registered", async () => {
    const result = await new Bash().exec('wait; echo "w=$?"');
    expect(result.stdout).toBe("w=0\n");
  });

  it("no longer lists jobs as a shell builtin", async () => {
    const result = await new Bash().exec("type jobs");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("bash: type: jobs: not found\n");
    const wait = await new Bash().exec("type wait");
    expect(wait.stdout).toBe("wait is a shell builtin\n");
  });

  it("has no built-in help for wait", async () => {
    // A host registers its own `wait` with its own flags, so bash's text would
    // list options that do not exist. `wait --help` is the one answer.
    const result = await new Bash().exec("help wait");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "bash: help: no help topics match `wait'.  Try `help help' or `man -k wait' or `info wait'.\n",
    );
  });
});
