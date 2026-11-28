#!/usr/bin/env bun
/**
 * Moves the code-named folders to feature-named ones and repairs everything
 * that names a moved file by path. The names it moves from and to are the
 * "rules" table below; docs/architecture/modules.md is the map it keeps.
 *
 *   bun scripts/move-module-folders.ts          move, rewrite, regenerate the map
 *   bun scripts/move-module-folders.ts --check  change nothing; exit 1 when a run would change something
 *
 * What a run does, in order:
 *   1. "git mv" every file an old-path rule matches (an untracked file is renamed).
 *   2. In every TypeScript file, rewrite relative module specifiers and
 *      relative path strings: read against the file's old place, written
 *      against its new one.
 *   3. In every text file, rewrite a moved path written out of the repository
 *      root, a "musterrolle/" or "kollegium/" path segment, a "routes/..."
 *      key of the control host, and the links of the verify docs.
 *   4. Run biome on what it rewrote (import order and line width follow the path).
 *      The contracts index keeps its order: see keptOrder.
 *   5. Regenerate the tables of docs/architecture/modules.md.
 *   6. Fail if a relative import still names a file that does not exist, or
 *      names one file from where it is and another from where it was.
 *
 * Running it again changes nothing: a rule matches an old path only, never
 * the place it moves to. On a branch cut before the move, merge main first
 * (git follows the renames), then run it: files the branch added under an old
 * path move too, and imports the branch wrote against old paths are repaired.
 * It stops before changing anything when a file would land on an existing
 * one, when two files would land on one name, or when a file sits directly
 * under an extensions/ folder with no rule
 * (pick skills/, bundles/, mcp/ or builtin/ and add it to "rules").
 *
 * Not touched: CHANGELOG.md, changelog.d/, the migrations, lock files, the
 * map's own text, this script and tests/module-map.test.ts (the last two name
 * the old paths on purpose).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import * as ts from "typescript";

const root = join(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");

const contracts = "packages/contracts/src/";
const platform = "packages/platform/src/";
const db = "packages/db/src/";
const routes = "apps/control-host/src/api/routes/";
const verifyDocs = ".claude/skills/verify-werft/";

/**
 * root + from becomes root + to; what follows is kept. "only" holds the rule
 * to the paths whose remainder matches. The first matching rule wins, so a
 * narrower rule stands above the folder rule it carves out of.
 */
type Rule = { root: string; from: string; to: string; only?: RegExp };

const rules: readonly Rule[] = [
  { root: contracts, from: "musterrolle/", to: "access-control/" },
  { root: contracts, from: "kollegium/", to: "agents/" },

  { root: platform, from: "musterrolle/", to: "access-control/" },
  { root: platform, from: "workspace-mcp/ports/", to: "extensions/ports/" },
  { root: platform, from: "workspace-mcp/", to: "extensions/mcp/" },
  { root: platform, from: "werft-mcp/", to: "extensions/builtin/" },
  {
    root: platform,
    from: "agents/ports/",
    to: "extensions/ports/",
    only: /^agent-workspace-mcp-[^/]+$/,
  },
  {
    root: platform,
    from: "agents/",
    to: "extensions/mcp/",
    only: /^agent-workspace-mcp-[^/]+$/,
  },
  {
    root: platform,
    from: "extensions/",
    to: "extensions/skills/",
    only: /^(skill-[^/]+|line-diff\.[^/]+)$/,
  },
  {
    root: platform,
    from: "extensions/",
    to: "extensions/bundles/",
    only: /^(bundle-[^/]+|(resolve|secret-scan|session-extensions)\.[^/]+)$/,
  },
  {
    root: platform,
    from: "workers/",
    to: "workers/mcp-egress/",
    only: /^([a-z]+-)?mcp-egress\.[^/]+$/,
  },

  {
    root: db,
    from: "musterrolle/",
    to: "extensions/mcp/",
    only: /^workspace-mcp[^/]*$/,
  },
  { root: db, from: "musterrolle/", to: "access-control/" },
  {
    root: db,
    from: "agents/",
    to: "extensions/mcp/",
    only: /^agent-workspace-mcp[^/]*$/,
  },
  { root: db, from: "werft-mcp/", to: "extensions/builtin/" },
  {
    root: db,
    from: "extensions/",
    to: "extensions/bundles/",
    only: /^extension-bundle[^/]*$/,
  },
  {
    root: db,
    from: "extensions/",
    to: "extensions/skills/",
    only: /^skill-[^/]+$/,
  },

  {
    root: routes,
    from: "musterrolle/",
    to: "extensions/mcp/",
    only: /^workspace-mcp-servers[^/]*$/,
  },
  { root: routes, from: "musterrolle/", to: "access-control/" },
  {
    root: routes,
    from: "agents/",
    to: "extensions/mcp/",
    only: /^agent-(workspace-)?mcp[^/]*$/,
  },
  {
    root: routes,
    from: "extensions/",
    to: "extensions/skills/",
    only: /^skill[^/]*$/,
  },

  {
    root: `${verifyDocs}features/`,
    from: "musterrolle.md",
    to: "access-control.md",
  },
];

