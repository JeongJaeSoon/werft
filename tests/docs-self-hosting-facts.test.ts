import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  function visit(node: Node) {
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
    tables,
    code,
    commands: unique(commands),
    links: unique(links),
    variables: unique(prose.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []),
    numbers: unique(prose.match(/\d+(?:[.,]\d+)*/g) ?? []),
  };
}

describe("self-hosting translation facts", () => {
  for (const page of pages) {
    const path = `run-server/self-hosting/${page.path}`;
    const source = facts(readFileSync(join(root, `${path}.mdx`), "utf8"));
    for (const locale of ["en", "ja"] as const) {
      const state = Object.values(states).find((entry) =>
        entry.paths.includes(path),
      );
      if (state?.locales[locale] !== "implemented") continue;
      test(`${page.id}/${page.path}/${locale}: facts match Korean`, () => {
        expect(
          facts(readFileSync(join(root, `${path}.${locale}.mdx`), "utf8")),
        ).toEqual(source);
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
    ])
      expect(facts(changed)).not.toEqual(facts(source));
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
});
