import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("js-exec with an outer abort signal", () => {
  it(
    "stops an execSync child promptly when the outer signal aborts",
    { timeout: 30000 },
    async () => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const started = Date.now();
      const result = await new Bash({ javascript: true }).exec(
        `js-exec -c "require('child_process').execSync('sleep 300')"`,
        { signal: abort.signal },
      );
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(10000);
    },
  );

  it(
    "keeps its own deadline when the outer signal stays quiet",
    { timeout: 30000 },
    async () => {
      const abort = new AbortController();
      const bash = new Bash({
        javascript: true,
        executionLimits: { maxJsTimeoutMs: 200 },
      });
      const result = await bash.exec(
        `js-exec -c "require('child_process').execSync('sleep 300')"`,
        { signal: abort.signal },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("timeout");
    },
  );

  it(
    "terminates a hung worker on the outer abort",
    { timeout: 30000 },
    async () => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const started = Date.now();
      const result = await new Bash({ javascript: true }).exec(
        `js-exec -c "while (true) {}"`,
        { signal: abort.signal },
      );
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(10000);
    },
  );
});
