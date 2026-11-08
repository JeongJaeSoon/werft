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
  ])("%s %s 본문의 루트는 Fragment다", (file, name) => {
    expect(ts.isJsxFragment(returnedRoot(file, name))).toBe(true);
  });

  test("새 App 콜백 경로는 껍데기를 한 번만 그리고 제목을 유지한다", async () => {
    renderAt("/settings/workspace/github/new-app", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "새 App 만들기",
    });
    expect(heading.tagName === "H1").toBe(true);
    expect(document.querySelectorAll('[data-slot="page"]').length === 1).toBe(
      true,
    );
    expect(document.querySelectorAll("h1").length === 1).toBe(true);
  });
});
