import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { ko } from "../apps/web/src/i18n/ko.ts";
import { typescriptFiles } from "./typescript-files.ts";

const root = join(import.meta.dir, "..");

/**
 * Where a key can be read: code that draws text. The contracts give only
 * their surface code, which turns events into keys. Server code is out: a
 * permission or event name there can spell a key without showing it.
 */
const READERS = [
  "apps/web/src",
  "packages/react/src",
  "packages/ui/src",
  "packages/contracts/src/surface",
];

/** Inside the readers, files that draw nothing a user sees. */
const NOT_READERS =
  /(^|\/)(test-support|testing|fixtures|__fixtures__)\/|\.test\.tsx?$|\.gen\.ts$/;

/**
 * Keys the code builds from a value, written with `*` for each value, as
 * `limits.*.title` for `t(\`limits.${name}.title\`)`: every key the pattern
 * matches counts as read. Read a key whole where the code can; a pattern
 * stays only where the value is not the code's to list, and it is written
 * here on purpose, so a key the code stops reading cannot hide under one
 * nobody chose.
 */
const BUILT = [
  "achievementRules.evidence.*",
  "action.push.unapprovable.*",
  "action.tool.*",
  "agent.tabs.*",
  "agentAccess.refused.*",
  "agentGitHub.activity.**",
  "agentGitHub.feature.*",
  "agentGitHub.feature.*Hint",
  "agentGitHub.featureReason.*",
  "agentGitHub.purpose.*",
  "agentGitHub.pushAttached.*",
  "agentGitHub.refusal.*",
  "agentGitHub.refusalNext.*",
  "agentGitHub.repositoryReason.*",
  "agents.channel.*",
  "agents.slackAction.*",
  "agentWorkspaceMcp.error.*",
  "error.*",
  "github.feature.*",
  "github.feature.*Hint",
  "github.permissions.level.*",
  "github.permissions.name.*",
  "github.role.*",
  "github.role.*Hint",
  "github.table.state.*",
  "github.table.type.*",
  "home.todo.cta.*",
  "home.todo.effect.*",
  "inbox.why.*",
  "limits.*.applies",
  "limits.*.detail",
  "limits.*.hint",
  "limits.*.invalid",
  "limits.*.label",
  "limits.*.refused",
  "limits.*.saved",
  "limits.*.title",
  "limits.*.unit",
  "limits.*.value",
  "limits.archive.unavailable.*",
  "limits.enforce.*",
  "loginProviders.access.state.*",
  "loginProviders.problem.*",
  "loginProviders.result.entry.*",
  "loginProviders.state.*",
  "loginProviders.stateHint.*",
  "members.roleHelp.*",
  "permission.*",
  "preferences.languageNote.*",
  "preferences.themeNote.*",
  "role.*",
  "session.achievements.error.*",
  "session.achievements.judge.*",
  "session.achievements.state.*",
  "session.achievements.status.*",
  "session.achievements.trigger.*",
  "session.channel.*",
  "session.control.*",
  "session.event.approvalCheckpointFailed.*",
  "session.event.phase.*",
  "session.github.intent.*",
  "session.github.prError.*",
  "session.github.prState.*",
  "session.github.reason.*",
  "session.github.state.*",
  "session.outcomes.checkError.*",
  "session.outcomes.event.*",
  "session.outcomes.state.*",
  "session.refused.*",
  "sessionList.relation.*",
  "sessions.admission.*",
  "sessions.status.*",
  "settings.error.*",
  "settings.models.error.*",
  "settings.state.*",
  "shell.theme.*",
  "slack.configToken.*",
  "slack.eventsUrl.*",
  "slack.state.*",
  "teams.role.*",
  "workspaceMcp.error.*",
  "workspaceMcp.reauth.*",
  "workspaceMcp.state.*",
];

/**
 * Keys nothing read when this check came in. The list only shrinks: a key
 * read again or deleted leaves it, and no new key joins it.
 */
