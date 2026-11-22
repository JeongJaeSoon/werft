import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

// The API, its roles and the operator commands read the master key through
// one loader, so a command run beside the API takes the key the same way.

const SRC = join(import.meta.dir, "..");
const LOADER = "api/catalog-config.ts";
const SETTING_NAMES = new Set([
  "PLATFORM_SECRET_KEY",
  "PLATFORM_SECRET_KEY_FILE",
]);
const SETTING_CONSTANTS = new Set([
  "SECRET_KEY_SETTING",
  "SECRET_KEY_FILE_SETTING",
]);
/** Every entry point that opens stored secrets. */
const KEY_READERS = [
  "api/server.ts",
  "slack/main.ts",
  "api/slack-app.ts",
  "api/slack-interaction-sign.ts",
];

function nameOf(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

/** Each place that reads a master key setting off an object, as line numbers. */
export function settingReads(source: string): number[] {
  const file = ts.createSourceFile(
    "x.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines: number[] = [];
  const at = (node: ts.Node) =>
    lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      (SETTING_NAMES.has(node.name.text) ||
        SETTING_CONSTANTS.has(node.name.text))
    ) {
      // env.PLATFORM_SECRET_KEY, or the loader's constant off a namespace.
      at(node);
    } else if (ts.isStringLiteralLike(node) && SETTING_NAMES.has(node.text)) {
      // A literal that is exactly a setting's name: an index, a local
      // constant, a computed key. Text that only mentions one is fine.
      at(node);
    } else if (
      ts.isImportSpecifier(node) &&
      SETTING_CONSTANTS.has((node.propertyName ?? node.name).text)
    ) {
      // The constants stay in the loader, so no alias can index with them.
      at(node);
    } else if (
      ts.isIdentifier(node) &&
      SETTING_CONSTANTS.has(node.text) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      at(node);
    } else if (ts.isBindingElement(node)) {
      const name = nameOf(node.propertyName ?? node.name);
      if (name !== null && SETTING_NAMES.has(name)) at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(lines)];
}

function callsLoader(source: string): boolean {
  const file = ts.createSourceFile(
    "x.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "loadSecretKey"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  const imported = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /(^|\/)catalog-config\.ts$/.test(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "loadSecretKey",
      ),
  );
  return found && imported;
}

async function sources(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true });
  return entries
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .sort();
}

describe("one master key loader", () => {
  test("nothing but the loader reads PLATFORM_SECRET_KEY or PLATFORM_SECRET_KEY_FILE", async () => {
    const found: string[] = [];
    for (const path of await sources()) {
      if (relative(SRC, join(SRC, path)) === LOADER) continue;
      const lines = settingReads(await readFile(join(SRC, path), "utf8"));
      for (const line of lines) found.push(`${path}:${line}`);
    }
    expect(found).toEqual([]);
  }, 30_000);

  test("the API, the slack role and the operator commands call it", async () => {
    const missing: string[] = [];
    for (const path of KEY_READERS) {
      if (!callsLoader(await readFile(join(SRC, path), "utf8")))
        missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("the scan catches each way of reading a setting", () => {
    expect(
      settingReads(
        [
          "const a = process.env.PLATFORM_SECRET_KEY;",
          'const b = env["PLATFORM_SECRET_KEY_FILE"];',
          "const c = env[SECRET_KEY_SETTING];",
          "const { PLATFORM_SECRET_KEY: d } = env;",
          'const e = "PLATFORM_SECRET_KEY";',
          'import { SECRET_KEY_SETTING as S } from "./catalog-config.ts";',
          "const { [SECRET_KEY_FILE_SETTING]: g } = process.env;",
          "const h = env[cfg.SECRET_KEY_SETTING];",
          "const i = `PLATFORM_SECRET_KEY_FILE`;",
          'const j = "set PLATFORM_SECRET_KEY first";',
          "const k = env.OTHER_KEY;",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      callsLoader(
        'import { loadSecretKey } from "./catalog-config.ts";\nloadSecretKey(env);',
      ),
    ).toBe(true);
    expect(callsLoader("loadSecretKey(env);")).toBe(false);
  });
});
