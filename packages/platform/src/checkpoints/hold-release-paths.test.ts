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
// The S3 commands that can take a version's protection away.
const LIFTING = new Set([
  "PutObjectLegalHoldCommand",
  "PutObjectRetentionCommand",
  "PutObjectLockConfigurationCommand",
]);

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

type Site = { file: string; what: string; within: string | undefined };

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

const propertyName = (property: ts.ObjectLiteralElementLike) =>
  property.name !== undefined &&
  (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;

/** A legal hold input whose status is anything but the literal "ON". */
function holdNotOn(input: ts.Expression | undefined): boolean {
  if (input === undefined || !ts.isObjectLiteralExpression(input)) return true;
  const hold = input.properties.find((p) => propertyName(p) === "LegalHold");
  if (
    hold === undefined ||
    !ts.isPropertyAssignment(hold) ||
    !ts.isObjectLiteralExpression(hold.initializer)
  ) {
    return true;
  }
  const status = hold.initializer.properties.find(
    (p) => propertyName(p) === "Status",
  );
  return !(
    status !== undefined &&
    ts.isPropertyAssignment(status) &&
    ts.isStringLiteral(status.initializer) &&
    status.initializer.text === "ON"
  );
}

function scanSource(file: string, text: string) {
  const lifts: Site[] = [];
  const purges: Site[] = [];
  const imports: Site[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // Local names for the lifting commands, aliases and namespaces included.
  const commands = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@aws-sdk/client-s3"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (LIFTING.has(imported)) {
          commands.set(element.name.text, imported);
          imports.push({ file, what: imported, within: undefined });
        }
      }
    }
  }
  const commandOf = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return commands.get(expression.text);
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      LIFTING.has(expression.name.text)
    ) {
      return expression.name.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const command = commandOf(node.expression);
      if (
        command !== undefined &&
        (command !== "PutObjectLegalHoldCommand" ||
          holdNotOn(node.arguments?.[0]))
      ) {
        lifts.push({ file, what: command, within: enclosingName(node) });
      }
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      propertyName(node) === "BypassGovernanceRetention"
    ) {
      lifts.push({
        file,
        what: "BypassGovernanceRetention",
        within: enclosingName(node),
      });
    }
    const purgeCall =
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "purge") ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isStringLiteralLike(node.expression.argumentExpression) &&
          node.expression.argumentExpression.text === "purge"));
    const purgeTaken =
      ts.isBindingElement(node) &&
      ((node.propertyName ?? node.name).getText() === "purge" ||
        (node.propertyName !== undefined &&
          ts.isStringLiteralLike(node.propertyName) &&
          node.propertyName.text === "purge"));
    if (purgeCall || purgeTaken) {
      purges.push({ file, what: "purge", within: enclosingName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, lifts, purges };
}

function scanRepository() {
  const all = {
    imports: [] as Site[],
    lifts: [] as Site[],
    purges: [] as Site[],
  };
  for (const path of [
    ...sources(join(ROOT, "packages")),
    ...sources(join(ROOT, "apps")),
  ]) {
    const found = scanSource(relative(ROOT, path), readFileSync(path, "utf8"));
    all.imports.push(...found.imports);
    all.lifts.push(...found.lifts);
    all.purges.push(...found.purges);
  }
  return all;
}

describe("a legal hold is lifted only by collection", () => {
  test("the one command that lifts a hold is the store's purge, and only the collector calls purge", () => {
    const { imports, lifts, purges } = scanRepository();
    expect(imports).toEqual([
      {
        file: "packages/storage/src/checkpoint-objects.ts",
        what: "PutObjectLegalHoldCommand",
        within: undefined,
      },
    ]);
    expect(lifts).toEqual([
      {
        file: "packages/storage/src/checkpoint-objects.ts",
        what: "PutObjectLegalHoldCommand",
        within: "purge",
      },
    ]);
    expect(purges.map((site) => site.file)).toEqual([
      "packages/platform/src/checkpoints/checkpoint-collector.ts",
    ]);
  }, 30_000);

  test("the scan sees the other ways to write the same thing", () => {
    const found = scanSource(
      "fixture.ts",
      [
        'import { PutObjectLegalHoldCommand as Hold, PutObjectRetentionCommand } from "@aws-sdk/client-s3";',
        'import * as s3 from "@aws-sdk/client-s3";',
        "const off = { Status: 'OFF' };",
        "function a() { return new Hold({ LegalHold: off }); }",
        "function b() { return new s3.PutObjectLegalHoldCommand({ LegalHold: { Status: 'OFF' } }); }",
        "function c() { return new PutObjectRetentionCommand({}); }",
        "function d() { return { BypassGovernanceRetention: true }; }",
        "function e(store) { return store['purge'](1); }",
        "function f({ purge }) { return purge(1); }",
        "function g(store) { const { purge: p } = store; return p(1); }",
        "function h() { return new Hold({ LegalHold: { Status: 'ON' } }); }",
      ].join("\n"),
    );
    expect(found.lifts.map((site) => site.within)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(found.purges.map((site) => site.within)).toEqual(["e", "f", "g"]);
  });
});
