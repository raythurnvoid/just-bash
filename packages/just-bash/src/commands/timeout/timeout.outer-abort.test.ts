import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("timeout with an outer abort signal", () => {
  it("stops the inner command promptly when the outer signal aborts", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const started = Date.now();
    const result = await new Bash().exec("timeout 60 sleep 300", {
      signal: abort.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  // A timed-out command drops its own output on purpose, but the statements
  // that ran before the abort keep theirs: the host stores them as the
  // transcript of the stopped call.
  it("keeps the output the script produced before the abort", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const result = await new Bash().exec("echo hi; timeout 60 sleep 300", {
      signal: abort.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("hi\n");
  });
});