const UNREAD = [
  "agent.releases.approved",
  "agent.releases.notApproved",
  "agents.column.team",
  "agents.updated",
  "session.control",
  "session.outcomes.changedFiles",
  "session.outcomes.description",
  "session.outcomes.kind.pullRequest",
  "session.outcomes.notChecked",
  "session.outcomes.submittedAt",
  "session.outcomes.title",
  "session.outcomes.usageUnmetered",
  "session.outputs.emptyHint",
  "session.outputs.title",
  "session.workspaceLimit.hard",
  "session.workspaceLimit.line",
  "session.workspaceLimit.soft",
  "session.workspaceLimit.unknown",
  "workspaceMcp.clientDcr",
  "workspaceMcp.clientManual",
  // Decide before deleting: the session's outputs tab is meant to show
  // these.
  "session.outcomes.checkedAt",
  "session.outcomes.closedAt",
  "session.outcomes.mergedAt",
  "session.outcomes.usage",
  "session.outputs.files",
];

/** Lowered as UNREAD shrinks, so a key added to the list fails. */
const UNREAD_AT_MOST = 25;

function matcher(built: string): RegExp {
  const parts = built
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`);
}

async function readerFiles(): Promise<string[]> {
  const found = await Promise.all(
    READERS.map((directory) =>
      typescriptFiles(join(root, directory), () => true),
    ),
  );
  return found
    .flat()
    .map((file) => relative(root, file))
    .filter((file) => !NOT_READERS.test(file));
}

/**
 * Every string the readers write whole, and every pattern they build a key
 * on, with where. A string that only names a type or a property is not a
 * read; the catalogs hold their keys as property names.
 */
async function reads() {
  const whole = new Set<string>();
  const built = new Map<string, string>();
  for (const file of await readerFiles()) {
    const source = ts.createSourceFile(
      file,
      await readFile(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)
      )
        return;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        if ((node.parent as { name?: ts.Node }).name !== node)
          whole.add(node.text);
      } else if (
        ts.isTemplateExpression(node) &&
        node.head.text.includes(".")
      ) {
        const pattern = [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ].join("*");
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        if (!built.has(pattern)) built.set(pattern, `${file}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { whole, built };
}

describe("message keys", () => {
  const keys = Object.keys(ko);
  let scan: ReturnType<typeof reads> | undefined;
  const scanned = () => {
    scan ??= reads();
    return scan;
  };
  const allowed = (key: string) =>
    BUILT.some((built) => matcher(built).test(key));

  // Parsing every reader can outlast the default timeout on a loaded CI
  // runner; it takes about half a second on a laptop.
  test("every key in the catalogs is read by some code", async () => {
    const { whole } = await scanned();
    expect(
      keys.filter(
        (key) => !whole.has(key) && !allowed(key) && !UNREAD.includes(key),
      ),
    ).toEqual([]);
  }, 30_000);

  test("the list of unread keys only holds keys still there and still unread", async () => {
    const { whole } = await scanned();
    expect(
      UNREAD.filter((key) => !(key in ko) || whole.has(key) || allowed(key)),
    ).toEqual([]);
  }, 30_000);

  test("the list of unread keys only shrinks", () => {
    expect(
      UNREAD.length === UNREAD_AT_MOST
        ? []
        : [
            UNREAD.length > UNREAD_AT_MOST
              ? `UNREAD holds ${UNREAD.length} keys, over ${UNREAD_AT_MOST}: a new key is read by code, never listed`
              : `UNREAD holds ${UNREAD.length} keys: lower UNREAD_AT_MOST to ${UNREAD.length}`,
          ],
    ).toEqual([]);
  });

  test("every pattern allowed is still built by the code and still has keys", async () => {
    const { built } = await scanned();
    expect(
      BUILT.filter(
        (pattern) =>
          !built.has(pattern) ||
          !keys.some((key) => matcher(pattern).test(key)),
      ),
    ).toEqual([]);
  }, 30_000);

  // Says what to do when a new built key fails the first test.
  test("a pattern the code builds otherwise unread keys on is allowed on purpose", async () => {
    const { whole, built } = await scanned();
    const hiding = [...built].flatMap(([pattern, at]) => {
      if (BUILT.includes(pattern)) return [];
      const covered = keys.filter((key) => matcher(pattern).test(key));
      const unread = covered.filter(
        (key) => !whole.has(key) && !allowed(key) && !UNREAD.includes(key),
      );
      return unread.length === 0
        ? []
        : [
            `${at} builds ${pattern}, which matches ${covered.length} keys, ${unread.length} of them read nowhere else (${unread.slice(0, 3).join(", ")}${unread.length > 3 ? ", …" : ""}). Read each key whole there. Add "${pattern}" to BUILT only when the value comes from outside the code, and only when the code can build all ${covered.length}.`,
          ];
    });
    expect(hiding).toEqual([]);
  }, 30_000);
});
