import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

// Inline links and images `[text](target)` and reference definitions
// `[label]: target`. Fenced blocks, HTML comments and code spans are dropped
// first: a snippet showing Markdown is not a link.
const INLINE = /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)/g;
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;
// One left-to-right pass, so whichever opens first hides the others: a fence
// opener or a backtick inside a comment does not reach past it. A fence
// closes on a bare run of its own character at least as long, or at the end
// of the file; a backtick fence's info string has no backtick; a code span
// does not cross a blank line.
const HIDDEN =
  /^ {0,3}((`|~)\2{2,})(?:(?<=`)[^`\n]*|(?<=~)[^\n]*)\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))|<!--[\s\S]*?-->|(?<!`)(`+)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\3(?!`)/gm;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

interface Link {
  path: string;
  anchor: string;
}

function relativeLinks(markdown: string): Link[] {
  const prose = markdown.replace(HIDDEN, "");
  const targets = [...prose.matchAll(INLINE), ...prose.matchAll(REFERENCE)].map(
    (match) => (match[1] ?? "").replace(/^<|>$/g, ""),
  );
  return targets
    .filter((target) => !/^([a-z][a-z0-9+.-]*:|\/)/i.test(target))
    .map((target) => {
      const [, path = "", anchor = ""] =
        /^([^#?]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(target) ?? [];
      return { path: decoded(path), anchor: decoded(anchor) };
    });
}

function relativeTargets(markdown: string): string[] {
  return relativeLinks(markdown)
    .map((link) => link.path)
    .filter((path) => path !== "");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function rendered(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) =>
      name.startsWith("#")
        ? String.fromCodePoint(Number(`0${name.slice(1)}`))
        : (ENTITIES[name.toLowerCase()] ?? entity),
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
}

// GitHub's heading id, from the rendered text: markup and punctuation
// dropped, spaces to hyphens. Symbols such as the circled digit in
// "② 이벤트 관찰" go too. Code spans render as written.
function slug(heading: string): string {
  return heading
    .replace(/(`+)(.*?)\1|[^`]+/g, (part, ticks, code) =>
      ticks ? code : rendered(part),
    )
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd}\p{Nl}\p{Mn}_ -]/gu, "")
    .replace(/ /g, "-");
}

const ATX = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_QUOTE_OR_TABLE = /^ {0,3}(?:(?:[-*+]|\d+[.)])(?:[ \t]|$)|[>|])/;

// ATX headings, and setext ones whose text is the whole paragraph above the
// underline. Lines after a list item, quote or table row continue that block
// until a blank line, so they never become a setext heading.
function headingTexts(prose: string): string[] {
  const texts: string[] = [];
  let paragraph: string[] | null = [];
  for (const line of prose.split("\n")) {
    const atx = ATX.exec(line);
    if (atx) {
      texts.push(atx[1] ?? "");
      paragraph = [];
    } else if (SETEXT_UNDERLINE.test(line) && paragraph?.length) {
      texts.push(paragraph.join(" "));
      paragraph = [];
    } else if (line.trim() === "" || THEMATIC_BREAK.test(line)) {
      paragraph = [];
    } else if (LIST_QUOTE_OR_TABLE.test(line)) {
      paragraph = null;
    } else {
      paragraph?.push(line.trim());
    }
  }
  return texts;
}

function headingAnchors(markdown: string): Set<string> {
  const prose = markdown.replace(HIDDEN, (match, _fence, _char, code) =>
    code ? match : "",
  );
  const anchors = new Set<string>();
  for (const text of headingTexts(prose)) {
    const base = slug(text);
    if (base === "") continue;
    let id = base;
    for (let n = 1; anchors.has(id); n++) id = `${base}-${n}`;
    anchors.add(id);
  }
  return anchors;
}

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], {
    cwd: root,
  });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout.toString().split("\0").filter(Boolean);
}