/** Where a path goes. A path no rule matches, a moved one included, comes back as it is. */
function mapPath(path: string): string {
  for (const rule of rules) {
    const from = rule.root + rule.from;
    if (!rule.only && from.endsWith("/") && path === from.slice(0, -1))
      return (rule.root + rule.to).slice(0, -1);
    if (!path.startsWith(from)) continue;
    const rest = path.slice(from.length);
    if (rule.only && !rule.only.test(rest)) continue;
    return rule.root + rule.to + rest;
  }
  return path;
}

/** The old paths that move to "path": where a file now at "path" may have been written. */
function oldPathsOf(path: string): string[] {
  const found: string[] = [];
  for (const rule of rules) {
    const to = rule.root + rule.to;
    if (!path.startsWith(to)) continue;
    const old = rule.root + rule.from + path.slice(to.length);
    if (old !== path && mapPath(old) === path) found.push(old);
  }
  return found;
}

/** What stays directly under an extensions/ folder, and the folders the rest goes into. */
const extensionsEntrances = /^(index\.tsx?|ports\/.*)$/;
const extensionsParts = ["skills", "bundles", "mcp", "builtin"];

const mapFile = "docs/architecture/modules.md";

/** Never rewritten: history, generated files, and the files that name old paths on purpose. */
const untouched = [
  "CHANGELOG.md",
  "changelog.d/",
  "packages/db/migrations/",
  "bun.lock",
  "THIRD_PARTY_NOTICES.md",
  mapFile,
  "scripts/move-module-folders.ts",
  "tests/module-map.test.ts",
];

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, maxBuffer: 1 << 28 });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const exists = (path: string) => existsSync(join(root, path));
const isScript = (path: string) => /\.(tsx?|mts|cts)$/.test(path);
const read = (path: string) => readFileSync(join(root, path), "utf8");

function listed(...args: string[]): string[] {
  return git("ls-files", "-z", ...args)
    .split("\0")
    .filter(Boolean);
}

function foldersOf(files: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const file of files)
    for (let folder = dirname(file); folder !== "."; folder = dirname(folder)) {
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  return folders;
}

// ---------------------------------------------------------------- 1. moves

const tracked = new Set(listed("--cached"));
const before = [
  ...new Set([...tracked, ...listed("--others", "--exclude-standard")]),
]
  .filter(exists)
  .sort();

