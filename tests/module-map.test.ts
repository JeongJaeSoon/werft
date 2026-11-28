import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

/**
 * The rules that keep code names out of the code (docs/architecture/modules.md):
 *
 *   M1 the map names every workspace package and every domain folder, and
 *      nothing that is not there
 *   M2 no path component, file name or package name carries a code name
 *   M3 no text that leaves the repository (console copy, docs site, OpenAPI,
 *      SDK README, Slack copy, what the model reads) carries one
 *   M4 a domain has one folder name on every layer, and a module's files do
 *      not sit in another module's folder
 *
 * Each rule is a function of paths and text, so the cases below break it on
 * purpose without touching the tree.
 */
const root = join(import.meta.dir, "..");
const mapFile = "docs/architecture/modules.md";

const layers = {
  contracts: "packages/contracts/src/",
  platform: "packages/platform/src/",
  db: "packages/db/src/",
  route: "apps/control-host/src/api/routes/",
} as const;
type Layer = keyof typeof layers;

/** What a module cell may say: a code name, or one of the three open answers. */
const modules = [
  "Werft",
  "Kiel",
  "Musterrolle",
  "Kollegium",
  "Wache",
  "Takelage",
  "Lotse",
  "걸침",
  "미정",
  "공용",
];

/**
 * Code names, today's and the ones given up. A long name is found anywhere in
 * a word; a short one only as a whole word, so "kielbasa" is not one.
 */
const longNames = [
  "musterrolle",
  "kollegium",
  "takelage",
  "bootsmann",
  "speicher",
  "gewissen",
  "flaggschiff",
  "hafenmeister",
];
const shortNames = [
  "kiel",
  "lotse",
  "flotte",
  "kollege",
  "verband",
  "trosse",
  "geleit",
  "beiboot",
  "wache",
];
const codeName = new RegExp(
  `(?:${longNames.join("|")})|(?<![a-z])(?:${shortNames.join("|")})(?![a-z])`,
  "i",
);

type MapTables = {
  packages: Map<string, string>;
  domains: Map<string, { module: string; layers: string[] }>;
};

