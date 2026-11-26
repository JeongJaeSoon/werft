import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every place that inserts a turn, named with what holds it to the
 * installation's storage limit. The charge trigger refuses a commit only in
 * a transaction that set the limit (admitInput); one that did not is charged
 * and never refused. So a new path that takes someone's input and forgets the
 * limit would pass it without a sign: a new insert site fails here until it
 * is named, and a site named `input` must be reached through admitInput in
 * a transaction that answers the refusal.
 */

const ROOT = join(import.meta.dir, "../../..");
const SCANNED = ["packages", "apps", "scripts"];
// Fixtures and benchmarks write turns to set a scene, not to take input.
const SKIPPED = new Set([
  "node_modules",
  "dist",
  "migrations",
  "testing",
  "testkit",
  "bench",
]);

const SITES: Record<string, "input" | "platform"> = {
  // Input a person or a caller sent: refused at commit past the limit.
  "packages/db/src/postgres-unit-of-work.ts#insertQueuedTurn": "input",
  // The platform's own turns: charged, never refused. Refusing one would
  // fail the commit that ends a turn or records an answer.
  "packages/db/src/action/push-follow-ups.ts#queuePushFollowUps": "platform",
  "packages/db/src/sessions/parked-group.ts#continueParkedTurn": "platform",
  // start_fresh queues again an input the limit already admitted.
  "packages/db/src/recovery-control.ts#rerunUnknownTurn": "platform",
};

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

type FunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

const isFunctionLike = (node: ts.Node): node is FunctionLike =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (isFunctionLike(at)) return at;
  }
  return undefined;
}

/** The nearest function with a name of its own, or the name it is bound to. */
function enclosingName(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isPropertyAssignment(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
  }
  return "(module)";
}

const calls = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === name;