const moves = new Map<string, string>();
const landing = new Map<string, string[]>();
const problems: string[] = [];
for (const path of before) {
  const to = mapPath(path);
  if (mapPath(to) !== to)
    problems.push(
      `${path}: the rules move ${to} again; a rule must not match its own target`,
    );
  if (to !== path) {
    if (exists(to))
      problems.push(
        `${path}: ${to} already exists; merge the two by hand, then run again`,
      );
    moves.set(path, to);
    landing.set(to, [...(landing.get(to) ?? []), path]);
  }
  for (const layer of [platform, db, routes]) {
    const folder = `${layer}extensions/`;
    if (!to.startsWith(folder)) continue;
    const rest = to.slice(folder.length);
    if (
      !extensionsEntrances.test(rest) &&
      !extensionsParts.some((part) => rest.startsWith(`${part}/`))
    )
      problems.push(
        `${path}: no rule says which of ${extensionsParts.join("/, ")}/ it belongs to; add one to rules`,
      );
  }
}
// Several rules gather files into one folder, so two old files can claim one name.
for (const [to, from] of landing)
  if (from.length > 1)
    problems.push(
      `${from.join(" and ")}: both move to ${to}; merge them by hand, then run again`,
    );
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(2);
}

/** The path a file had before this run, by the path it has after it. */
const cameFrom = new Map<string, string>();
for (const [from, to] of moves) cameFrom.set(to, from);

if (!checkOnly) {
  for (const [from, to] of moves) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    if (tracked.has(from)) git("mv", from, to);
    else renameSync(join(root, from), join(root, to));
  }
  // Leave no empty folder behind, so nothing reads an old name as present.
  for (let folder of [...foldersOf([...moves.keys()])].sort().reverse())
    while (folder !== "." && existsSync(join(root, folder))) {
      if (readdirSync(join(root, folder)).length > 0) break;
      rmdirSync(join(root, folder));
      folder = dirname(folder);
    }
}

const after = before.map((path) => moves.get(path) ?? path);
const afterFiles = new Set(after);
const afterFolders = foldersOf(after);
const beforeFiles = new Set(before);
const beforeFolders = foldersOf(before);

/** Whether a path names a file or a folder once the moves are done (in --check, before they are). */
function existsAfter(path: string): boolean {
  if (afterFiles.has(path) || afterFolders.has(path)) return true;
  // An ignored file (a build output a test reads) is on disk but in no list.
  return !beforeFiles.has(path) && !beforeFolders.has(path) && exists(path);
}

// ------------------------------------------------------- 2. TypeScript files

type Edit = { start: number; end: number; text: string };

/** Imports this run left alone because the path names one file here and another from the file's old place. */
const twoReadings: string[] = [];

function relativeFrom(file: string, target: string, keepSlash: boolean) {
  let specifier = posix.relative(dirname(file), target) || ".";
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return keepSlash && !specifier.endsWith("/") ? `${specifier}/` : specifier;
}

/**
 * A relative path written in "file", read where the file was and written for
 * where it is. A module specifier is always repaired; any other string only
 * when what it names exists, since "../x" may be test data and not a path.
 */
function repairedRelative(
  text: string,
  file: string,
  isSpecifier: boolean,
): string | undefined {
  if (!/^\.\.?\/.*[\w*]/.test(text)) return undefined;
  const [pathPart = "", suffix = ""] = text.split(/(?=[?#])/, 2);
  const keepSlash = pathPart.endsWith("/");
  const resolved = (from: string) =>
    posix.normalize(posix.join(dirname(from), pathPart)).replace(/\/$/, "");
  const origin = cameFrom.get(file) ?? file;
  const oldTarget = resolved(origin);
  const target = mapPath(oldTarget);
  if (origin !== file || target !== oldTarget) {
    if (!isSpecifier && !existsAfter(target)) return undefined;
    return relativeFrom(file, target, keepSlash) + suffix;
  }
  // The file is where a rule moves files to. Text written for its old place
  // and merged in after the move names something else from here: nothing, or
  // by chance another file ("../index.ts" one folder deeper).
  const fromOldPlace = [
    ...new Set(oldPathsOf(file).map((old) => mapPath(resolved(old)))),
  ].filter((candidate) => candidate !== target && existsAfter(candidate));
  const [only] = fromOldPlace;
  if (existsAfter(target) || fromOldPlace.length > 1) {
    if (only && isSpecifier)
      twoReadings.push(
        `${file}: "${text}" is ${existsAfter(target) ? target : "nothing"} from here and ${fromOldPlace.join(" or ")} from where the file was`,
      );
    return undefined;
  }
  return only ? relativeFrom(file, only, keepSlash) + suffix : undefined;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
    return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent))
    return true;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node)
    return false;
  const callee = parent.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const object = callee.expression;
  return (
    // mock.module("./x.ts", ...) and import.meta.resolve("./x.ts")
    (callee.name.text === "module" &&
      ts.isIdentifier(object) &&
      object.text === "mock") ||
    (callee.name.text === "resolve" && ts.isMetaProperty(object))
  );
}

