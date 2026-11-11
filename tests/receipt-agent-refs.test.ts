import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { RECEIPT_OPERATION_VALUES } from "@werft-ai/contracts";
import { RECEIPT_AGENT_REFS } from "@werft-ai/platform";
import * as ts from "typescript";

// 94S-902: a receipt that names an agent or one of its releases is masked for
// a reader who may not use that agent, through the table in
// packages/platform/src/sessions/receipt-agent-refs.ts. This reads the code
// that writes receipts and fails where an operation puts an agent or release
// id in one and the table has no row for it.

const root = join(import.meta.dir, "..");
const roots = [
  join(root, "packages", "db", "src"),
  join(root, "packages", "platform", "src"),
  join(root, "apps", "control-host", "src"),
];
const OPERATIONS = new Set<string>(RECEIPT_OPERATION_VALUES);

// A key that holds an agent or release id.
const REF_KEY =
  /^(agent_?ids?|usage_agent_ids|agent_?release_?id|release_?id|previous_release_id)$/;
const RECEIPT_PARTS = new Set(["result", "targetRef", "target_ref"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

function nameOf(prop: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop))
    return null;
  const name = prop.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function literals(node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  }
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  return [];
}

// Whether the tree holds an agent or release id: a key named for one, or a
// `{ kind: "agent" | "agent_release" }` resource.
function namesAgent(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isObjectLiteralExpression(child)) {
      for (const prop of child.properties) {
        const name = nameOf(prop);
        if (name !== null && REF_KEY.test(name)) found = true;
        if (
          name === "kind" &&
          ts.isPropertyAssignment(prop) &&
          ts.isStringLiteralLike(prop.initializer) &&
          ["agent", "agent_release"].includes(prop.initializer.text)
        ) {
          found = true;
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

export type Carrier = { file: string; operations: string[] };

// What a name is given in this file, by declaration or assignment: a receipt's
// `result` is often built apart and passed by name.
function bindingsOf(source: ts.SourceFile): Map<string, ts.Node[]> {
  const bound = new Map<string, ts.Node[]>();
  const add = (name: string, value: ts.Node) =>
    bound.set(name, [...(bound.get(name) ?? []), value]);
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      add(node.name.text, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      add(node.left.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bound;
}

/**
 * The operations a file writes a receipt for with an agent or release id in
 * it. An `operation` that is not a literal (a parameter) counts every
 * operation the file names, as the writer may be called with any of them.
 */
export function carriersIn(file: string, text: string): Carrier {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = bindingsOf(source);
  const named = new Set<string>();
  const visitNames = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && OPERATIONS.has(node.text)) {
      named.add(node.text);
    }
    ts.forEachChild(node, visitNames);
  };
  visitNames(source);
  const operations = new Set<string>();
  const carries = (prop: ts.ObjectLiteralElementLike) => {
    if (!RECEIPT_PARTS.has(nameOf(prop) ?? "")) return false;
    if (namesAgent(prop)) return true;
    const value = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : null;
    return (
      value !== null &&
      ts.isIdentifier(value) &&
      (bindings.get(value.text) ?? []).some(namesAgent)
    );
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const op = node.properties.find((prop) => nameOf(prop) === "operation");
      if (op && node.properties.some(carries)) {
        const fixed = ts.isPropertyAssignment(op)
          ? literals(op.initializer).filter((name) => OPERATIONS.has(name))
          : [];
        for (const name of fixed.length > 0 ? fixed : named) {
          operations.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, operations: [...operations].sort() };
}

describe("receipt operations that carry an agent id", () => {
  test("every operation the code writes with one has a row in the table", () => {
    const missing: string[] = [];
    for (const dir of roots) {
      for (const file of sourceFiles(dir)) {
        const { operations } = carriersIn(file, readFileSync(file, "utf8"));
        for (const op of operations) {
          if (!(op in RECEIPT_AGENT_REFS)) {
            missing.push(`${op} (${relative(root, file)})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the guard fails on an operation the table does not list", () => {
    const sample = `
      await tx.insert(receipts).values({
        operation: "unlisted_example_operation",
        targetRef: { resource: { kind: "agent", id: agentId } },
      });
      await tx.insert(receipts).values({
        operation: "delete_team",
        result: { agent_ids: [] },
      });
    `;
    // Only names in the contract's operation list count, so the sample uses a
    // real one that no row covers.
    const unlisted = RECEIPT_OPERATION_VALUES.find(
      (op) => !(op in RECEIPT_AGENT_REFS),
    );
    if (unlisted === undefined) throw new Error("every operation has a row");
    const carried = carriersIn(
      "sample.ts",
      sample.replace("unlisted_example_operation", unlisted),
    );
    expect(carried.operations).toContain(unlisted);
    expect(
      carried.operations.filter((op) => !(op in RECEIPT_AGENT_REFS)),
    ).toEqual([unlisted]);
  });

  test("every row names an operation the contract has", () => {
    for (const op of Object.keys(RECEIPT_AGENT_REFS)) {
      expect(OPERATIONS.has(op)).toBe(true);
    }
  });
});
