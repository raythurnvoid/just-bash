/**
 * Interpreter State Snapshot
 *
 * A JSON-safe copy of the interpreter state that a host can keep between
 * exec calls and seed back into a later exec: variables, arrays, shell
 * options, variable attributes, function definitions and the cd history.
 *
 * Not carried on purpose: the cwd (the host owns it), local scopes (already
 * inside env), the call stack, counters and virtual pids, completion specs
 * and the hash table. Open extra fds are reported but never restored.
 */

import type { FunctionDefNode } from "../ast/types.js";
import { parse } from "../parser/parser.js";
import type { InterpreterState, ShellOptions, ShoptOptions } from "./types.js";

export interface InterpreterStateSnapshot {
  /**
   * Every env entry as a pair. A pair list, not an object, so keys with
   * non-ASCII characters (associative array keys) stay storable everywhere.
   */
  env: { name: string; value: string }[];
  /** Indexed and associative arrays. They live next to env, not inside it. */
  arrays: {
    name: string;
    kind: "indexed" | "associative";
    elements: { key: string; value: string }[];
  }[];
  options: Partial<ShellOptions>;
  shoptOptions: Partial<ShoptOptions>;
  readonlyVars: string[];
  associativeArrays: string[];
  namerefs: string[];
  boundNamerefs: string[];
  invalidNamerefs: string[];
  integerVars: string[];
  lowercaseVars: string[];
  uppercaseVars: string[];
  exportedVars: string[];
  declaredVars: string[];
  /** Function definitions as source text. Restore parses each one again. */
  functions: { name: string; text: string }[];
  previousDir: string;
  directoryStack: string[];
  lastExitCode: number;
  lastArg: string;
  /** Extra fds still open at the end of the exec (`exec 3>out`). Report only. */
  openFileDescriptors: number[];
}

/** What the background hook receives for one `&` statement. */
export interface BackgroundLaunch {
  /** The statement text with the `&` cut out. */
  script: string;
  /** The live cwd at the `&`, which can differ from the exec's starting cwd. */
  cwd: string;
  /** The state at the `&`, taken per launch so a loop variable is captured per job. */
  snapshot: InterpreterStateSnapshot;
}

/** What the background hook answers. */
export interface BackgroundResult {
  /** The job number, or null when the launch was refused. */
  jobNumber: number | null;
  /** Text the interpreter appends to the statement's stderr. */
  stderr: string;
}

export function snapshotInterpreterState(
  state: InterpreterState,
): InterpreterStateSnapshot {
  const functions: { name: string; text: string }[] = [];
  for (const [name, def] of state.functions) {
    if (def.sourceText !== undefined) {
      functions.push({ name, text: def.sourceText });
    }
  }

  return {
    env: Array.from(state.env, ([name, value]) => ({ name, value })),
    arrays: Array.from(state.arrays ?? [], ([name, array]) => ({
      name,
      kind: array.kind,
      elements: Array.from(array.elements, ([key, value]) => ({ key, value })),
    })),
    options: { ...state.options },
    shoptOptions: { ...state.shoptOptions },
    readonlyVars: [...(state.readonlyVars ?? [])],
    associativeArrays: [...(state.associativeArrays ?? [])],
    namerefs: [...(state.namerefs ?? [])],
    boundNamerefs: [...(state.boundNamerefs ?? [])],
    invalidNamerefs: [...(state.invalidNamerefs ?? [])],
    integerVars: [...(state.integerVars ?? [])],
    lowercaseVars: [...(state.lowercaseVars ?? [])],
    uppercaseVars: [...(state.uppercaseVars ?? [])],
    exportedVars: [...(state.exportedVars ?? [])],
    declaredVars: [...(state.declaredVars ?? [])],
    functions,
    previousDir: state.previousDir,
    directoryStack: [...(state.directoryStack ?? [])],
    lastExitCode: state.lastExitCode,
    lastArg: state.lastArg,
    openFileDescriptors: [...(state.fileDescriptors?.keys() ?? [])],
  };
}

/**
 * Seed an exec state from a snapshot. The env is replaced by the snapshot
 * pairs; options merge over the current defaults so an option unknown to an
 * old snapshot keeps its default. The caller sets PWD afterwards.
 */
export function restoreInterpreterState(
  state: InterpreterState,
  snapshot: InterpreterStateSnapshot,
): void {
  state.env = new Map(snapshot.env.map((entry) => [entry.name, entry.value]));
  state.arrays = new Map(
    snapshot.arrays.map((array) => [
      array.name,
      {
        kind: array.kind,
        elements: new Map(
          array.elements.map((element) => [element.key, element.value]),
        ),
      },
    ]),
  );
  state.options = { ...state.options, ...snapshot.options };
  state.shoptOptions = { ...state.shoptOptions, ...snapshot.shoptOptions };
  state.readonlyVars = new Set(snapshot.readonlyVars);
  state.associativeArrays = new Set(snapshot.associativeArrays);
  state.namerefs = new Set(snapshot.namerefs);
  state.boundNamerefs = new Set(snapshot.boundNamerefs);
  state.invalidNamerefs = new Set(snapshot.invalidNamerefs);
  state.integerVars = new Set(snapshot.integerVars);
  state.lowercaseVars = new Set(snapshot.lowercaseVars);
  state.uppercaseVars = new Set(snapshot.uppercaseVars);
  state.exportedVars = new Set(snapshot.exportedVars);
  state.declaredVars = new Set(snapshot.declaredVars);

  // Parse the definition text and store the node directly. Running the text
  // through exec would count against maxCommandCount and fire the hooks.
  state.functions = new Map();
  for (const fn of snapshot.functions) {
    const node = parseFunctionDefText(fn.text);
    if (node) {
      state.functions.set(fn.name, node);
    }
  }

  state.previousDir = snapshot.previousDir;
  state.directoryStack = [...snapshot.directoryStack];
  state.lastExitCode = snapshot.lastExitCode;
  state.lastArg = snapshot.lastArg;
}

function parseFunctionDefText(text: string): FunctionDefNode | null {
  let node: unknown;
  try {
    node = parse(text).statements[0]?.pipelines[0]?.commands[0];
  } catch {
    return null;
  }
  if (
    typeof node === "object" &&
    node !== null &&
    (node as FunctionDefNode).type === "FunctionDef"
  ) {
    return node as FunctionDefNode;
  }
  return null;
}