const apiRoot = "apps/control-host/src/api/";

function scriptEdits(file: string, text: string): Edit[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits: Edit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      let next = repairedRelative(node.text, file, isModuleSpecifier(node));
      // A key the control host's tests file route errors under: a path below api/.
      if (
        next === undefined &&
        file.startsWith(apiRoot) &&
        node.text.startsWith("routes/")
      )
        next = existsAfter(mapPath(apiRoot + node.text))
          ? mapPath(apiRoot + node.text).slice(apiRoot.length)
          : undefined;
      if (next !== undefined && next !== node.text)
        edits.push({
          start: node.getStart(source) + 1,
          end: node.getEnd() - 1,
          text: next,
        });
    } else if (ts.isTemplateExpression(node)) {
      // A template that opens with import.meta.dir and "/..": the text after
      // the directory is a path that starts there.
      const [first] = node.templateSpans;
      if (
        node.head.text === "" &&
        first &&
        first.expression.getText(source) === "import.meta.dir" &&
        first.literal.text.startsWith("/..")
      ) {
        const written = `.${first.literal.text}`;
        const next = repairedRelative(written, file, false);
        if (next !== undefined && next !== written) {
          const start = first.literal.getStart(source) + 1;
          edits.push({
            start,
            end: start + first.literal.text.length,
            text: `/${next}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
}

function applyEdits(text: string, edits: Edit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

// ------------------------------------------------------------ 3. text files

const pathCharacters = "[\\w.*@-]+(?:/[\\w.*@-]+)*/?";
const escaped = (text: string) => text.replace(/[.*+?^$(){}|[\]\\/]/g, "\\$&");
const layerRoots = [...new Set(rules.map((rule) => rule.root))];
const rootedPath = new RegExp(
  `(?:${layerRoots.map(escaped).join("|")})${pathCharacters}`,
  "g",
);
// The two code-named folders, wherever a path names them. No other folder
// has either name, so the path segment alone says what is meant.
const codeNamedSegment = new RegExp(
  `(?<![\\w.-])(musterrolle|kollegium)/(${pathCharacters})?`,
  "g",
);

function mapToken(token: string): string {
  const dots = /\.+$/.exec(token)?.[0] ?? "";
  const bare = dots ? token.slice(0, -dots.length) : token;
  const slash = bare.endsWith("/") ? "/" : "";
  return mapPath(slash ? bare.slice(0, -1) : bare) + slash + dots;
}

/** Whether the match at `index` is part of an address ("https://host/musterrolle/x"): not a path of this repository. */
function inAddress(text: string, index: number): boolean {
  const word = /[^\s"'`()<>[\]]*$/.exec(text.slice(0, index))?.[0] ?? "";
  return word.includes("://");
}

/** `replace`, leaving a match inside an address as it is. */
function replacePaths(
  text: string,
  pattern: RegExp,
  mapped: (match: string, ...groups: (string | undefined)[]) => string,
): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    const index = rest.find((value) => typeof value === "number") as number;
    const groups = rest.slice(0, rest.indexOf(index)) as (string | undefined)[];
    return inAddress(text, index) ? match : mapped(match, ...groups);
  });
}

function rewriteText(file: string, text: string): string {
  let result = replacePaths(text, rootedPath, mapToken);
  result = replacePaths(result, codeNamedSegment, (_all, folder, rest = "") => {
    // db and the routes keep the remote MCP files in extensions/mcp.
    if (folder === "musterrolle" && /^workspace-mcp[^/]*$/.test(rest))
      return `extensions/mcp/${rest}`;
    return `${folder === "kollegium" ? "agents" : "access-control"}/${rest}`;
  });
  if (file.startsWith(verifyDocs))
    result = replacePaths(
      result,
      /(?<![\w-])musterrolle\.md\b/g,
      () => "access-control.md",
    );
  return result;
}

