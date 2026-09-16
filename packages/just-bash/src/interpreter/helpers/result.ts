/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 */

import type { ExecResult } from "../../types.js";
import { ExecutionAbortedError, ExecutionLimitError } from "../errors.js";
import type { InterpreterContext } from "../types.js";

/**
 * A successful result with no output.
 * Use this for commands that succeed silently.
 */
export const OK: ExecResult = Object.freeze({
  stdout: "",
  stderr: "",
  exitCode: 0,
  internalStdinConsumed: 0,
});

/**
 * Create a successful result with optional stdout.
 *
 * @param stdout - Output to include (default: "")
 * @returns ExecResult with exitCode 0
 */
export function success(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * Create a failure result with stderr message.
 *
 * @param stderr - Error message to include
 * @param exitCode - Exit code (default: 1)
 * @returns ExecResult with the specified exitCode
 */
export function failure(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

/**
 * Create a result with all fields specified.
 *
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param exitCode - Exit code
 * @returns ExecResult with all fields
 */
export function result(
  stdout: string,
  stderr: string,
  exitCode: number,
): ExecResult {
  return { stdout, stderr, exitCode };
}

/**
 * Convert a boolean test result to an ExecResult.
 * Useful for test/conditional commands where true = exit 0, false = exit 1.
 *
 * @param passed - Boolean test result
 * @returns ExecResult with exitCode 0 if passed, 1 otherwise
 */
export function testResult(passed: boolean): ExecResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: passed ? 0 : 1,
    internalStdinConsumed: 0,
  };
}

/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 *
 * @param message - Error message describing the limit exceeded
 * @param limitType - Type of limit exceeded
 * @param stdout - Accumulated stdout to include
 * @param stderr - Accumulated stderr to include
 * @throws ExecutionLimitError always
 */
export function throwExecutionLimit(
  message: string,
  limitType:
    | "recursion"
    | "iterations"
    | "commands"
    | "string_length"
    | "glob_operations"
    | "substitution_depth"
    | "output_size"
    | "file_descriptors",
  stdout = "",
  stderr = "",
): never {
  throw new ExecutionLimitError(message, limitType, stdout, stderr);
}

/**
 * Throw ExecutionAbortedError when the exec signal is already aborted.
 *
 * Use it right after a nested run returns (eval, source, `$(...)`, a script
 * run by execFn). A nested run that ends while the signal is aborted may
 * have returned a plain result instead of throwing, and the next statement
 * of the caller would run. The output so far travels with the error so
 * Bash.exec can still report it.
 */
export function throwIfAborted(
  ctx: InterpreterContext,
  stdout = "",
  stderr = "",
): void {
  if (ctx.state.signal?.aborted) {
    throw new ExecutionAbortedError(stdout, stderr);
  }
}

/**
 * Check file descriptor count against the limit before adding a new one.
 * Throws ExecutionLimitError if the limit would be exceeded.
 */
export function checkFdLimit(ctx: InterpreterContext): void {
  const fds = ctx.state.fileDescriptors;
  if (fds && fds.size >= ctx.limits.maxFileDescriptors) {
    throw new ExecutionLimitError(
      `too many open file descriptors (max ${ctx.limits.maxFileDescriptors})`,
      "file_descriptors",
    );
  }
}
