import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

const root = join(
  import.meta.dir,
  "../apps/docs/content/docs/run-server/self-hosting",
);
const held = /\/(session-data-flow|monitoring-datadog)(\.(en|ja))?\.mdx$/;
const internal =
  /검증 카드|검사자(?:가|는|의|\s)|카드는 보지 못|\b94S-\d+\b|\b(?:NOW|LATER|DROP)\s*[:：]|\b(?:NOT VERIFIED|VERIFIED)\b|\brun_[a-f0-9]{8,}\b|\btask_[a-f0-9]{8,}\b/u;
// This narrow check recognizes selected Korean verbs, not every diary.
const measurementDiary =
  /\d{4}-\d{2}-\d{2}[^.。\n]*(?:측정|실측|조사|확인했|확인\))/u;

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  name?: string;
}

function violations(text: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .parse(text.replace(/^---\n[\s\S]*?\n---\n/, "")) as Node;
  const found: string[] = [];
  function visit(node: Node) {
    if (node.type === "code") return;
    if (node.type === "delete" || node.name === "del")
      found.push("deleted prose");
    if (
      node.value &&
      (internal.test(node.value) || measurementDiary.test(node.value))
    )
      found.push(node.value);
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return found;
}

// This checks reader-facing prose, not technical accuracy, URL reachability,
// translations or data preservation. Held pages are the only scope exception.
describe("self-hosting reader contract", () => {
  test("public prose omits internal review history", () => {
    const found: string[] = [];
    for (const file of new Bun.Glob("**/*.mdx").scanSync(root)) {
      if (held.test(`/${file}`)) continue;
      const text = readFileSync(join(root, file), "utf8");
      for (const issue of violations(text)) found.push(`${file}: ${issue}`);
    }
    expect(found).toEqual([]);
  });

  test("normal owner, run and public issue contexts remain valid", () => {
    expect(
      violations(
        "owner 권한으로 같은 run을 재실행한다. [JeongJaeSoon/werft#1288](https://github.com/JeongJaeSoon/werft/pull/1288)",
      ),
    ).toEqual([]);
    expect(violations("```sh\necho VERIFIED\n```\n")).toEqual([]);
    expect(
      violations("`.quota-verified` 파일과 a verified commit은 정상 문맥이다."),
    ).toEqual([]);
    expect(
      violations("인증서 만료일은 2026-12-01이다. 준비 상태를 확인한다."),
    ).toEqual([]);
    expect(
      violations("2026-11-01 합성 데이터 실측 결과다.").length,
    ).toBeGreaterThan(0);
  });

  test("inline code does not hide internal history", () => {
    for (const sample of [
      "검증 카드",
      "`94S-1435`",
      "`VERIFIED`",
      "NOW: 수정",
      "~~옛 설명~~",
      "<del>옛 설명</del>",
    ]) {
      expect(violations(sample).length).toBeGreaterThan(0);
    }
  });
});
