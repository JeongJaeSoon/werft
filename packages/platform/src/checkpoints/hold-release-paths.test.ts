import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * `protectedCommits` takes a version the held pointer names without a HEAD
 * (checkpoint-service.ts), on the word that nothing lifts its hold while the
 * pointer or its fallback window names it. Collection keeps exactly those
 * (checkpoint-collector.test.ts, "lifts no hold the pointer or its fallback
 * window names"); this pins that collection is the only way a hold is lifted.
 */

const ROOT = join(import.meta.dir, "../../../..");
// Test doubles lift holds on purpose (testkit's memory store).
const SKIPPED = new Set(["node_modules", "dist", "testkit", "testing"]);

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|e2e|conformance)\.tsx?$/.test(entry.name)
    ) {
      found.push(path);
    }
  }
  return found;
}

type Site = { file: string; within: string | undefined };

function enclosingName(node: ts.Node): string | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isMethodDeclaration(at) ||
        ts.isFunctionDeclaration(at) ||
        ts.isPropertyAssignment(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
  }
  return undefined;
}

/** A legal hold set to anything but the literal "ON". */
function liftsHold(node: ts.NewExpression): boolean {
  if (node.expression.getText() !== "PutObjectLegalHoldCommand") return false;
  const [input] = node.arguments ?? [];
  if (input === undefined || !ts.isObjectLiteralExpression(input)) return true;
  const hold = input.properties.find(
    (property) => property.name?.getText() === "LegalHold",
  );
  if (
    hold === undefined ||
    !ts.isPropertyAssignment(hold) ||
    !ts.isObjectLiteralExpression(hold.initializer)
  ) {
    return true;
  }
  const status = hold.initializer.properties.find(
    (property) => property.name?.getText() === "Status",
  );
  return !(
    status !== undefined &&
    ts.isPropertyAssignment(status) &&
    ts.isStringLiteral(status.initializer) &&
    status.initializer.text === "ON"
  );
}

function scan() {
  const lifts: Site[] = [];
  const purges: Site[] = [];
  for (const path of [
    ...sources(join(ROOT, "packages")),
    ...sources(join(ROOT, "apps")),
  ]) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("LegalHold") && !text.includes("purge(")) continue;
    const file = relative(ROOT, path);
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && liftsHold(node)) {
        lifts.push({ file, within: enclosingName(node) });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "purge"
      ) {
        purges.push({ file, within: enclosingName(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { lifts, purges };
}

describe("a legal hold is lifted only by collection", () => {
  test("the one command that lifts a hold is the store's purge, and only the collector calls purge", () => {
    const { lifts, purges } = scan();
    expect(lifts).toEqual([
      { file: "packages/storage/src/checkpoint-objects.ts", within: "purge" },
    ]);
    expect(purges.map((site) => site.file)).toEqual([
      "packages/platform/src/checkpoints/checkpoint-collector.ts",
    ]);
  }, 30_000);
});
