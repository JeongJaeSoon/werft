import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ts from "typescript";
import { ko } from "../apps/web/src/i18n/ko.ts";

const root = join(import.meta.dir, "..");

/**
 * Starts of keys the code builds from a value, as in
 * `t(\`agents.tabs.${tab}\`)`: every key under one counts as read. A start
 * is added here on purpose, so a key the code stops reading cannot hide
 * under a start nobody chose.
 */
const DYNAMIC_STARTS = [
  "achievementRules.evidence.",
  "agent.releases.",
  "agent.tabs.",
  "agentAccess.refused.",
  "agentGitHub.activity.",
  "agentGitHub.feature.",
  "agentGitHub.featureReason.",
  "agentGitHub.purpose.",
  "agentGitHub.pushAttached.",
  "agentGitHub.refusal.",
  "agentGitHub.refusalNext.",
  "agentGitHub.repositoryReason.",
  "agents.channel.",
  "agents.slackAction.",
  "agentWorkspaceMcp.error.",
  "error.",
  "github.feature.",
  "github.permissions.level.",
  "github.permissions.name.",
  "github.role.",
  "github.table.state.",
  "github.table.type.",
  "home.todo.cta.",
  "home.todo.effect.",
  "inbox.why.",
  "limits.",
  "loginProviders.access.state.",
  "loginProviders.problem.",
  "loginProviders.result.entry.",
  "loginProviders.state.",
  "loginProviders.stateHint.",
  "members.roleHelp.",
  "permission.",
  "preferences.languageNote.",
  "preferences.themeNote.",
  "role.",
  "session.achievements.error.",
  "session.achievements.judge.",
  "session.achievements.state.",
  "session.achievements.status.",
  "session.achievements.trigger.",
  "session.channel.",
  "session.control.",
  "session.event.approvalCheckpointFailed.",
  "session.github.intent.",
  "session.github.prError.",
  "session.github.prState.",
  "session.github.reason.",
  "session.github.state.",
  "session.outcomes.checkError.",
  "session.outcomes.event.",
  "session.outcomes.state.",
  "session.refused.",
  "sessionList.relation.",
  "sessions.admission.",
  "sessions.status.",
  "settings.error.",
  "settings.models.error.",
  "settings.state.",
  "shell.theme.",
  "slack.configToken.",
  "slack.eventsUrl.",
  "slack.state.",
  "teams.role.",
  "workspaceMcp.error.",
  "workspaceMcp.reauth.",
  "workspaceMcp.state.",
];

/**
 * Keys nothing read when this check came in. The list only shrinks: a key
 * read again or deleted leaves it, and no new key joins it.
 */
const UNREAD = [
  "agents.column.team",
  "agents.updated",
  "session.outcomes.changedFiles",
  "session.outcomes.checkedAt",
  "session.outcomes.closedAt",
  "session.outcomes.description",
  "session.outcomes.kind.pullRequest",
  "session.outcomes.mergedAt",
  "session.outcomes.notChecked",
  "session.outcomes.submittedAt",
  "session.outcomes.title",
  "session.outcomes.usage",
  "session.outcomes.usageUnmetered",
  "session.outputs.emptyHint",
  "session.outputs.files",
  "session.outputs.title",
  "session.workspaceLimit.hard",
  "session.workspaceLimit.line",
  "session.workspaceLimit.soft",
  "session.workspaceLimit.unknown",
  "workspaceMcp.clientDcr",
  "workspaceMcp.clientManual",
];

/** The catalogs: a key written in one of their `.ts` files is not a read. */
const CATALOG_DIRS = ["packages/react/src/messages", "apps/web/src/i18n"];

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const workspace of await readdir(join(root, group))) {
      const src = join(group, workspace, "src");
      const entries = await readdir(join(root, src), {
        recursive: true,
      }).catch(() => []);
      for (const entry of entries) {
        const file = join(src, entry);
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        if (
          file.endsWith(".ts") &&
          CATALOG_DIRS.some((d) => file.startsWith(`${d}/`))
        )
          continue;
        files.push(file);
      }
    }
  }
  return files;
}

/** Every string the code writes whole, and every start it builds a key on. */
async function reads() {
  const whole = new Set<string>();
  const starts = new Set<string>();
  for (const file of await sourceFiles()) {
    const source = ts.createSourceFile(
      file,
      await readFile(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      false,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        whole.add(node.text);
      else if (ts.isTemplateExpression(node) && node.head.text !== "")
        starts.add(node.head.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { whole, starts };
}

describe("message keys", () => {
  const keys = Object.keys(ko);
  const scanned = reads();
  const allowed = (key: string) =>
    DYNAMIC_STARTS.some((start) => key.startsWith(start));

  // Parsing every source file can outlast the default timeout on a loaded
  // CI runner; it takes about half a second on a laptop.
  test("every key in the catalogs is read by some code", async () => {
    const { whole } = await scanned;
    expect(
      keys.filter(
        (key) => !whole.has(key) && !allowed(key) && !UNREAD.includes(key),
      ),
    ).toEqual([]);
  }, 30_000);

  test("the list of unread keys only holds keys still there and still unread", async () => {
    const { whole } = await scanned;
    expect(
      UNREAD.filter((key) => !(key in ko) || whole.has(key) || allowed(key)),
    ).toEqual([]);
  }, 30_000);

  test("every start allowed is still built by the code and still has keys", async () => {
    const { starts } = await scanned;
    expect(
      DYNAMIC_STARTS.filter(
        (start) =>
          !starts.has(start) || !keys.some((key) => key.startsWith(start)),
      ),
    ).toEqual([]);
  }, 30_000);

  // Names the start to add when a new built key fails the first test.
  test("a start the code builds otherwise unread keys on is allowed on purpose", async () => {
    const { whole, starts } = await scanned;
    expect(
      [...starts].filter(
        (start) =>
          start.endsWith(".") &&
          !DYNAMIC_STARTS.includes(start) &&
          keys.some(
            (key) =>
              key.startsWith(start) &&
              !whole.has(key) &&
              !allowed(key) &&
              !UNREAD.includes(key),
          ),
      ),
    ).toEqual([]);
  }, 30_000);
});
