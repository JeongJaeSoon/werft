import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { screen, renderAt } = await appHarness();

/** The root JSX node a component function returns, parentheses stripped. */
function returnedRoot(file: string, name: string): ts.Node {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(import.meta.dir, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let root: ts.Node | undefined;
  source.forEachChild((node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== name) return;
    for (const statement of node.body?.statements ?? []) {
      if (!ts.isReturnStatement(statement) || !statement.expression) continue;
      let expression: ts.Expression = statement.expression;
      while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
      }
      root = expression;
    }
  });
  if (!root) throw new Error(`${name} not found in ${file}`);
  return root;
}

describe("연동 화면 본문은 페이지 껍데기를 내보내지 않는다", () => {
  // The page frame belongs to the route wrapper so a tab layout can host the body.
  test.each([
    ["workspace-slack.tsx", "WorkspaceSlackScreen"],
    ["workspace-github.tsx", "WorkspaceGitHubScreen"],
    ["workspace-github-new-app.tsx", "GitHubNewAppCallback"],
  ])(
    "%s %s 본문의 루트는 Fragment고 껍데기를 자식으로 두지 않는다",
    (file, name) => {
      const root = returnedRoot(file, name);
      expect(ts.isJsxFragment(root)).toBe(true);
      const tags = (root as ts.JsxFragment).children.flatMap((child) =>
        ts.isJsxElement(child)
          ? [child.openingElement.tagName.getText()]
          : ts.isJsxSelfClosingElement(child)
            ? [child.tagName.getText()]
            : [],
      );
      expect(tags.includes("Page") || tags.includes("WorkspacePage")).toBe(
        false,
      );
    },
  );

  test("새 App 콜백 경로는 껍데기를 한 번만 그리고 연동 제목 아래 소제목으로 둔다", async () => {
    renderAt("/settings/workspace/integrations/github/new-app", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "새 App 만들기",
    });
    expect(heading.tagName === "H2").toBe(true);
    expect(
      screen.getByRole("heading", { level: 1, name: "연동" }).tagName === "H1",
    ).toBe(true);
    expect(document.querySelectorAll('[data-slot="page"]').length === 1).toBe(
      true,
    );
    expect(document.querySelectorAll("h1").length === 1).toBe(true);
  });
});