const RAW_INSERT = /\binsert\s+into\s+(?:"?public"?\.)?"?turns"?[\s(]/i;

type Scan = {
  /** `<file>#<function>` of each turn insert. */
  inserts: string[];
  /** What each call of an `input` inserter lacks; empty when it lacks nothing. */
  inputCalls: { at: string; problems: string[] }[];
};

function scan(file: string, text: string, inputInserters: Set<string>): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) =>
    `${relative(ROOT, file)}#${enclosingName(node)}`;
  // The names the turns table goes by here, aliases included.
  const tables = new Set<string>();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "turns") {
        tables.add(element.name.text);
      }
    }
  }
  const found: Scan = { inserts: [], inputCalls: [] };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "insert"
    ) {
      const [table] = node.arguments;
      if (
        table !== undefined &&
        ((ts.isIdentifier(table) && tables.has(table.text)) ||
          // A namespace import: schema.turns.
          (ts.isPropertyAccessExpression(table) && table.name.text === "turns"))
      ) {
        found.inserts.push(at(node));
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      RAW_INSERT.test(node.getText(source))
    ) {
      found.inserts.push(at(node));
    }
    for (const inserter of inputInserters) {
      if (calls(node, inserter)) {
        found.inputCalls.push({ at: at(node), problems: unheld(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Why a call that writes an input turn is not held to the limit: it must sit
 * in the transaction acceptanceTransaction runs, after an admitInput that is
 * a statement of that transaction's body itself, so no branch skips it.
 */
function unheld(call: ts.CallExpression): string[] {
  const work = enclosingFunction(call);
  const body = work?.body;
  if (
    work === undefined ||
    body === undefined ||
    !ts.isBlock(body) ||
    !calls(work.parent, "acceptanceTransaction")
  ) {
    return ["not in the transaction acceptanceTransaction runs"];
  }
  const within = (statement: ts.Statement, node: ts.Node) =>
    statement.pos <= node.pos && node.end <= statement.end;
  const mine = body.statements.findIndex((statement) =>
    within(statement, call),
  );
  // The declaration's value is the awaited call itself, so no condition in
  // it can skip the call either.
  const admitted = body.statements.slice(0, mine).some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(({ initializer }) => {
        return (
          initializer !== undefined &&
          ts.isAwaitExpression(initializer) &&
          calls(initializer.expression, "admitInput")
        );
      }),
  );
  return admitted ? [] : ["no admitInput before it in the transaction's body"];
}

function scanAll(): Scan {
  const inputInserters = new Set(
    Object.entries(SITES)
      .filter(([, held]) => held === "input")
      .map(([site]) => site.slice(site.indexOf("#") + 1)),
  );
  const all: Scan = { inserts: [], inputCalls: [] };
  for (const directory of SCANNED) {
    for (const file of sources(join(ROOT, directory))) {
      const text = readFileSync(file, "utf8");
      if (!/\bturns\b/i.test(text)) continue;
      const found = scan(file, text, inputInserters);
      all.inserts.push(...found.inserts);
      all.inputCalls.push(...found.inputCalls);
    }
  }
  return all;
}

describe("turn insert sites and the storage limit", () => {
  // Reads every source file of the repository: slower on a CI runner.
  const found = scanAll();

  test("every site that inserts a turn is named with how the limit holds it", () => {
    expect([...new Set(found.inserts)].sort()).toEqual(
      Object.keys(SITES).sort(),
    );
  }, 60_000);

  test("an input turn is written only after admitInput, in a transaction that answers the refusal at commit", () => {
    // A new session and an added message.
    expect(found.inputCalls.map((call) => call.at).sort()).toEqual([
      "packages/db/src/postgres-unit-of-work.ts#acceptInputAtomic",
      "packages/db/src/postgres-unit-of-work.ts#appendInputAtomic",
    ]);
    expect(found.inputCalls.filter((call) => call.problems.length > 0)).toEqual(
      [],
    );
  }, 60_000);
});

describe("the scan", () => {
  const inputInserters = new Set(["insertQueuedTurn"]);
  const scanned = (text: string) =>
    scan(join(ROOT, "packages/db/src/sample.ts"), text, inputInserters);

  test("finds an insert under an alias, through a namespace, and in SQL text", () => {
    const { inserts } = scanned(`
      import { turns as t } from "./schema.ts";
      import * as schema from "./schema.ts";
      async function aliased(tx) { await tx.insert(t).values({}); }
      async function namespaced(tx) { await tx.insert(schema.turns).values({}); }
      async function raw(tx) { await tx.execute(sql\`INSERT INTO "turns" (message) VALUES (\${m})\`); }
      async function other(tx) { await tx.insert(sessions).values({}); }
    `);
    expect(inserts.sort()).toEqual([
      "packages/db/src/sample.ts#aliased",
      "packages/db/src/sample.ts#namespaced",
      "packages/db/src/sample.ts#raw",
    ]);
  });

  test("refuses an input turn written outside the transaction, before admitInput, or after one a branch may skip", () => {
    const { inputCalls } = scanned(`
      function outside(db) {
        return db.transaction(async (tx) => {
          const refused = await admitInput(tx, {});
          await insertQueuedTurn(tx, {});
        });
      }
      function before(db) {
        return acceptanceTransaction(db, async (tx) => {
          await insertQueuedTurn(tx, {});
          const refused = await admitInput(tx, {});
        });
      }
      function skipped(db) {
        return acceptanceTransaction(db, async (tx) => {
          if (strict) { const refused = await admitInput(tx, {}); }
          await insertQueuedTurn(tx, {});
        });
      }
      function unawaited(db) {
        return acceptanceTransaction(db, async (tx) => {
          const refused = admitInput(tx, {});
          await insertQueuedTurn(tx, {});
        });
      }
      function conditional(db) {
        return acceptanceTransaction(db, async (tx) => {
          const refused = strict ? await admitInput(tx, {}) : null;
          await insertQueuedTurn(tx, {});
        });
      }
      function held(db) {
        return acceptanceTransaction(db, async (tx) => {
          const refused = await admitInput(tx, {});
          if (refused) return refused;
          if (first) { await insertQueuedTurn(tx, {}); }
        });
      }
    `);
    expect(
      Object.fromEntries(inputCalls.map((call) => [call.at, call.problems])),
    ).toEqual({
      "packages/db/src/sample.ts#outside": [
        "not in the transaction acceptanceTransaction runs",
      ],
      "packages/db/src/sample.ts#before": [
        "no admitInput before it in the transaction's body",
      ],
      "packages/db/src/sample.ts#skipped": [
        "no admitInput before it in the transaction's body",
      ],
      "packages/db/src/sample.ts#unawaited": [
        "no admitInput before it in the transaction's body",
      ],
      "packages/db/src/sample.ts#conditional": [
        "no admitInput before it in the transaction's body",
      ],
      "packages/db/src/sample.ts#held": [],
    });
  });
});
