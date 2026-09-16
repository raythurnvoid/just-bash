/**
 * Statement Boundaries
 *
 * A host can watch the top-level statements of an exec through the
 * `onStatementBoundary` hook. Before each statement the hook receives the
 * statement text, the text of everything still to run and a lazy state
 * snapshot, and answers `run` or `stop`. `stop` ends the exec before the
 * statement, with the output the earlier statements produced. The host can
 * run the remaining text later with `restoreState`.
 */

import type { CommandNode, StatementNode, WordNode } from "../ast/types.js";
import { parseDuration } from "../commands/duration.js";
import type { InterpreterStateSnapshot } from "./state-snapshot.js";

/** What the boundary hook receives before one top-level statement. */
export interface StatementBoundary {
  /** The statement about to run, as source text. */
  script: string;
  /** This statement and every statement after it, one per line. */
  remainingScript: () => string;
  /** Every statement after this one, one per line. Empty for the last one. */
  scriptAfter: () => string;
  /**
   * The total sleep in ms when the statement is a bare `sleep` with literal
   * durations (`sleep 30`, `sleep 1m 30s`), else null. `sleep $n`, a sleep
   * in a pipeline, with `&&`, `&` or a redirection is not bare. The value is
   * not capped like the sleep command caps its own wait.
   */
  sleepMs: number | null;
  /** The state right now, taken like `onExecEnd`. Call it only when needed. */
  snapshot: () => InterpreterStateSnapshot;
}

/** `run` runs the statement. `stop` ends the exec before it. */
export type StatementBoundaryDecision = "run" | "stop";

/**
 * The statements the hook sees. A script that is one bare `{ ...; }` group
 * (one pipeline, one command, no `!`, no `&`, no redirection) runs its body
 * in the current shell exactly like the same statements written in a row, so
 * the body statements become the boundaries. This is what `{ a; sleep 30; b; } &`
 * hands to a background hook.
 */
export function boundaryStatements(
  statements: StatementNode[],
): StatementNode[] {
  if (statements.length !== 1) return statements;
  const command = soleCommand(statements[0]);
  if (!command || command.type !== "Group" || command.redirections.length > 0) {
    return statements;
  }
  return boundaryStatements(command.body);
}

/** The total ms of a bare `sleep` with literal durations, else null. */
export function bareSleepMs(statement: StatementNode): number | null {
  const command = soleCommand(statement);
  if (
    !command ||
    command.type !== "SimpleCommand" ||
    command.name === null ||
    command.assignments.length > 0 ||
    command.redirections.length > 0
  ) {
    return null;
  }
  const name = literalWord(command.name);
  if (name !== "sleep" || command.args.length === 0) return null;
  let totalMs = 0;
  for (const arg of command.args) {
    const word = literalWord(arg);
    if (word === null) return null;
    const ms = parseDuration(word);
    if (ms === null) return null;
    totalMs += ms;
  }
  return totalMs;
}

/** The one command of a statement that is one plain pipeline of one command. */
function soleCommand(statement: StatementNode): CommandNode | null {
  if (statement.background || statement.pipelines.length !== 1) return null;
  const pipeline = statement.pipelines[0];
  if (pipeline.negated || pipeline.timed || pipeline.commands.length !== 1) {
    return null;
  }
  return pipeline.commands[0];
}

/** The text of a word made of literal and single-quoted parts only. */
function literalWord(word: WordNode): string | null {
  let text = "";
  for (const part of word.parts) {
    if (part.type !== "Literal" && part.type !== "SingleQuoted") return null;
    text += part.value;
  }
  return text;
}
