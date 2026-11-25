import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Until server.ts opens the public listener, the startup probe is refused
// and nothing has been logged about waiting. A top-level await there that
// does not go through startupWait can hold the start without a line, which
// is how an unreachable object store once kept the api silent until the
// probe restarted it.
test("server.ts awaits a dependency before it listens only through startupWait", () => {
  const path = new URL("./server.ts", import.meta.url);
  const source = ts.createSourceFile(
    "server.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const listens = source.statements.findIndex((statement) =>
    statement.getText(source).startsWith("const server = serveApiApp(app,"),
  );
  expect(listens).toBeGreaterThan(0);

  const awaited: string[] = [];
  const visit = (node: ts.Node) => {
    // A function body runs when it is called, not while the module starts.
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) {
      const call = node.expression;
      awaited.push(
        ts.isCallExpression(call)
          ? call.expression.getText(source)
          : call.getText(source),
      );
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements.slice(0, listens)) visit(statement);

  console.log("awaited before the api listens:", awaited);
  // `import` is the tracing adapter, loaded from disk when tracing is on.
  expect(awaited.filter((callee) => callee !== "import")).toEqual([
    "startupWait",
    "startupWait",
    "startupWait",
    "startupWait",
  ]);
});