/**
 * Files whose statement order is part of what ships. packages/core bundles
 * every contracts module in the order this index names them, and that order
 * decides the gzip size its bundle budget holds. A path that sorts elsewhere
 * after the move must not re-sort them, so the file opts out of biome's sort.
 */
const keptOrder: Readonly<Record<string, string>> = {
  "packages/contracts/src/index.ts":
    "// biome-ignore-all assist/source/organizeImports: packages/core bundles the contracts in this order, and its bundle budget measures the gzip of that order\n",
};

const binary =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz|tgz|bundle|payload|wasm|mp4)$/i;
const rewritten: string[] = [];
const scripts: string[] = [];
for (const file of after) {
  if (untouched.some((path) => file === path || file.startsWith(path)))
    continue;
  if (binary.test(file)) continue;
  const onDisk = checkOnly ? (cameFrom.get(file) ?? file) : file;
  if (statSync(join(root, onDisk)).size > 4_000_000) continue;
  const text = read(onDisk);
  if (text.includes("\0")) continue;
  if (isScript(file)) scripts.push(file);
  let next = rewriteText(
    file,
    isScript(file) ? applyEdits(text, scriptEdits(file, text)) : text,
  );
  if (next === text) continue;
  rewritten.push(file);
  const opening = keptOrder[file] ?? "";
  if (!next.startsWith(opening)) next = opening + next;
  if (!checkOnly) writeFileSync(join(root, file), next);
}

// ---------------------------------------------------------------- 4. biome

