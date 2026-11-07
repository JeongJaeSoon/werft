import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Documentation lives on the docs site. A link from the product, the site, the
// Storybook or a published package README to a Markdown file or a docs
// directory on github.com opens a raw README instead of a site page.
const SITE = "https://jeongjaesoon.github.io/werft";
const REPO_DOC =
  /https:\/\/(?:github\.com\/jeongjaesoon\/werft\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/jeongjaesoon\/werft)\/([^\s)"'`>#?]+)/gi;

// The captured text is `<ref>/<path>`. A ref may hold slashes (release/next),
// so the path starts at the first top-level repository name after the ref.
// Known limits, none used by a link in this repository: a ref that itself
// contains a root name (release/docs) and a path with a parenthesis.
const REPO_ROOTS = new Set(["docs", "examples", "packages", "apps"]);

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function repoPath(refAndPath: string): string {
  const segments = decoded(refAndPath)
    .replace(/[/.,;:]+$/, "")
    .split("/");
  const root = segments.findIndex((s, i) => i > 0 && REPO_ROOTS.has(s));
  return segments.slice(root === -1 ? 1 : root).join("/");
}

// Repository paths that may still be linked, each with the reason there is no
// site page for it. Drop an entry when its page exists: the stale-entry test
// below fails on one nothing links to any more.
const ALLOWED: Record<string, string> = {
  "packages/ui/README.md":
    "contributor rules for building screens; the Storybook introduction links its source of truth",
  "examples/LICENSE": "license file of the sample code",
  "CHANGELOG.md":
    "the changelog is one repository file in Korean, holding what a release's generated notes cannot: security fixes and operator actions",
  "docs/quickstart.md":
    "the full local-stack runbook (session lap, restart, scripted prompts) that CI runs as written; the site's dev-server page carries the reader steps and the site links there",
  "docs/contributing":
    "developer-only: repository setup, CI and design records for contributors; the site contributing page lists them",
  "docs/contributing/architecture.md": "contributor document",
  "docs/contributing/console-demo.md": "contributor document",
  "docs/contributing/ci.md": "contributor document",
  "docs/contributing/development.md": "contributor document",
  "docs/contributing/i18n-glossary.md": "contributor document",
  "docs/contributing/local-model.md": "contributor document",
  "docs/contributing/decisions": "contributor document",
  "docs/contributing/decisions/github-packages-bot-token.md":
    "design record behind a setting; the configuration page links it",
  "docs/operator/api-server.md":
    "no site page yet; the API server reference is being moved separately",
  "docs/operator/backup-restore.md":
    "held: still calls an internal test script and has unfinished sections",
  "docs/operator/data-retention.md":
    "held: pins line numbers to a commit and has an open decisions section",
};
const ALLOWED_PREFIXES: Record<string, string> = {
  "examples/sdk-": "sample code directories and their per-sample READMEs",
};

const SCANNED = [
  "README.md",
  "apps/**/*.{md,mdx,ts,tsx,js,jsx,mjs,json,html}",
  "packages/**/*.{md,mdx,ts,tsx,js,jsx,mjs,json,html}",
];
const SKIPPED = /(^|\/)(node_modules|dist|\.next|out)\/|\.test\.tsx?$/;

// Source code, configuration and workflows are not documentation.
function isDocTarget(path: string): boolean {
  return (
    !/\.(ts|tsx|js|jsx|mjs|json|ya?ml|sh)$/.test(path) &&
    (/\.mdx?$/.test(path) || /^(docs|examples)(\/|$)/.test(path))
  );
}

function allowed(path: string): boolean {
  return (
    path in ALLOWED ||
    Object.keys(ALLOWED_PREFIXES).some((prefix) => path.startsWith(prefix))
  );
}

function repoDocLinks(): { file: string; path: string }[] {
  const links: { file: string; path: string }[] = [];
  for (const pattern of SCANNED) {
    for (const file of new Bun.Glob(pattern).scanSync(root)) {
      if (SKIPPED.test(file)) continue;
      // A commented-out link is not a link, for the stale-entry test too.
      const text = readFileSync(join(root, file), "utf8").replace(
        /<!--[\s\S]*?-->/g,
        "",
      );
      for (const match of text.matchAll(REPO_DOC)) {
        const path = repoPath(match[1] ?? "");
        if (isDocTarget(path)) links.push({ file, path });
      }
    }
  }
  return links;
}

describe("Documentation links", () => {
  test("none opens a repository Markdown file the docs site has a page for", () => {
    const stray = repoDocLinks()
      .filter((link) => !allowed(link.path))
      .map((link) => `${link.file} -> ${link.path}`);
    expect(stray).toEqual([]);
  });

  test("every allowed repository path is still linked", () => {
    const linked = repoDocLinks().map((link) => link.path);
    const stale = [
      ...Object.keys(ALLOWED).filter((path) => !linked.includes(path)),
      ...Object.keys(ALLOWED_PREFIXES).filter(
        (prefix) => !linked.some((path) => path.startsWith(prefix)),
      ),
    ];
    expect(stale).toEqual([]);
  });

  test("the SDK README sends readers to the site", () => {
    const readme = readFileSync(join(root, "packages/sdk/README.md"), "utf8");
    expect(readme).toContain(`${SITE}/ko/sdk/`);
  });

  test("the scanner flags a README link and passes a site link", () => {
    const sample = (path: string) =>
      `https://github.com/JeongJaeSoon/werft/blob/main/${path}`;
    expect(allowed("docs/sdk.md")).toBe(false);
    expect(isDocTarget("docs/sdk.md")).toBe(true);
    expect(isDocTarget("scripts/probe.ts")).toBe(false);
    expect([...sample("docs/sdk.md").matchAll(REPO_DOC)]).toHaveLength(1);
    expect([...`${SITE}/ko/sdk/`.matchAll(REPO_DOC)]).toHaveLength(0);
    for (const url of [
      "https://raw.githubusercontent.com/JeongJaeSoon/werft/main/docs/sdk.md",
      "https://github.com/jeongjaesoon/werft/blob/main/docs/sdk.md",
      "https://github.com/JeongJaeSoon/werft/blob/main/README.md?plain=1",
      "https://github.com/JeongJaeSoon/werft/blob/4b014d7/docs/sdk.md",
    ]) {
      expect([...url.matchAll(REPO_DOC)]).toHaveLength(1);
    }
    expect(isDocTarget("apps/docs/content/docs/sdk.mdx")).toBe(true);

    const paths = (text: string) =>
      [...text.matchAll(REPO_DOC)].map((m) => repoPath(m[1] ?? ""));
    const base = "https://github.com/JeongJaeSoon/werft/blob";
    expect(paths(`const href = \`${base}/main/docs/api-guide.md\`;`)).toEqual([
      "docs/api-guide.md",
    ]);
    expect(paths(`${base}/release/next/docs/api-guide.md`)).toEqual([
      "docs/api-guide.md",
    ]);
    expect(paths(`${base}/main/README.md`)).toEqual(["README.md"]);
  });
});
