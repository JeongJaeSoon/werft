import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Auto-approve (the bundle service under the Git sync) and the review screen
// (the skill service) must read hosts with the same reader, or a version the
// screen flags could be approved on its own.
test("both skill services get the one host reader", () => {
  const path = new URL("./server.ts", import.meta.url);
  const source = ts.createSourceFile(
    "server.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const hosts: Record<string, Array<string | null>> = {};
  const declared: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "skillHosts"
    ) {
      declared.push(node.initializer?.getText(source) ?? "");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "createExtensionBundleService" ||
        node.expression.text === "createSkillService")
    ) {
      const [options] = node.arguments;
      const property =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === "hosts",
            )
          : undefined;
      const name = node.expression.text;
      hosts[name] = [
        ...(hosts[name] ?? []),
        property?.initializer.getText(source) ?? null,
      ];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(declared).toEqual(["renderedHostExtractor"]);
  expect(hosts).toEqual({
    createExtensionBundleService: ["skillHosts"],
    createSkillService: ["skillHosts"],
  });
});
