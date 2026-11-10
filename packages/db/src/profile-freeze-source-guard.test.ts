import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Every function that writes a table the profile freeze covers must take the
// freeze barrier before the write, in its own transaction. This guard reads
// the source, so a writer added later cannot slip past the freeze unnoticed.

const SRC = import.meta.dir;

const FROZEN_TABLES = [
  "agent_releases",
  "workspace_profiles",
  "installation_profiles",
  "profile_rollouts",
  "profile_rollout_items",
  "profile_fill",
];
const FROZEN_SCHEMA_NAMES = [
  "agentReleases",
  "workspaceProfiles",
  "installationProfiles",
  "profileRollouts",
  "profileRolloutItems",
  "profileFill",
];

// `lockWrites` takes the profile-tables barrier itself.
const BARRIERS = new Set([
  "assertProfileTablesWritable",
  "assertReleasesWritable",
  "lockWrites",
]);

// A writer that does not take the barrier itself, with the reason it may not
// yet. Each entry is `file::function`; an entry that no longer matches a write
// fails the test, so the list cannot go stale.
const CALLER_TAKES_BARRIER =
  "helper without a transaction of its own; every caller takes the barrier first";
const RUNNER_WIRED_IN_5B2 =
  "rollout runner: needs a frozen outcome that does not consume attempts (PR 5b-2)";
const TOOL_UNLOCK_IN_5B2 =
  "called by control-host with the plain db handle; wired with its caller (PR 5b-2)";

export const NOT_YET_WIRED: Record<string, string> = {
  "profile-rollouts.ts::resolveFailedItems": CALLER_TAKES_BARRIER,
  "profile-rollouts.ts::writeProfileRollout": CALLER_TAKES_BARRIER,
  "profile-rollouts.ts::createPostgresProfileRolloutStore > claim":
    RUNNER_WIRED_IN_5B2,
  "profile-rollouts.ts::createPostgresProfileRolloutStore > settle":
    RUNNER_WIRED_IN_5B2,
  "profile-rollouts.ts::createPostgresProfileRolloutStore > abandon":
    RUNNER_WIRED_IN_5B2,
  "profile-rollouts.ts::createPostgresProfileRolloutStore > retry":
    RUNNER_WIRED_IN_5B2,
  "profile-rollouts.ts::createPostgresProfileRolloutStore > retryFailed":
    RUNNER_WIRED_IN_5B2,
  "tool-unlock.ts::openToolUnlockRollout": TOOL_UNLOCK_IN_5B2,
  "tool-unlock.ts::recordToolUnlockItem": TOOL_UNLOCK_IN_5B2,
};

const SQL_WRITE = new RegExp(
  `\\b(insert\\s+into|update|delete\\s+from)\\s+(${FROZEN_TABLES.join("|")})\\b`,
  "i",
);

const sourceFiles = (): string[] =>
  readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

type Write = { file: string; fn: string; line: number; guarded: boolean };

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

const nameOf = (node: ts.Node): string | undefined => {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText();
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return undefined;
};

// The write's own function chain, innermost first, as a `a > b` label.
const labelOf = (node: ts.Node): string => {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (isFunctionLike(n)) {
      const name = nameOf(n);
      if (name) names.push(name);
    }
  }
  return names.reverse().join(" > ") || "<module>";
};

const barrierBefore = (write: ts.Node): boolean => {
  for (let n: ts.Node | undefined = write.parent; n; n = n.parent) {
    if (!isFunctionLike(n)) continue;
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      // A barrier in a sibling function guards nothing here: skip every
      // function that does not contain the write.
      if (
        isFunctionLike(child) &&
        !(child.pos <= write.pos && write.end <= child.end)
      ) {
        return;
      }
      if (
        ts.isCallExpression(child) &&
        child.getEnd() <= write.getStart() &&
        BARRIERS.has(callee(child))
      ) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(n, visit);
    if (found) return true;
  }
  return false;
};

const callee = (call: ts.CallExpression): string => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
};

export const writesIn = (file: string, text: string): Write[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const writes: Write[] = [];
  const add = (node: ts.Node) =>
    writes.push({
      file,
      fn: labelOf(node),
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      guarded: barrierBefore(node),
    });
  const visit = (node: ts.Node) => {
    // drizzle: `.insert(table)`, `.update(table)`, `.delete(table)`
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["insert", "update", "delete"].includes(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      FROZEN_SCHEMA_NAMES.includes(node.arguments[0].text)
    ) {
      add(node);
    }
    // raw SQL: only the literal text of the statement is read, never a module
    // specifier or an unrelated string.
    if (
      (ts.isTemplateExpression(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
      SQL_WRITE.test(
        ts.isTemplateExpression(node)
          ? [
              node.head.text,
              ...node.templateSpans.map((s) => s.literal.text),
            ].join(" ")
          : node.text,
      )
    ) {
      add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
};

const allWrites = (): Write[] =>
  sourceFiles().flatMap((file) =>
    writesIn(file, readFileSync(join(SRC, file), "utf8")),
  );

describe("profile freeze source guard", () => {
  test("every writer of a frozen table takes the barrier first or is listed", () => {
    const unguarded = allWrites()
      .filter((w) => !w.guarded)
      .filter((w) => NOT_YET_WIRED[`${w.file}::${w.fn}`] === undefined)
      .map((w) => `${w.file}:${w.line} ${w.fn}`);
    expect(unguarded).toEqual([]);
  });

  test("the not-yet-wired list names only writers that still exist unguarded", () => {
    const live = new Set(
      allWrites()
        .filter((w) => !w.guarded)
        .map((w) => `${w.file}::${w.fn}`),
    );
    const stale = Object.keys(NOT_YET_WIRED).filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  test("the scan sees a writer with no barrier, and one that takes it first", () => {
    const bare = `export async function f(tx: Database) {
      await tx.update(workspaceProfiles).set({});
    }`;
    const guarded = `export async function f(tx: Database) {
      await assertProfileTablesWritable(tx);
      await tx.update(workspaceProfiles).set({});
    }`;
    const late = `export async function f(tx: Database) {
      await tx.execute(sql\`UPDATE agent_releases SET a = 1\`);
      await assertReleasesWritable(tx);
    }`;
    const sibling = `const store = {
      async a(tx: Database) { await assertProfileTablesWritable(tx); },
      async b(tx: Database) { await tx.update(workspaceProfiles).set({}); },
    };`;
    const unrelated = `import x from "installation_profiles"; const s = "update agent_releases";`;
    expect(writesIn("x.ts", bare).map((w) => w.guarded)).toEqual([false]);
    expect(writesIn("x.ts", guarded).map((w) => w.guarded)).toEqual([true]);
    expect(writesIn("x.ts", late).map((w) => w.guarded)).toEqual([false]);
    expect(writesIn("x.ts", sibling).map((w) => w.guarded)).toEqual([false]);
    expect(writesIn("x.ts", unrelated)).toEqual([]);
  });
});
