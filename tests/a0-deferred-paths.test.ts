import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { typescriptFiles } from "./typescript-files.ts";

const root = join(import.meta.dir, "..");

/**
 * Entry points a0 built and tested without a caller: no route, operator
 * command or runtime path reaches them yet, so the a0 completion check
 * (verify-werft P-A0-DEFERRED) took their integration test output as their
 * real output. Each is named here with the one file that declares it.
 */
const deferred = new Map([
  [
    "assembleContext",
    "packages/platform/src/conversations/context-assembler.ts",
  ],
  [
    "createConversationCalls",
    "packages/platform/src/limits/conversation-calls.ts",
  ],
  [
    "createWebInputService",
    "packages/platform/src/conversations/web-inputs.ts",
  ],
]);

/**
 * Product files under apps/, packages/ and scripts/ that name a deferred entry
 * point outside its own file, as an identifier or a string (`ns["name"]`). A
 * name assembled at run time is not seen.
 */
async function deferredCallers(): Promise<string[]> {
  const found: string[] = [];
  for (const top of ["apps", "packages", "scripts"]) {
    const files = await typescriptFiles(
      join(root, top),
      (name) => !/\.test\.tsx?$/.test(name),
    );
    for (const file of files) {
      const path = relative(root, file).split(sep).join("/");
      if (/\/(?:node_modules|dist|testing|test-support)\//.test(path)) continue;
      const text = await readFile(file, "utf8");
      const named = [...deferred.keys()].filter((name) => text.includes(name));
      if (named.length === 0) continue;
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
          deferred.has(node.text) &&
          deferred.get(node.text) !== path
        )
          found.push(`${path} -> ${node.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return [...new Set(found)].sort();
}

// When this fails, the path has a caller: run its deferred check in
// P-A0-DEFERRED on a verify stack, then drop it from `deferred`.
test("a0's deferred entry points have no caller outside tests", async () => {
  expect(await deferredCallers()).toEqual([]);
}, 60_000);

test("each deferred entry point is still declared in its file", async () => {
  for (const [name, path] of deferred) {
    const text = await readFile(join(root, path), "utf8");
    expect(text).toMatch(new RegExp(`export (?:async )?function ${name}\\b`));
  }
});
