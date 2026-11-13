import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { remarkHeading } from "fumadocs-core/mdx-plugins";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import states from "./fixtures/self-hosting-language-status.json";
import pages from "./fixtures/self-hosting-pages.json";

const root = join(import.meta.dir, "../apps/docs/content/docs");
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  name?: string;
  attributes?: { name: string; value: string }[];
  data?: { hProperties?: { id?: string } };
}

function publicIds(source: string): string[] {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .use(remarkHeading);
  const tree = processor.runSync(
    processor.parse(source.replace(/^---\n[\s\S]*?\n---\n/, "")),
  ) as Node;
  const ids: string[] = [];
  function visit(node: Node) {
    if (node.data?.hProperties?.id) ids.push(node.data.hProperties.id);
    if (node.name === "a") {
      const id = node.attributes?.find((attribute) => attribute.name === "id");
      if (id) ids.push(id.value);
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return ids;
}

function readerHangul(source: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .parse(source.replace(/^---\n[\s\S]*?\n---\n/, "")) as Node;
  const found: string[] = [];
  function visit(node: Node) {
    if (node.type === "code") return;
    if (node.type === "text" || node.type === "inlineCode") {
      const value = (node.value ?? "").replace(/\[#[^\]]+\]/g, "");
      if (/[가-힣]/.test(value)) found.push(value);
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return found;
}

// Structural parity catches drift; it cannot establish equivalent meaning.
function facts(source: string) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "");
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .parse(body) as Node;
  const tables: number[] = [];
  const text: string[] = [];
  const code: string[] = [];
  const links: string[] = [];
  const commands: string[] = [];
  let headings = 0;
  function visit(node: Node) {
    if (node.type === "heading") headings++;
    if (node.type === "table") tables.push(node.children?.length ?? 0);
    if (node.type === "link" && node.url) links.push(node.url);
    if (
      node.type === "inlineCode" &&
      /^(?:scripts\/|bun |docker |kubectl |helm |curl |git |npm |pnpm |yarn |go |bundle |aws |sudo |findmnt |xfs_quota |openssl |jq |mkdir |read |rm )/.test(
        node.value ?? "",
      )
    )
      commands.push((node.value ?? "").replaceAll("<이미지>", "<image>"));
    if (node.type === "code") {
      code.push(node.value ?? "");
      return;
    }
    if (node.type === "text" || node.type === "inlineCode")
      text.push(node.value ?? "");
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  const prose = text.join(" ").replace(/\[#.*?\]/g, "");
  const unique = (values: Iterable<string>) => [...new Set(values)].sort();
  return {
    headings,
    tables,
    code,
    commands: unique(commands),
    links: unique(links),
    variables: unique(prose.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []),
    numbers: unique(prose.match(/\d+(?:[.,]\d+)*/g) ?? []),
  };
}

describe("self-hosting translation facts", () => {
  test("Japanese implements all 32 approved destination pages", () => {
    const implemented = new Set(
      Object.values(states)
        .filter((entry) => entry.locales.ja === "implemented")
        .flatMap((entry) => entry.paths),
    );
    expect(implemented.size).toBe(32);
    expect([...implemented].sort()).toEqual(
      pages.map((page) => `run-server/self-hosting/${page.path}`).sort(),
    );
  });

  for (const page of pages) {
    const path = `run-server/self-hosting/${page.path}`;
    const original = readFileSync(join(root, `${path}.mdx`), "utf8");
    const source = facts(original);
    test(`${page.id}/${page.path}/ko: public anchors are unique`, () => {
      const ids = publicIds(original);
      expect(new Set(ids).size).toBe(ids.length);
    });
    for (const locale of ["en", "ja"] as const) {
      const state = Object.values(states).find((entry) =>
        entry.paths.includes(path),
      );
      if (state?.locales[locale] !== "implemented") continue;
      test(`${page.id}/${page.path}/${locale}: facts match Korean`, () => {
        const translated = readFileSync(
          join(root, `${path}.${locale}.mdx`),
          "utf8",
        );
        expect(readerHangul(translated)).toEqual([]);
        const ids = publicIds(translated);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of publicIds(original)) expect(ids).toContain(id);
        expect(facts(translated)).toEqual(source);
      });
    }
  }

  test("changed commands, table rows, numbers, variables, and links are detected", () => {
    const source =
      "| Key | Value |\n|---|---|\n| `WORKER_MEMORY_MB` | 4608 |\n\n[guide](/guide)\n\n```bash\necho ready\n```\n";
    for (const changed of [
      source.replace("echo ready", "echo changed"),
      source.replace("| `WORKER_MEMORY_MB` | 4608 |", ""),
      source.replace("4608", "2048"),
      source.replace("WORKER_MEMORY_MB", "WORKER_CPUS"),
      source.replace("/guide", "/wrong"),
      `${source}\n## Added heading\n`,
    ])
      expect(facts(changed)).not.toEqual(facts(source));
  });

  test("Korean prose and placeholders are rejected, while URL and explicit IDs remain valid", () => {
    const allowed =
      '## Previous URLs [#이전-주소-안내]\n\n<a id="이전-주소" />\n\n[Guide](/guide#한국어)\n\n```sh\necho 원본\n```';
    expect(readerHangul(allowed)).toEqual([]);
    for (const extra of [
      "\n\n한국어 paragraph",
      "\n\n`<버전>`",
      "\n\n## 이전 주소 안내",
    ])
      expect(readerHangul(allowed + extra).length).toBeGreaterThan(0);
  });

  test("only the documented image placeholder translation is normalized", () => {
    const source = "`docker buildx imagetools inspect <이미지>@<digest>`";
    const translated = "`docker buildx imagetools inspect <image>@<digest>`";
    expect(facts(translated)).toEqual(facts(source));
    for (const changed of [
      translated.replace("inspect", "create"),
      translated.replace("<image>", "<other>"),
      translated.replace("<digest>", "<tag>"),
      translated.replace("inspect ", "inspect --raw "),
    ])
      expect(facts(changed)).not.toEqual(facts(source));
  });

  test("removed and duplicate public anchors are visible", () => {
    const original = '<a id="original" />\n\n## Heading';
    expect(publicIds(original)).toContain("original");
    expect(
      publicIds(original.replace('id="original"', 'id="changed"')),
    ).not.toContain("original");
    const duplicate = publicIds(`${original}\n\n<a id="original" />`);
    expect(new Set(duplicate).size).toBeLessThan(duplicate.length);
  });
});
