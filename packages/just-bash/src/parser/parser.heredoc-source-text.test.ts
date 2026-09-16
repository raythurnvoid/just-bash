import { describe, expect, it } from "vitest";
import type { FunctionDefNode } from "../ast/types.js";
import { parse } from "./parser.js";

function functionDef(script: string, index = 0): FunctionDefNode {
  const node = parse(script).statements[index].pipelines[0].commands[0];
  if (node.type !== "FunctionDef") {
    throw new Error(`expected a FunctionDef, got ${node.type}`);
  }
  return node;
}

describe("statement sourceText with heredocs", () => {
  it("covers the body of a simple command", () => {
    const ast = parse("cat <<EOF\nbody\nEOF\n");
    expect(ast.statements[0].sourceText).toBe("cat <<EOF\nbody\nEOF\n");
  });

  it("covers the body of a pipeline", () => {
    const ast = parse("cat <<EOF | tr a-z A-Z\nbody\nEOF\n");
    expect(ast.statements[0].sourceText).toBe(
      "cat <<EOF | tr a-z A-Z\nbody\nEOF\n",
    );
  });

  it("covers the body of a compound command", () => {
    const script = "while read l; do echo $l; done <<EOF\none\ntwo\nEOF\n";
    const ast = parse(script);
    expect(ast.statements[0].sourceText).toBe(script);
  });

  it("covers two heredocs of one statement", () => {
    const script = "cat <<A <<B\na\nA\nb\nB\n";
    const ast = parse(script);
    expect(ast.statements[0].sourceText).toBe(script);
  });

  it("gives each statement on the line only its own bodies", () => {
    const ast = parse("cat <<EOF & echo hi\nbody\nEOF\n");
    expect(ast.statements[0].sourceText).toBe("cat <<EOF &\nbody\nEOF\n");
    expect(ast.statements[1].sourceText).toBe("echo hi");

    const two = parse("cat <<A; cat <<B &\na\nA\nb\nB\n");
    expect(two.statements[0].sourceText).toBe("cat <<A\na\nA\n");
    expect(two.statements[1].sourceText).toBe("cat <<B &\nb\nB\n");
  });

  it("keeps only its own body when a newline inside a loop drains the list", () => {
    const ast = parse(
      "cat <<A; while read x; do\na\nA\necho $x\ndone <<B &\nb\nB\n",
    );
    expect(ast.statements[0].sourceText).toBe("cat <<A\na\nA\n");
    expect(ast.statements[1].sourceText).toBe(
      "while read x; do\necho $x\ndone <<B &\nb\nB\n",
    );
    // The & moved with the cut, so it still points at the & in the new text
    expect(ast.statements[1].backgroundTokenOffset).toBe(34);
  });

  it("keeps only its own body when a newline inside a group drains the list", () => {
    const ast = parse("cat <<A; { cat <<B\na\nA\nb\nB\n} <<C &\nc\nC\n");
    expect(ast.statements[0].sourceText).toBe("cat <<A\na\nA\n");
    expect(ast.statements[1].sourceText).toBe(
      "{ cat <<B\nb\nB\n} <<C &\nc\nC\n",
    );
    expect(ast.statements[1].backgroundTokenOffset).toBe(20);
  });

  it("records the offset of the & token", () => {
    const ast = parse("echo hi &");
    expect(ast.statements[0].background).toBe(true);
    expect(ast.statements[0].backgroundTokenOffset).toBe(8);

    const plain = parse("echo hi");
    expect(plain.statements[0].backgroundTokenOffset).toBeUndefined();
  });
});

describe("FunctionDefNode.sourceText", () => {
  it.each([
    "f() { cat <<EOF\nbody\nEOF\n}",
    "function f { cat <<EOF\nbody\nEOF\n}",
  ])("covers the definition with its heredoc body: %s", (script) => {
    expect(functionDef(script).sourceText).toBe(script);
  });

  it("covers a one-line body whose heredoc follows the definition", () => {
    const ast = parse("f() { cat <<EOF; }\nbody\nEOF\n");
    const node = ast.statements[0].pipelines[0].commands[0] as FunctionDefNode;
    expect(node.sourceText).toBe("f() { cat <<EOF; }\nbody\nEOF\n");
  });

  it("keeps its own body and drops an earlier statement's", () => {
    const script = "cat <<A; f() { cat <<B\na\nA\nb\nB\n}\n";
    expect(functionDef(script, 1).sourceText).toBe("f() { cat <<B\nb\nB\n}");
    expect(parse(script).statements[1].sourceText).toBe(
      "f() { cat <<B\nb\nB\n}",
    );
  });

  it("round-trips through parse", () => {
    const original = functionDef('f() {\n  echo "a b"\n  return 3\n}');
    expect(original.sourceText).toBeDefined();
    const again = functionDef(original.sourceText as string);
    expect(again.name).toBe("f");
    expect(again.sourceText).toBe(original.sourceText);
  });
});