function relativeHtmlTargets(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target))
    .map((target) => decodeURIComponent(target.replace(/[#?].*$/, "")))
    .filter((path) => path !== "");
}

describe("Markdown relative links", () => {
  test("every one names a file or directory that exists", () => {
    const files = trackedMarkdown();
    expect(files).toContain("README.md");
    const broken = files.flatMap((file) =>
      relativeTargets(readFileSync(join(root, file), "utf8"))
        .filter((path) => !existsSync(join(root, dirname(file), path)))
        .map((path) => `${file} -> ${path}`),
    );
    expect(broken).toEqual([]);
  });

  test("every anchor names a heading in the file it points to", () => {
    const anchorsOf = new Map<string, Set<string>>();
    const broken = trackedMarkdown().flatMap((file) =>
      relativeLinks(readFileSync(join(root, file), "utf8"))
        .filter((link) => link.anchor !== "")
        .map((link) => ({
          ...link,
          target: link.path === "" ? file : join(dirname(file), link.path),
        }))
        .filter(
          ({ target }) =>
            target.endsWith(".md") && existsSync(join(root, target)),
        )
        .filter(({ target, anchor }) => {
          let anchors = anchorsOf.get(target);
          if (!anchors) {
            anchors = headingAnchors(readFileSync(join(root, target), "utf8"));
            anchorsOf.set(target, anchors);
          }
          return !anchors.has(anchor.toLowerCase());
        })
        .map(({ path, anchor }) => `${file} -> ${path}#${anchor}`),
    );
    expect(anchorsOf.size).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  test("headings get GitHub's anchors", () => {
    const page = [
      "# Quickstart — 로컬 스택과 curl로 세션 한 바퀴",
      "## ② 이벤트 관찰",
      "## `events` 표",
      "### workers·control-host 롤백 (v2.1)",
      "## [링크](x.md) 제목 ##",
      "## 반복",
      "## 반복",
      "```",
      "## fenced",
      "```",
      "<!--",
      "## commented",
      "-->",
    ].join("\n");
    expect([...headingAnchors(page)].sort()).toEqual(
      [
        "quickstart--로컬-스택과-curl로-세션-한-바퀴",
        "-이벤트-관찰",
        "events-표",
        "workerscontrol-host-롤백-v21",
        "링크-제목",
        "반복",
        "반복-1",
      ].sort(),
    );
    const anchorsOf = (lines: string[]) => [
      ...headingAnchors(lines.join("\n")),
    ];
    expect(anchorsOf(["# foo", "# foo", "# foo-1"])).toEqual([
      "foo",
      "foo-1",
      "foo-1-1",
    ]);
    expect(
      anchorsOf(["# A &amp; B &#x41;", "## _italics_ and __init__ snake_case"]),
    ).toEqual(["a--b-a", "italics-and-init-snake_case"]);
    expect(anchorsOf(["#", "# next", "#hashtag"])).toEqual(["next"]);
    expect(
      anchorsOf([
        "Title",
        "=====",
        "",
        "**Sub**",
        "---",
        "",
        "- item",
        "---",
        "",
        "| a |",
        "---",
      ]),
    ).toEqual(["title", "sub"]);
    expect(
      anchorsOf([
        "~~~",
        "# hidden",
        "~~~bad",
        "# hidden-too",
        "~~~",
        "# shown",
      ]),
    ).toEqual(["shown"]);
    expect(anchorsOf(["```", "# never closed"])).toEqual([]);
    expect(
      anchorsOf([
        "## `__init__` and __bold__",
        "```Use `x` here```",
        "# after",
      ]),
    ).toEqual(["__init__-and-bold", "after"]);
    expect(
      anchorsOf([
        "First line",
        "second line",
        "---",
        "",
        "***",
        "Next",
        "---",
        "",
        "- item",
        "lazy",
        "---",
      ]),
    ).toEqual(["first-line-second-line", "next"]);
  });

  test("the parser keeps relative paths and drops the rest", () => {
    const page = [
      "[a](docs/a.md) [b](../b.md#part) ![c](img/c%20d.png)",
      "[web](https://x.test/y) [anchor](#here) [mail](mailto:a@x.test)",
      "[root](/abs/path.md) [angle](<e f.md>) [a [nested] label](n.md)",
      "[escaped](x%23y.md#frag)",
      "`[code](not-a-link.md)`",
      "```",
      "[fenced](not-a-link-either.md)",
      "```",
      "[ref]: ./ref.md",
      "<!-- a ```bash block and one `tick -->",
      "[after comment](c.md) `[code](still-not.md)`",
      "<!-- [commented](not-a-link-at-all.md) -->",
    ].join("\n");
    expect(relativeTargets(page).sort()).toEqual(
      [
        "../b.md",
        "./ref.md",
        "c.md",
        "docs/a.md",
        "e f.md",
        "img/c d.png",
        "n.md",
        "x#y.md",
      ].sort(),
    );
    expect(relativeLinks(page).filter((link) => link.anchor !== "")).toEqual([
      { path: "../b.md", anchor: "part" },
      { path: "", anchor: "here" },
      { path: "x#y.md", anchor: "frag" },
    ]);
    expect(
      relativeLinks(
        ["<!--", "~~~", "-->", "[x](#missing) [pct](#100%)"].join("\n"),
      ),
    ).toEqual([
      { path: "", anchor: "missing" },
      { path: "", anchor: "100%" },
    ]);
    expect(
      relativeTargets(["`open", "", "[x](y.md)", "", "`close"].join("\n")),
    ).toEqual(["y.md"]);
    expect(
      relativeTargets(["```Use `x` here```", "[x](z.md)"].join("\n")),
    ).toEqual(["z.md"]);
  });

  test("none names a ticket", () => {
    const files = trackedMarkdown();
    const found = files.flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\b94S-\d+/.test(line) ? [`${file}:${index + 1}`] : [],
        ),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  test("every generated API HTML asset exists", () => {
    const file = "docs/api/index.html";
    const broken = relativeHtmlTargets(readFileSync(join(root, file), "utf8"))
      .filter((path) => !existsSync(join(root, dirname(file), path)))
      .map((path) => `${file} -> ${path}`);
    expect(broken).toEqual([]);
  });
});

// Setting names, found the way check.py found them for the feature map
// read off an environment object, or handed by name to a parser.
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
const CODE_READS = [
  new RegExp(
    String.raw`(?:process\.env|Bun\.env|\benv|\benvironment|\bsource)\s*(?:\?\.|\.|\[\s*["'])(${NAME})`,
    "g",
  ),
  new RegExp(
    String.raw`\b\w*(?:[Ee]nv|integer|setting|required|optional)\w*\(\s*(?:[a-z]\w*\s*,\s*)*["'](${NAME})["']`,
    "g",
  ),
];
// `${NAME:-default}` or `${NAME:?message}`: compose or a script takes it
// from the operator's shell.
const SHELL_DEFAULTS = new RegExp(String.raw`\$\{(${NAME}):[-?]`, "g");

/** Names the scan finds that no operator sets, each with why. */
const NOT_SETTINGS: Record<string, string> = {
  // Read beside HTTP_PROXY, which is documented, only to leave DNS to Bun
  // whenever any proxy is set (s3.ts).
  ALL_PROXY: "a standard proxy variable, not one of ours",
  DOCKER_BACKEND_TEST_HELPER_IMAGE: "tests only",
  WORKER_WORKSPACE_MOUNT_DIR:
    "derived by the execution backend, not an operator setting",
  WORKER_WORKSPACE_QUOTA_BYTES:
    "derived from the backend's existing workspace quota",
  WORKER_WORKSPACE_QUOTA_MODE:
    "reports the local backend's validated quota mode",
  K8S_BACKEND_TEST: "tests only (docs/contributing/development.md)",
  K8S_BACKEND_TEST_IMAGE: "tests only (docs/contributing/development.md)",
  K8S_BACKEND_TEST_KEEP: "tests only (docs/contributing/development.md)",
  GIT_ALLOW_PROTOCOL: "written into git's environment, not read",
  GIT_CONFIG_COUNT: "written into git's environment, not read",
  GIT_CONFIG_SYSTEM:
    "git's own variable, passed on to the attribution repair tool when set",
  NODE_EXTRA_CA_CERTS: "written into the engine's environment, not read",
  NEXT_PUBLIC_BASE_PATH: "inlined into the docs site by its next.config.mjs",
  DEMO_FIXTURES:
    "inlined into the console demo build by apps/web/vite.config.ts",
  CHOKIDAR_USEPOLLING:
    "the Vite dev server's file watcher (docs/contributing/development.md)",
  EXECUTION_VOLUME_LABEL_NAMESPACE:
    "kept out of public docs; an existing install sets it to keep its volumes",
  EXECUTION_VOLUME_NAME_PREFIX:
    "kept out of public docs; an existing install sets it to keep its volumes",
};

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync(root)];
}

/** What apps/ and packages/ read at runtime; test helpers are not settings. */
function codeSettings(): Set<string> {
  const names = new Set<string>();
  for (const file of scan("{apps,packages}/**/*.ts")) {
    if (
      /(^|\/)(node_modules|dist|bench)\//.test(file) ||
      file.startsWith("packages/testkit/") ||
      /\.(test|integration)\.ts$/.test(file)
    ) {
      continue;
    }
    const source = withoutComments(readFileSync(join(root, file), "utf8"));
    for (const pattern of CODE_READS) {
      for (const match of source.matchAll(pattern)) names.add(match[1] ?? "");
    }
  }
  // The pass loop builds each role's names from a prefix and a suffix.
  const loop = readFileSync(
    join(root, "apps/control-host/src/pass-loop/loop.ts"),
    "utf8",
  );
  const prefixes = [...loop.matchAll(/prefix: "([A-Z]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  const suffixes = [
    ...loop.matchAll(/^\s+([A-Z_]+): "\w+",$/gm),
    ...loop.matchAll(/\$\{role\.prefix\}_([A-Z_]+)/g),
  ].map((m) => m[1] ?? "");
  expect(prefixes).toEqual(["RECONCILER", "SCHEDULER"]);
  for (const suffix of suffixes) {
    names.delete(suffix);
    for (const prefix of prefixes) names.add(`${prefix}_${suffix}`);
  }
  return names;
}

function shellSettings(): Set<string> {
  const names = new Set<string>();
  for (const file of [...scan("infra/*.yml"), ...scan("scripts/*.sh")]) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(SHELL_DEFAULTS)) {
      names.add(match[1] ?? "");
    }
  }
  return names;
}

describe("Operator settings", () => {
  const documented = (text: string, name: string) =>
    new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(text);

  test("every setting the code reads is in docs/operator/", () => {
    const operator = [
      ...scan("docs/operator/*.md"),
      ...scan("apps/docs/content/docs/run-server/self-hosting/**/*.mdx"),
    ]
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    const names = codeSettings();
    // The scan still sees each of its three forms, and every exception.
    for (const name of [
      "HEARTBEAT_TTL_SEC",
      "WORKER_PIDS_LIMIT",
      "SCHEDULER_STATUS_FILE",
      ...Object.keys(NOT_SETTINGS),
    ]) {
      expect(names).toContain(name);
    }
    const missing = [...names]
      .filter((name) => !(name in NOT_SETTINGS))
      .filter((name) => !documented(operator, name))
      .sort();
    expect(missing).toEqual([]);
  });

  test("every value compose or a script takes from the shell is in docs/", () => {
    const docs = [
      ...scan("docs/**/*.md"),
      ...scan("apps/docs/content/docs/run-server/self-hosting/**/*.mdx"),
    ]
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    const names = shellSettings();
    expect(names).toContain("API_MEMORY_MB");
    const missing = [...names]
      .filter((name) => !(name in NOT_SETTINGS))
      .filter((name) => !documented(docs, name))
      .sort();
    expect(missing).toEqual([]);
  });
});