if (!checkOnly) {
  const biome = join(root, "node_modules", ".bin", "biome");
  const targets = rewritten.filter((file) =>
    /\.(tsx?|mts|cts|mjs|js|jsonc?)$/.test(file),
  );
  if (!existsSync(biome))
    console.error(
      "biome is not installed: run bun install, then biome check --write on the rewritten files",
    );
  else
    for (let index = 0; index < targets.length; index += 200)
      spawnSync(
        biome,
        [
          "check",
          "--write",
          "--diagnostic-level=error",
          "--no-errors-on-unmatched",
          ...targets.slice(index, index + 200),
        ],
        { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
      );
}

// ------------------------------------------------------------------ 5. map

const layers = { contracts, platform, db, route: routes } as const;
const tick = String.fromCharCode(96);
const code = (text: string) => tick + text + tick;

/** Module and note of each domain folder, for a row the map does not have yet. */
const domainDefaults: Record<string, [module: string, note: string]> = {
  sessions: [
    "Kiel",
    `${code("sessions/achievements")}는 걸침: 성과 규칙은 workspace 설정, 판정은 세션 결과`,
  ],
  workers: ["Kiel", `${code("workers/mcp-egress")}는 실행 중 MCP 호출 중계`],
  scheduler: ["Kiel", ""],
  checkpoints: ["Kiel", ""],
  secrets: ["Kiel", ""],
  decision: [
    "Kiel",
    "답할 자격·승인 가능성 판단이 같이 있어 Musterrolle과 맞닿음",
  ],
  action: [
    "Kiel",
    `내장 github MCP 서버 코드(${code("action/github")})가 여기 있음`,
  ],
  catalog: ["Kiel", ""],
  limits: ["Kiel", "호출마다 잡고 거절하는 집행"],
  usage: [
    "걸침",
    "집계는 Kiel, 사람별 열람 권한과 보고서는 Musterrolle·Kollegium",
  ],
  github: [
    "걸침",
    "토큰 발급·작업 실행은 Kiel, App·workspace·에이전트 설정은 관리 권한",
  ],
  "access-control": [
    "Musterrolle",
    "안에 다른 모듈과 걸친 파일이 있음(Slack·GitHub 계약, 변수 부여, 알림)",
  ],
  agents: ["Kollegium", ""],
  surface: ["Kollegium", ""],
  conversations: [
    "Kollegium",
    "결정·문맥은 대화 기능, 턴 큐·permit·호출 정산은 실행 책임(Kiel)",
  ],
  extensions: [
    "Takelage",
    `${extensionsParts.map(code).join(" ")}. ${code("builtin")}(내장 werft MCP 서버와 그 안내)은 걸침: 제품 표면이고 호출 허가에 Kiel·Musterrolle이 관여`,
  ],
  memory: ["미정", "가시성 정책과 SQL만 있고 서비스·route가 없음"],
  api: ["Kiel", "공개 API 계약면"],
  "worker-protocol": ["Kiel", "worker gateway 계약면"],
  ports: ["공용", ""],
  testing: ["공용", ""],
  shared: ["공용", ""],
  domain: ["공용", "소속을 정하지 않은 계약"],
};

const packageDefaults: Record<string, string> = {
  "apps/worker": "Kiel",
  "apps/egress-proxy": "Kiel",
  "packages/runtime-core": "Kiel",
  "packages/storage": "Kiel",
  "packages/adapters/execution/kubernetes": "Kiel",
  "packages/adapters/execution/local-docker": "Kiel",
  "packages/adapters/runtimes/claude": "Kiel",
  "packages/adapters/runtimes/claude-codec": "Kiel",
  "packages/adapters/runtimes/codec-kit": "Kiel",
  "packages/adapters/runtimes/codecs": "Kiel",
  "packages/adapters/runtimes/codex": "Kiel",
  "packages/adapters/runtimes/codex-codec": "Kiel",
  "packages/adapters/runtimes/registry": "Kiel",
  "packages/adapters/forge/github": "Kiel",
  "packages/adapters/chat/slack": "Kollegium",
  "packages/contracts": "걸침",
  "packages/platform": "걸침",
  "packages/db": "걸침",
  "apps/control-host": "걸침",
  "packages/system": "공용",
  "packages/observability": "공용",
  "packages/testkit": "공용",
  "apps/web": "Werft",
  "apps/docs": "Werft",
  "packages/client": "Werft",
  "packages/core": "Werft",
  "packages/react": "Werft",
  "packages/ui": "Werft",
  "packages/sdk": "Werft",
};

const moduleOrder = [
  "Kiel",
  "Musterrolle",
  "Kollegium",
  "Takelage",
  "Lotse",
  "걸침",
  "미정",
  "Werft",
  "공용",
];
const byModule = (a: string, b: string) =>
  moduleOrder.indexOf(a) - moduleOrder.indexOf(b);

function block(text: string, name: string): string | undefined {
  return new RegExp(
    `<!-- ${name}:begin -->\\n([\\s\\S]*?)<!-- ${name}:end -->`,
  ).exec(text)?.[1];
}

/** The rows of a generated table as cells, without its header and rule lines. */
function rowsOf(table: string | undefined): string[][] {
  return (table ?? "")
    .split("\n")
    .filter((line) => line.startsWith(`| ${tick}`))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

const unquoted = (cell = "") => cell.replaceAll(tick, "");

/** A domain folder name as the rules leave it; undefined when it became part of another domain. */
function domainNow(name: string): string | undefined {
  for (const layer of Object.values(layers)) {
    const moved = mapPath(layer + name);
    if (moved !== layer + name) {
      const domain = moved.slice(layer.length);
      return domain.includes("/") ? undefined : domain;
    }
  }
  return name;
}

function domainTable(current: string): string {
  const known = new Map(Object.entries(domainDefaults));
  // A row written by hand wins over the default; an old folder name follows its rule.
  for (const [name, module = "", , note = ""] of rowsOf(
    block(current, "domains"),
  )) {
    const domain = domainNow(unquoted(name));
    if (domain) known.set(domain, [module, note]);
  }
  const present = new Map<string, string[]>();
  for (const [layer, folder] of Object.entries(layers))
    for (const file of after) {
      if (!file.startsWith(folder)) continue;
      const [domain, ...rest] = file.slice(folder.length).split("/");
      if (!domain || rest.length === 0) continue;
      const seen = present.get(domain) ?? [];
      if (!seen.includes(layer)) seen.push(layer);
      present.set(domain, seen);
    }
  const rows = [...present]
    .flatMap(([domain, where]) => {
      const entry = known.get(domain);
      return entry
        ? [
            {
              domain,
              module: entry[0],
              where: where.join(" · "),
              note: entry[1],
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        byModule(a.module, b.module) || a.domain.localeCompare(b.domain),
    );
  return [
    "| 도메인 폴더 | 모듈 | 있는 층 | 비고 |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${code(row.domain)} | ${row.module} | ${row.where} | ${row.note} |`,
    ),
    "",
  ].join("\n");
}

function packageTable(current: string): string {
  const known = new Map(Object.entries(packageDefaults));
  for (const [name, module = ""] of rowsOf(block(current, "packages")))
    known.set(unquoted(name), module);
  const rows = after
    .filter((file) => /^(apps|packages)\/(.+\/)?package\.json$/.test(file))
    .map((file) => dirname(file))
    .flatMap((directory) => {
      const module = known.get(directory);
      return module ? [{ directory, module }] : [];
    })
    .sort(
      (a, b) =>
        byModule(a.module, b.module) || a.directory.localeCompare(b.directory),
    );
  return [
    "| 패키지 | 모듈 |",
    "| --- | --- |",
    ...rows.map((row) => `| ${code(row.directory)} | ${row.module} |`),
    "",
  ].join("\n");
}

/** The map as first written; after that only its two tables are regenerated. */
const mapText = [
  "# 모듈 지도",
  "",
  "코드의 폴더, 패키지, 파일 이름에는 기능 이름만 씁니다. 코드명은 도메인 폴더를 묶는 이름이고, 저장소에서는 이 문서가 정합니다. 바깥(API, SDK, 화면, 문서 사이트, Slack, 모델이 읽는 글)에는 Werft만 나옵니다. 옛 프로젝트를 출처로 적은 주석, 변경 기록, migration, 시험 자료에는 옛 이름이 남아 있습니다.",
  "",
  `${code("tests/module-map.test.ts")}가 아래 두 표를 실제 패키지와 폴더에 맞춥니다. 패키지나 도메인 폴더를 더하거나 옮기는 PR은 같은 PR에서 이 표를 고칩니다.`,
  "",
  "## 모듈",
  "",
  "| 모듈 | 하는 일 |",
  "| --- | --- |",
  "| Werft | 제품 전체. 바깥에 내놓는 유일한 이름 |",
  "| Kiel | 세션을 격리해 돌리고, 제어하고, 한도·권한을 집행하고, 끊겨도 되살리는 실행 기반 |",
  "| Musterrolle | 누구인지 확인하고, 해도 되는지 판정하고, 그 판정을 기록 |",
  "| Kollegium | 에이전트가 무엇이고(정의), 어디서 불리고(채널), 언제 말하는지(대화) |",
  "| Takelage | 에이전트에 달 것(스킬, 원격 MCP 서버)을 들이고, 검사하고, 내주는 곳 |",
  "| Lotse | 세션과 세션 사이의 협업. 예정이고 아직 폴더가 없음 |",
  "",
  "표의 모듈 칸에는 위 이름 말고 셋을 더 씁니다.",
  "",
  "- 걸침: 두 모듈 이상의 책임이 한 곳에 있음",
  "- 미정: 소속을 아직 정하지 않음",
  "- 공용: 모든 도메인이 쓰는 것",
  "",
  "## 패키지",
  "",
  "<!-- packages:begin -->",
  "<!-- packages:end -->",
  "",
  `${["contracts", "platform", "db", "control-host"].map(code).join(", ")} 네 패키지는 모듈이 아니라 층(계약, 도메인, DB, 앱)입니다. 이 넷 안에서는 아래 도메인 폴더가 단위입니다.`,
  "",
  "## 도메인 폴더",
  "",
  `도메인 폴더는 네 층의 첫 폴더입니다: ${Object.values(layers)
    .map((folder) => code(folder.slice(0, -1)))
    .join(
      ", ",
    )}. 한 도메인의 폴더 이름은 모든 층에서 같습니다. 그 바로 아래에 놓인 파일은 공용입니다.`,
  "",
  "<!-- domains:begin -->",
  "<!-- domains:end -->",
  "",
  `## ${code("extensions")} 안`,
  "",
  `${code("extensions")} 바로 아래에는 다음 네 폴더와 진입점(${code("index.ts")}, ${code("ports/")})만 둡니다. 세 층(platform, db, route)이 같은 이름을 씁니다.`,
  "",
  "| 폴더 | 담는 것 |",
  "| --- | --- |",
  `| ${code("skills")} | 스킬 등록, 검토, Git 동기화 |`,
  `| ${code("bundles")} | 묶음 저장과 검사, 세션 시작 때 판 풀기 |`,
  `| ${code("mcp")} | workspace 원격 MCP 서버와 에이전트 지정 |`,
  `| ${code("builtin")} | 내장 werft MCP 서버와 그 안내 |`,
  "",
  `이름이 ${["skill-", "skills.", "extension-bundle", "workspace-mcp", "agent-workspace-mcp", "agent-mcp", "werft-mcp"].map(code).join(", ")}로 시작하는 파일은 세 층에서 ${code("extensions")} 아래, 그 이름의 폴더에만 둡니다. 실행 중 MCP 호출을 중계하는 파일(이름이 ${code("mcp-egress")}로 끝남)은 Kiel 몫이라 예외이고, platform에서는 ${code("workers/mcp-egress")}에 모읍니다.`,
  "",
].join("\n");

const currentMap = exists(mapFile) ? read(mapFile) : mapText;
let nextMap = currentMap;
for (const [name, table] of [
  ["packages", packageTable(currentMap)],
  ["domains", domainTable(currentMap)],
] as const)
  nextMap = nextMap.replace(
    new RegExp(`(<!-- ${name}:begin -->\\n)[\\s\\S]*?(<!-- ${name}:end -->)`),
    (_all, begin: string, end: string) => begin + table + end,
  );
const mapChanged = nextMap !== currentMap || !exists(mapFile);
if (mapChanged && !checkOnly) {
  mkdirSync(dirname(join(root, mapFile)), { recursive: true });
  writeFileSync(join(root, mapFile), nextMap);
}

// ------------------------------------------------------- 6. what is left

// Only where the rules had a say: a file they rewrote or one that sits where
// they move files to. An import that was already broken is not this run's.
const touched = new Set(rewritten);
const dangling: string[] = [];
if (!checkOnly)
  for (const file of scripts) {
    if (!touched.has(file) && oldPathsOf(file).length === 0) continue;
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteral(node) &&
        isModuleSpecifier(node) &&
        /^\.\.?\/.*\.(tsx?|json)$/.test(node.text) &&
        !exists(posix.normalize(posix.join(dirname(file), node.text)))
      )
        dangling.push(`${file}: ${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

console.log(
  [
    `${checkOnly ? "would move" : "moved"} ${moves.size} file(s)`,
    `${checkOnly ? "would rewrite" : "rewrote"} ${rewritten.length} file(s)`,
    `${mapFile}: ${mapChanged ? (checkOnly ? "would change" : "written") : "unchanged"}`,
  ].join(", "),
);
if (checkOnly && (moves.size > 0 || rewritten.length > 0 || mapChanged)) {
  for (const [from, to] of moves) console.log(`  mv ${from} -> ${to}`);
  for (const file of rewritten) console.log(`  rewrite ${file}`);
  process.exit(1);
}
if (twoReadings.length > 0) {
  console.error(
    `${twoReadings.length} import(s) read two ways and were left as written; check each by hand:\n${twoReadings.join("\n")}`,
  );
  process.exitCode = 1;
}
if (dangling.length > 0) {
  console.error(
    `${dangling.length} relative import(s) name a file that does not exist; fix by hand:\n${dangling.join("\n")}`,
  );
  process.exit(1);
}
