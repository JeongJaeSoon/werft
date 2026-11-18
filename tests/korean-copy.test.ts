import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { typescriptFiles } from "./typescript-files.ts";

const root = join(import.meta.dir, "..");

/**
 * Code that draws text a user sees: the web app with its catalogs, the React
 * components with the error guidance, and the UI kit's default copy.
 */
const READERS = ["apps/web/src", "packages/react/src", "packages/ui/src"];

/** Inside the readers, files that draw nothing a user sees. */
const NOT_READERS =
  /(^|\/)(test-support|testing|fixtures|__fixtures__)\/|\.test\.tsx?$|\.gen\.ts$/;

/**
 * Nouns that end in 요, so a clause ending in one is not 해요체. Each is
 * matched against the clause's last word whole: 필요 passes, 불필요해요 does
 * not. Adding a word here is the only way to let another ending through.
 */
const NOUNS_IN_YO = ["필요", "개요", "아니요", "중요", "주요"];

/**
 * Sentences, lines, the halves around a spaced dash and what parentheses
 * hold apart: 해요체 mostly sits before the dash, as in "…있어요 — …하세요.".
 */
const clauses = (text: string) =>
  text
    .split(/(?<=[.?!])\s+|\n+|\s+[—–]\s+|[()]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** Ends in 요 or 죠, but not in the directive 세요, the confirm question 까요 or a noun. */
function haeyo(clause: string): boolean {
  const end = clause.replace(/[.?!…:"'”’\])]+$/, "");
  if (!/[요죠]$/.test(end) || /(세요|까요)$/.test(end)) return false;
  return !NOUNS_IN_YO.includes(end.split(/\s+/).at(-1) ?? "");
}

/** Every string and JSX text in the readers, with where it is. */
async function texts() {
  const found = await Promise.all(
    READERS.map((directory) =>
      typescriptFiles(join(root, directory), () => true),
    ),
  );
  const out: { at: string; text: string }[] = [];
  for (const file of found
    .flat()
    .map((path) => relative(root, path))
    .filter((path) => !NOT_READERS.test(path))) {
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
        (ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        (node.parent as { name?: ts.Node }).name !== node
      ) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        out.push({ at: `${file}:${line + 1}`, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe("Korean copy", () => {
  let scan: ReturnType<typeof texts> | undefined;
  const scanned = () => {
    scan ??= texts();
    return scan;
  };

  test("the ending check catches 해요체 and lets through 합니다체, directives, confirm questions and nouns in 요", () => {
    const caught = (text: string) => clauses(text).some(haeyo);
    expect(
      [
        "GitHub를 켜요",
        "목록에 보여요",
        "곧 알려 드릴게요",
        "계정이 있나요?",
        "이미 했죠",
        "활성 release가 없는 에이전트예요",
        "워크스페이스가 아니에요",
        "값이 너무 커요.",
        "불필요해요",
        "계정이 이미 있어요 — 다시 로그인하세요.",
        "시작할 수 없어요(release가 없습니다)",
        "release가 승인되지 않았어요) — 문의하세요.",
      ].filter((text) => !caught(text)),
    ).toEqual([]);
    expect(
      [
        "다시 시도하세요",
        "확인해 주세요.",
        "저장하려면 읽은 버전이 필요",
        "개요",
        "아니요, 처음입니다",
        "이 에이전트를 삭제할까요?",
        "요약",
        "요청하세요",
        "계정이 이미 있습니다 — 다시 로그인하세요.",
        "값이 너무 큽니다.",
      ].filter(caught),
    ).toEqual([]);
  });

  // Parsing every reader can outlast the default timeout on a loaded CI
  // runner; it takes about half a second on a laptop.
  test("no Korean sentence a user sees ends in 해요체", async () => {
    const found = (await scanned()).flatMap(({ at, text }) =>
      clauses(text)
        .filter(haeyo)
        .map((clause) => `${at} ${clause}`),
    );
    expect(found).toEqual([]);
  }, 30_000);
});
