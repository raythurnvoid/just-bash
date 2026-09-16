import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

/**
 * A bash whose live output goes to a recording hook. `chunks` keeps one
 * entry per hook call in order.
 */
function createBash() {
  const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const bash = new Bash({
    cwd: "/work",
    files: { "/work/lines": "one\ntwo\n" },
    onOutput: (stream, text) => {
      chunks.push({ stream, text });
    },
  });
  const stdout = () =>
    chunks.filter((c) => c.stream === "stdout").map((c) => c.text);
  const stderr = () =>
    chunks.filter((c) => c.stream === "stderr").map((c) => c.text);
  return { bash, chunks, stdout, stderr };
}

describe("onOutput", () => {
  it("streams each statement once, in order, and matches the result", async () => {
    const { bash, stdout, stderr } = createBash();
    const result = await bash.exec("echo a\necho b >&2\necho c");
    expect(stdout()).toEqual(["a\n", "c\n"]);
    expect(stderr()).toEqual(["b\n"]);
    expect(stdout().join("")).toBe(result.stdout);
    expect(stderr().join("")).toBe(result.stderr);
  });

  it("streams a for body per iteration", async () => {
    const { bash, stdout } = createBash();
    const result = await bash.exec("for i in 1 2 3; do echo $i; done");
    expect(stdout()).toEqual(["1\n", "2\n", "3\n"]);
    expect(result.stdout).toBe("1\n2\n3\n");
  });

  it("streams a while body per iteration", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("while read -r l; do echo got $l; done < lines");
    expect(stdout()).toEqual(["got one\n", "got two\n"]);
  });

  it("streams a pipeline as one chunk from the last stage", async () => {
    const { bash, stdout } = createBash();
    const result = await bash.exec("printf 'a\\nb\\n' | wc -l");
    expect(stdout()).toEqual([result.stdout]);
    expect(result.stdout.trim()).toBe("2");
  });

  it("keeps a group inside a pipeline silent", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("{ echo x; echo y; } | cat");
    expect(stdout()).toEqual(["x\ny\n"]);
  });

  it("streams stderr of a non-last stage but not under |&", async () => {
    const { bash, stderr } = createBash();
    await bash.exec("{ echo e1 >&2; echo p; } | cat\n{ echo e2 >&2; } |& cat");
    expect(stderr()).toEqual(["e1\n"]);
  });

  it("keeps command substitution silent", async () => {
    const { bash, stdout } = createBash();
    await bash.exec('x=$(echo hidden; echo more)\necho "got $x"');
    expect(stdout()).toEqual(["got hidden\nmore\n"]);
  });

  it("keeps a nested exec inside command substitution silent", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("x=$(bash -c 'echo hidden')\necho got $x");
    expect(stdout()).toEqual(["got hidden\n"]);
  });

  it("does not repeat what eval streamed", async () => {
    const { bash, stdout } = createBash();
    const result = await bash.exec("eval 'echo a; echo b'");
    expect(stdout()).toEqual(["a\n", "b\n"]);
    expect(result.stdout).toBe("a\nb\n");
  });

  it("does not repeat what a function streamed", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("f() { echo in1; echo in2; }\nf\necho after");
    expect(stdout()).toEqual(["in1\n", "in2\n", "after\n"]);
  });

  it("does not repeat what a nested bash -c streamed", async () => {
    const { bash, stdout } = createBash();
    const result = await bash.exec("bash -c 'echo n1; echo n2'\necho after");
    expect(stdout()).toEqual(["n1\n", "n2\n", "after\n"]);
    expect(result.stdout).toBe("n1\nn2\nafter\n");
  });

  it("does not repeat what xargs streamed", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("printf 'a b' | xargs -n 1 echo");
    expect(stdout()).toEqual(["a\n", "b\n"]);
  });

  it("does not repeat what a subshell or a group streamed", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("( echo s1; echo s2 )\n{ echo g1; echo g2; }");
    expect(stdout()).toEqual(["s1\n", "s2\n", "g1\n", "g2\n"]);
  });

  it("does not repeat what an if or case body streamed", async () => {
    const { bash, stdout } = createBash();
    await bash.exec(
      "if true; then echo i1; echo i2; fi\ncase x in x) echo c1; echo c2;; esac",
    );
    expect(stdout()).toEqual(["i1\n", "i2\n", "c1\n", "c2\n"]);
  });

  it("keeps a redirected group silent and streams the later read", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("{ echo a; echo b; } > out\ncat out");
    expect(stdout()).toEqual(["a\nb\n"]);
  });

  it("keeps a redirected loop silent", async () => {
    const { bash, stdout } = createBash();
    await bash.exec("for i in 1 2; do echo $i; done > out\ncat out");
    expect(stdout()).toEqual(["1\n2\n"]);
  });

  it("streams nothing for a redirected simple command", async () => {
    const { bash, chunks } = createBash();
    await bash.exec("echo a > f\necho b 2> g");
    expect(chunks).toEqual([{ stream: "stdout", text: "b\n" }]);
  });

  it("streams the launch line of a background statement", async () => {
    const { bash, chunks } = createBash();
    await bash.exec("echo bg &", {
      onBackground: async () => ({ jobNumber: null, stderr: "refused\n" }),
    });
    expect(chunks).toEqual([{ stream: "stderr", text: "refused\n" }]);
  });

  it("stays quiet without a hook", async () => {
    const bash = new Bash({ cwd: "/work" });
    const result = await bash.exec("echo a\nfor i in 1 2; do echo $i; done");
    expect(result.stdout).toBe("a\n1\n2\n");
  });
});