function tableRows(markdown: string, name: string): string[][] {
  const block = new RegExp(
    `<!-- ${name}:begin -->\\n([\\s\\S]*?)<!-- ${name}:end -->`,
  ).exec(markdown)?.[1];
  if (block === undefined) throw new Error(`${mapFile} has no ${name} table`);
  return block
    .split("\n")
    .filter((line) => /^\| `/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/^`|`$/g, "")),
    );
}

export function readMap(markdown: string): MapTables {
  const packages = new Map<string, string>();
  for (const [directory = "", module = ""] of tableRows(markdown, "packages"))
    packages.set(directory, module);
  const domains = new Map<string, { module: string; layers: string[] }>();
  for (const [name = "", module = "", where = ""] of tableRows(
    markdown,
    "domains",
  ))
    domains.set(name, {
      module,
      layers: where.split("·").map((layer) => layer.trim()),
    });
  return { packages, domains };
}

/** Each layer's domain folders: the first folder under it that holds a file. */
function domainFolders(files: readonly string[]): Map<string, Layer[]> {
  const found = new Map<string, Layer[]>();
  for (const [layer, folder] of Object.entries(layers) as [Layer, string][])
    for (const file of files) {
      if (!file.startsWith(folder)) continue;
      const [domain, ...rest] = file.slice(folder.length).split("/");
      if (!domain || rest.length === 0) continue;
      const seen = found.get(domain) ?? [];
      if (!seen.includes(layer)) seen.push(layer);
      found.set(domain, seen);
    }
  return found;
}

function workspacePackages(
  files: readonly string[],
  globs: readonly string[],
): string[] {
  return files
    .filter((file) => file.endsWith("/package.json"))
    .map((file) => file.slice(0, -"/package.json".length))
    .filter((directory) =>
      globs.some(
        (glob) =>
          glob.endsWith("/*") &&
          directory.startsWith(glob.slice(0, -1)) &&
          !directory.slice(glob.length - 1).includes("/"),
      ),
    );
}

/** M1: what the map and the tree disagree on. */
export function mapGaps(
  markdown: string,
  files: readonly string[],
  workspaceGlobs: readonly string[],
): string[] {
  const { packages, domains } = readMap(markdown);
  const gaps: string[] = [];
  for (const table of ["packages", "domains"]) {
    const names = tableRows(markdown, table).map(([name = ""]) => name);
    for (const name of new Set(names))
      if (names.indexOf(name) !== names.lastIndexOf(name))
        gaps.push(`${name} is on the map twice`);
  }
  const present = workspacePackages(files, workspaceGlobs);
  for (const directory of present)
    if (!packages.has(directory))
      gaps.push(`package ${directory} is not on the map`);
  for (const directory of packages.keys())
    if (!present.includes(directory))
      gaps.push(`the map names package ${directory}, which does not exist`);
  const folders = domainFolders(files);
  for (const [domain, where] of folders)
    if (!domains.has(domain))
      gaps.push(
        `domain folder ${domain} (${where.join(", ")}) is not on the map`,
      );
  for (const domain of domains.keys())
    if (!folders.has(domain))
      gaps.push(`the map names domain folder ${domain}, which does not exist`);
  for (const [name, module] of [
    ...packages,
    ...[...domains].map(([domain, row]) => [domain, row.module] as const),
  ])
    if (!modules.includes(module))
      gaps.push(`${name}: "${module}" is not a module the map defines`);
  return gaps.sort();
}

/**
 * M2: paths and package names that carry a code name, each named by the
 * shortest path that does.
 */
export function codeNamedPaths(
  files: readonly string[],
  packageNames: Readonly<Record<string, string>> = {},
): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    const at = parts.findIndex(namesCode);
    if (at >= 0) found.add(parts.slice(0, at + 1).join("/"));
  }
  for (const [manifest, name] of Object.entries(packageNames))
    if (namesCode(name)) found.add(`${manifest}: package name ${name}`);
  return [...found].sort();
}

/**
 * Whether a name carries a code name. Names are split at separators and at
 * camelCase humps first, so workerKielStatus.ts is found and kielbasa.ts is not.
 */
function namesCode(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return (
    longNames.some((long) => name.toLowerCase().includes(long)) ||
    words.some((word) => shortNames.includes(word))
  );
}

/** Never grows. A path with a code name is renamed, not listed. */
const codeNamedPathsAllowed: readonly string[] = [];

/** The files whose text leaves the repository: shown, published, sent or read by a model. */
export function isOutwardText(file: string): boolean {
  if (/\.test\.tsx?$/.test(file) || file.includes("/__fixtures__/"))
    return false;
  return [
    // Console and component copy.
    /^apps\/web\/src\/i18n\//,
    /^packages\/react\/src\/messages\//,
    /^packages\/react\/src\/components\/.*\/messages\.ts$/,
    // The docs site, the API reference and the READMEs of published packages.
    /^apps\/docs\/content\//,
    /^apps\/docs\/src\/lib\/i18n\.ts$/,
    /^docs\/openapi\.json$/,
    /^packages\/[^/]+\/README\.md$/,
    // What Slack shows.
    /^packages\/adapters\/chat\/slack\/src\//,
    /^packages\/contracts\/src\/access-control\/slack-[^/]+\.ts$/,
    /^packages\/contracts\/src\/domain\/slack-notice\.ts$/,
    // What an account link answers a person with.
    /^packages\/contracts\/src\/access-control\/linked-accounts\.ts$/,
    // What a model reads: the built-in server's guide and instructions, and
    // the descriptions of the tools it is given.
    /^packages\/platform\/src\/extensions\/builtin\//,
    /^packages\/contracts\/src\/action\//,
    /^apps\/worker\/src\/conversation\/conversation-tools\.ts$/,
    /^apps\/worker\/src\/legacy-platform-prompt\.ts$/,
  ].some((pattern) => pattern.test(file));
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
    (ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(parent.expression) &&
          parent.expression.text === "require")))
  );
}

/** The text a script can show: its strings and JSX text, not its comments or import paths. */
function shownText(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      if (!isModuleSpecifier(node)) texts.push(node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    )
      texts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return texts;
}

/** M3: code names in outward text, as "<file>: <name>". */
export function codeNamesShown(
  texts: Readonly<Record<string, string>>,
): string[] {
  const found = new Set<string>();
  for (const [file, source] of Object.entries(texts)) {
    if (!isOutwardText(file)) continue;
    const shown = /\.tsx?$/.test(file) ? shownText(file, source) : [source];
    for (const text of shown)
      for (const match of text.matchAll(new RegExp(codeName.source, "gi")))
        found.add(`${file}: ${match[0]}`);
  }
  return [...found].sort();
}

/** What may sit directly under an extensions/ folder. */
const extensionsChildren = [
  "skills",
  "bundles",
  "mcp",
  "builtin",
  "ports",
  "index.ts",
];
/**
 * A file named like this belongs to extensions/ on every layer that splits by
 * module, in the part named. (bundle-* is left out: checkpoints has git bundles.)
 */
const extensionsFiles: readonly [RegExp, string][] = [
  [/^(skill-|skills\.)/, "skills"],
  [/^extension-bundle/, "bundles"],
  [/^(workspace-mcp|agent-workspace-mcp|agent-mcp)/, "mcp"],
  [/^werft-mcp/, "builtin"],
];
/** Relaying an MCP call at run time is the workers' job, whatever server it reaches. */
const relayFile = /(^|-)mcp-egress\.[^/]+$/;
const sharedFolders = ["ports", "testing"];

/** M4: where a layer names a domain differently from the map, or holds another module's files. */
export function layerDrift(
  markdown: string,
  files: readonly string[],
): string[] {
  const { domains } = readMap(markdown);
  const drift: string[] = [];
  for (const [domain, where] of domainFolders(files)) {
    const listed = domains.get(domain)?.layers;
    if (listed && [...listed].sort().join() !== [...where].sort().join())
      drift.push(
        `${domain}: the map says ${listed.join(" · ")}, the tree has ${where.join(" · ")}`,
      );
  }
  for (const layer of ["platform", "db", "route"] as const)
    for (const file of files) {
      if (!file.startsWith(layers[layer])) continue;
      const parts = file.slice(layers[layer].length).split("/");
      const [domain = "", child = ""] = parts;
      const name = parts.at(-1) ?? "";
      if (parts.length < 2 || sharedFolders.includes(domain)) continue;
      const part = relayFile.test(name)
        ? undefined
        : extensionsFiles.find(([pattern]) => pattern.test(name))?.[1];
      if (domain === "extensions") {
        if (!extensionsChildren.includes(child))
          drift.push(
            `${file}: only ${extensionsChildren.join(", ")} sit directly under extensions/`,
          );
        else if (part && child !== part && child !== "ports")
          drift.push(`${file}: named like an extensions/${part}/ file`);
        continue;
      }
      if (relayFile.test(name)) {
        if (
          layer === "platform" &&
          domain === "workers" &&
          !["mcp-egress", "ports"].includes(child)
        )
          drift.push(`${file}: an MCP relay belongs to workers/mcp-egress/`);
        continue;
      }
      if (part)
        drift.push(`${file}: named like an extensions/ file, in ${domain}/`);
    }
  return drift.sort();
}

function repositoryFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file && existsSync(join(root, file)));
}

const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("module map", () => {
  // Every case lists the tracked files, and M3 parses a few hundred of them:
  // quick here, several times slower on a CI runner that shares its process.
  const slow = 60_000;

  test(
    "M1: the map names every workspace package and domain folder, and only those",
    () => {
      const { workspaces } = JSON.parse(read("package.json")) as {
        workspaces: string[];
      };
      expect(mapGaps(read(mapFile), repositoryFiles(), workspaces)).toEqual([]);
    },
    slow,
  );

  test(
    "M2: no path, file name or package name carries a code name",
    () => {
      const files = repositoryFiles();
      const names: Record<string, string> = {};
      for (const file of files)
        if (/(^|\/|\.)package\.json$/.test(file))
          names[file] = String(
            (JSON.parse(read(file)) as { name?: string }).name ?? "",
          );
      expect(codeNamedPaths(files, names)).toEqual([...codeNamedPathsAllowed]);
      expect(codeNamedPathsAllowed).toEqual([]);
    },
    slow,
  );

  test(
    "M3: no outward text carries a code name",
    () => {
      const texts: Record<string, string> = {};
      for (const file of repositoryFiles())
        if (isOutwardText(file)) texts[file] = read(file);
      expect(Object.keys(texts).length).toBeGreaterThan(100);
      expect(codeNamesShown(texts)).toEqual([]);
    },
    slow,
  );

  test(
    "M4: a domain has one folder name on every layer and holds no other module's files",
    () => {
      expect(layerDrift(read(mapFile), repositoryFiles())).toEqual([]);
    },
    slow,
  );

  const map = [
    "<!-- packages:begin -->",
    "| 패키지 | 모듈 |",
    "| --- | --- |",
    "| `apps/worker` | Kiel |",
    "| `packages/adapters/chat/slack` | Kollegium |",
    "<!-- packages:end -->",
    "<!-- domains:begin -->",
    "| 도메인 폴더 | 모듈 | 있는 층 | 비고 |",
    "| --- | --- | --- | --- |",
    "| `sessions` | Kiel | platform · db | |",
    "| `extensions` | Takelage | platform · db · route | |",
    "| `workers` | Kiel | platform | |",
    "| `ports` | 공용 | platform | |",
    "<!-- domains:end -->",
  ].join("\n");
  const tree = [
    "apps/worker/package.json",
    "packages/adapters/chat/slack/package.json",
    "packages/platform/src/index.ts",
    "packages/platform/src/sessions/service.ts",
    "packages/platform/src/extensions/index.ts",
    "packages/platform/src/extensions/ports/store.ts",
    "packages/platform/src/extensions/skills/skill-service.ts",
    "packages/platform/src/workers/mcp-egress/workspace-mcp-egress.ts",
    "packages/platform/src/workers/ports/workspace-mcp-egress.ts",
    "packages/platform/src/ports/clock.ts",
    "packages/db/src/sessions/store.ts",
    "packages/db/src/sessions/workspace-mcp-egress.ts",
    "packages/db/src/extensions/mcp/workspace-mcp.ts",
    "apps/control-host/src/api/routes/extensions/skills/skills.ts",
  ];
  const globs = ["apps/*", "packages/*", "packages/adapters/chat/*"];

  test("the fixture the cases below break is clean", () => {
    expect(mapGaps(map, tree, globs)).toEqual([]);
    expect(layerDrift(map, tree)).toEqual([]);
    expect(codeNamedPaths(tree)).toEqual([]);
  });

  test("M1 catches a folder or package the map lacks, a row with nothing behind it, a row written twice and a module nobody defined", () => {
    expect(
      mapGaps(
        map,
        [
          ...tree,
          "packages/platform/src/billing/service.ts",
          "packages/newcomer/package.json",
        ],
        globs,
      ),
    ).toEqual([
      "domain folder billing (platform) is not on the map",
      "package packages/newcomer is not on the map",
    ]);
    // A row deleted from the map leaves its folder unnamed.
    expect(
      mapGaps(map.replace(/^\| `sessions`.*\n/m, ""), tree, globs),
    ).toEqual(["domain folder sessions (platform, db) is not on the map"]);
    expect(
      mapGaps(
        map,
        tree.filter(
          (file) => !file.includes("/workers/") && !file.includes("slack"),
        ),
        globs,
      ),
    ).toEqual([
      "the map names domain folder workers, which does not exist",
      "the map names package packages/adapters/chat/slack, which does not exist",
    ]);
    expect(
      mapGaps(map.replace("| Takelage |", "| Rigging |"), tree, globs),
    ).toEqual(['extensions: "Rigging" is not a module the map defines']);
    expect(
      mapGaps(
        map.replace(
          /^(\| `ports`.*\n)/m,
          "$1| `ports` | Kiel | platform | |\n",
        ),
        tree,
        globs,
      ),
    ).toEqual(["ports is on the map twice"]);
    // A file directly under a layer is shared and needs no row.
    expect(mapGaps(map, [...tree, "packages/db/src/schema.ts"], globs)).toEqual(
      [],
    );
  });

  test("M2 catches a code name as a folder, in a file name (camelCase too) and in a package name, old names included, and not inside another word", () => {
    expect(
      codeNamedPaths(
        [
          ...tree,
          "packages/platform/src/kiel/session.ts",
          "packages/db/src/musterrolle/members.ts",
          "docs/kollegium-notes.md",
          "packages/platform/src/agents/lotseTeams.ts",
          "packages/platform/src/workers/workerKielStatus.ts",
          "packages/speicher/src/index.ts",
          "apps/web/src/takelageList.tsx",
          "packages/platform/src/sessions/kielbasa.ts",
          "packages/platform/src/sessions/pilots.ts",
        ],
        {
          "packages/x/package.json": "@werft-ai/kiel-runtime",
          "packages/y/package.json": "@werft-ai/platform",
        },
      ),
    ).toEqual([
      "apps/web/src/takelageList.tsx",
      "docs/kollegium-notes.md",
      "packages/db/src/musterrolle",
      "packages/platform/src/agents/lotseTeams.ts",
      "packages/platform/src/kiel",
      "packages/platform/src/workers/workerKielStatus.ts",
      "packages/speicher",
      "packages/x/package.json: package name @werft-ai/kiel-runtime",
    ]);
  });

  test("M3 catches a code name in a string, a template and a document, and not in a comment, an import path, a test or a file nobody outside reads", () => {
    expect(
      codeNamesShown({
        "apps/web/src/i18n/en.ts": [
          "// Musterrolle decides this.",
          'import { x } from "../kollegium/agents.ts";',
          'export const title = "Members";',
          'export const hint = "Asked of Musterrolle";',
          "export const more = `Run by Kiel for ${x}`;",
        ].join("\n"),
        "apps/docs/content/docs/index.mdx": "Kollegium keeps the agents.",
        "docs/openapi.json": '{"description":"The Lotse team"}',
        "packages/sdk/README.md": "Werft SDK",
        "apps/worker/src/legacy-platform-prompt.ts":
          'export const text = "Use Kiel";',
        "packages/contracts/src/access-control/linked-accounts.ts":
          'export const notice = "Linked by Kollegium";',
        "apps/docs/src/lib/i18n.ts": 'export const title = "Lotse docs";',
        "apps/web/src/i18n/i18n.test.ts": 'expect("Kiel")',
        "packages/platform/src/sessions/service.ts": 'log("Kiel")',
      }),
    ).toEqual([
      "apps/docs/content/docs/index.mdx: Kollegium",
      "apps/docs/src/lib/i18n.ts: Lotse",
      "apps/web/src/i18n/en.ts: Kiel",
      "apps/web/src/i18n/en.ts: Musterrolle",
      "apps/worker/src/legacy-platform-prompt.ts: Kiel",
      "docs/openapi.json: Lotse",
      "packages/contracts/src/access-control/linked-accounts.ts: Kollegium",
    ]);
  });

  test("M4 catches a layer the map does not list, a loose file under extensions/, an extensions file in another domain or in the wrong part, and a relay outside workers/mcp-egress", () => {
    expect(
      layerDrift(map, [
        ...tree,
        "apps/control-host/src/api/routes/sessions/sessions.ts",
        "packages/db/src/extensions/skill-store.ts",
        "packages/db/src/sessions/workspace-mcp.ts",
        "apps/control-host/src/api/routes/extensions/skills.ts",
        "packages/platform/src/sessions/agent-mcp-service.ts",
        "packages/db/src/sessions/extension-bundles.ts",
        "packages/db/src/extensions/builtin/skill-store.ts",
        "packages/platform/src/workers/github-mcp-egress.ts",
        // Shared folders and files directly under a layer are nobody's.
        "packages/platform/src/testing/workspace-mcp-fakes.ts",
        "packages/db/src/workspace-mcp-egress.integration.test.ts",
      ]),
    ).toEqual([
      "apps/control-host/src/api/routes/extensions/skills.ts: only skills, bundles, mcp, builtin, ports, index.ts sit directly under extensions/",
      "packages/db/src/extensions/builtin/skill-store.ts: named like an extensions/skills/ file",
      "packages/db/src/extensions/skill-store.ts: only skills, bundles, mcp, builtin, ports, index.ts sit directly under extensions/",
      "packages/db/src/sessions/extension-bundles.ts: named like an extensions/ file, in sessions/",
      "packages/db/src/sessions/workspace-mcp.ts: named like an extensions/ file, in sessions/",
      "packages/platform/src/sessions/agent-mcp-service.ts: named like an extensions/ file, in sessions/",
      "packages/platform/src/workers/github-mcp-egress.ts: an MCP relay belongs to workers/mcp-egress/",
      "sessions: the map says platform · db, the tree has platform · db · route",
    ]);
  });
});
