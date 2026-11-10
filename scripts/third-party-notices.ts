/**
 * THIRD_PARTY_NOTICES.md: the third-party components each deploy image
 * carries and their licenses.
 *
 *   bun scripts/third-party-notices.ts                  rewrite the file
 *   bun scripts/third-party-notices.ts --check          fail when it is stale
 *   bun scripts/third-party-notices.ts --verify <image> <app-dir>
 *                                                        fail when the image
 *     does not match its notices: a package under <app-dir>/node_modules not
 *     listed for it, a Bun or bundled Claude Code build other than the one
 *     named, a stale <app-dir>/DEBIAN_SOURCES.md; images.yml runs it inside
 *     each built image against /app
 *   bun scripts/third-party-notices.ts --debian-sources  print DEBIAN_SOURCES.md
 *     for the Debian system it runs on; each Dockerfile writes it into /app
 * after its last apt-get
 *
 * The package list is each image's production closure, read from bun.lock the
 * way its Dockerfile installs it: control-host with `--filter
 * ./apps/control-host`, worker with `--filter ./apps/worker`, egress-proxy
 * with none.
 * Optional dependencies count for linux on x64 and arm64, the two arches the
 * images are built for, so the list is the same on every machine that runs
 * this. License and NOTICE come from the installed package in node_modules;
 * a platform build this machine did not install (the other arch's binary)
 * takes its license from the npm registry when writing, and from the
 * committed file when checking, so `--check` needs no network.
 *
 * A license outside PERMISSIVE fails both modes unless REVIEWED names the
 * package, with that license, and the reason it may ship. That is the point
 * where a new copyleft or proprietary dependency gets a person's attention.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const IMAGES = [
  "control-host",
  "worker",
  "worker-codex",
  "egress-proxy",
] as const;
export type Image = (typeof IMAGES)[number];

/** The app directory (and Dockerfile) an image is built from. */
export function appOf(image: Image): string {
  return image === "worker-codex" ? "worker" : image;
}

/**
 * apps/worker/Dockerfile builds one image per engine (WORKER_RUNTIME), and the
 * lockfile records the registry as checked in (Claude). The Codex build swaps
 * the registry's engine dependency before it installs, so its closure is
 * computed with the same swap.
 */
const ENGINE_SWAP: Partial<
  Record<Image, { registry: string; from: string; to: string }>
> = {
  "worker-codex": {
    registry: "@werft-ai/runtime-registry",
    from: "@werft-ai/runtime-claude",
    to: "@werft-ai/runtime-codex",
  },
};

/**
 * Which workspaces each image's `bun install --production` starts from.
 * control-host also serves the web console bundle (apps/web/dist), which
 * inlines the runtime dependencies of packages/ui and packages/client; apps/web
 * lists those workspaces as devDependencies, so they are named here.
 */
const IMAGE_ROOTS: Record<Image, readonly string[]> = {
  "control-host": ["apps/control-host", "packages/ui", "packages/client"],
  worker: ["apps/worker"],
  "worker-codex": ["apps/worker"],
  "egress-proxy": [],
};

/**
 * Packages a Dockerfile deletes after its install, by name or a name prefix
 * ending in `*`: they are in the closure but not in the image.
 * tests/images.test.ts holds the worker build's removal (the Claude runtime's
 * image:verify) to this list.
 */
export const REMOVED_AFTER_INSTALL: Record<Image, readonly string[]> = {
  "control-host": [],
  worker: ["@anthropic-ai/claude-agent-sdk-linux-*-musl"],
  "worker-codex": [],
  "egress-proxy": [],
};

export function removedFrom(image: Image, name: string): boolean {
  return REMOVED_AFTER_INSTALL[image].some((pattern) => {
    const [head, tail] = pattern.split("*") as [string, string | undefined];
    return tail === undefined
      ? name === head
      : name.length >= head.length + tail.length &&
          name.startsWith(head) &&
          name.endsWith(tail);
  });
}

const TARGET_OS = "linux";
const TARGET_CPUS = ["x64", "arm64"];

/** SPDX ids that carry no obligation beyond keeping the license text. */
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Packages whose license is not in PERMISSIVE, each with the license that was
 * reviewed and why it may ship. Keyed by name, or by a name prefix ending in
 * `*` for a family of platform builds. A package whose license changes is
 * no longer covered: the new terms need their own review.
 */
export const REVIEWED: Record<string, { license: string; reason: string }> = {
  "@anthropic-ai/claude-agent-sdk": {
    license: "SEE LICENSE IN README.md",
    reason:
      'Anthropic 독점 소프트웨어다(패키지 LICENSE.md: © Anthropic PBC. All rights reserved). Anthropic Commercial Terms와 Claude Code를 제품에 싣는 조건을 따른다(위 "Claude Code 실행 파일" 절). worker 이미지에만 들어간다.',
  },
  "@anthropic-ai/claude-agent-sdk-linux-*": {
    license: "SEE LICENSE IN LICENSE.md",
    reason:
      "위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.",
  },
};

/**
 * The Bun build the notices describe, per Bun version the Dockerfiles pin,
 * read from the oven-sh/bun tag: the commit `Bun.revision` reports, and the
 * LGPL-2.1 libraries it links statically, WebKit (WEBKIT_VERSION) and TinyCC
 * (TINYCC_COMMIT), both in scripts/build/deps/ since 1.3.14 (cmake/ before).
 * A Bun bump fails until its entry is added, so the source the notices point
 * to is always the source shipped.
 */
export const BUN_BUILDS: Record<
  string,
  { revision: string; webkit: string; tinycc: string }
> = {
  "1.3.14": {
    revision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    webkit: "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    tinycc: "12882eee073cfe5c7621bcfadf679e1372d4537b",
  },
};

/**
 * The Bun runtime compiled into the Claude Code executable each Agent SDK
 * version bundles: the `Bun v<version>` string in the binary. It carries its
 * own statically linked JavaScriptCore, so an SDK bump fails until the new
 * pair is read and added.
 */
export const CLAUDE_CODE_BUN: Record<string, string> = {
  "0.3.319": "1.4.4",
};

const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

export type BaseImage = { bun: string; digest: string };

/** The upstream Git LFS release the worker Dockerfile builds from source. */
export const GIT_LFS_VERSION = "3.8.1";
/** The golang.org/x/net that build moves Git LFS to. */
export const GIT_LFS_X_NET = "0.62.0";
/** The github.com/klauspost/compress that build moves Git LFS to. */
export const GIT_LFS_COMPRESS = "1.20.2";
/** The Go toolchain that build uses. */
export const GIT_LFS_GO = "1.27.3";
/** The upstream GitHub CLI release binary the worker Dockerfile installs. */
export const GH_VERSION = "2.103.3";

/** The `oven/bun:<version>@<digest>` every app Dockerfile builds on. */
export function baseImageOf(dockerfile: string): BaseImage {
  const match = dockerfile.match(
    /^ARG BUN_IMAGE=oven\/bun:([^@\s]+)@(sha256:[0-9a-f]{64})$/m,
  );
  if (!match) throw new Error("no ARG BUN_IMAGE=oven/bun:<version>@<digest>");
  return { bun: match[1] as string, digest: match[2] as string };
}

export type LockPackage = {
  key: string;
  name: string;
  version: string;
  optional: boolean;
};

type LockEntry = [
  string,
  string?,
  {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalPeers?: string[];
    os?: string | string[];
    cpu?: string | string[];
  }?,
  string?,
];

type Workspace = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type Lockfile = {
  workspaces: Record<string, Workspace>;
  packages: Record<string, LockEntry>;
};

export function parseLockfile(text: string): Lockfile {
  return Bun.JSONC.parse(text) as Lockfile;
}

/** `@scope/a/b/@scope/c` → [`@scope/a`, `b`, `@scope/c`]. */
function keyPath(key: string): string[] {
  const parts = key.split("/");
  const path: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    path.push(part.startsWith("@") ? `${part}/${parts[++i]}` : part);
  }
  return path;
}

function matches(
  constraint: string | string[] | undefined,
  targets: readonly string[],
): boolean {
  if (constraint === undefined) return true;
  const list = Array.isArray(constraint) ? constraint : [constraint];
  const negated = list.filter((entry) => entry.startsWith("!"));
  if (negated.length === list.length) {
    return targets.some((target) => !negated.includes(`!${target}`));
  }
  return targets.some((target) => list.includes(target));
}

/**
 * The npm packages `bun install --production` puts in an image, keyed by
 * lockfile key. Workspace packages are followed but not returned: they are
 * this repository's own code.
 */
export function imageClosure(
  lock: Lockfile,
  image: Image,
): Map<string, LockPackage> {
  const roots = IMAGE_ROOTS[image];
  const workspaceByName = new Map(
    Object.entries(lock.workspaces).map(([path, workspace]) => [
      workspace.name,
      path,
    ]),
  );
  const found = new Map<string, LockPackage>();
  const seenWorkspaces = new Set<string>();

  const resolve = (from: string[], name: string): string | undefined => {
    for (let depth = from.length; depth >= 0; depth -= 1) {
      const key = [...from.slice(0, depth), name].join("/");
      if (lock.packages[key] !== undefined) return key;
    }
    return undefined;
  };

  const visitWorkspace = (path: string) => {
    if (seenWorkspaces.has(path)) return;
    seenWorkspaces.add(path);
    const workspace = lock.workspaces[path];
    if (workspace === undefined) throw new Error(`no workspace ${path}`);
    const from = path === "" ? [] : [workspace.name];
    const swap = ENGINE_SWAP[image];
    const source =
      swap !== undefined && workspace.name === swap.registry
        ? {
            ...workspace,
            dependencies: Object.fromEntries(
              Object.entries(workspace.dependencies ?? {}).map(
                ([name, range]) =>
                  name === swap.from ? [swap.to, range] : [name, range],
              ),
            ),
          }
        : workspace;
    for (const [name, optional] of dependencyNames(source, [])) {
      visitDependency(from, name, optional);
    }
  };

  const visitDependency = (from: string[], name: string, optional: boolean) => {
    const workspacePath = workspaceByName.get(name);
    if (workspacePath !== undefined) {
      visitWorkspace(workspacePath);
      return;
    }
    const key = resolve(from, name);
    if (key === undefined) {
      // An optional dependency for a platform no one targets, or an optional
      // peer, is legitimately absent; anything else is a lockfile we misread.
      if (optional) return;
      throw new Error(
        `${name} (needed by ${from.join("/") || "root"}) is not in bun.lock`,
      );
    }
    const entry = lock.packages[key] as LockEntry;
    const meta = entry[2] ?? {};
    if (!matches(meta.os, [TARGET_OS]) || !matches(meta.cpu, TARGET_CPUS)) {
      return;
    }
    const existing = found.get(key);
    if (existing !== undefined) {
      if (existing.optional && !optional) existing.optional = false;
      return;
    }
    const id = entry[0];
    const at = id.lastIndexOf("@");
    found.set(key, {
      key,
      name: id.slice(0, at),
      version: id.slice(at + 1),
      optional,
    });
    for (const [child, childOptional] of dependencyNames(
      meta,
      meta.optionalPeers ?? [],
    )) {
      visitDependency(keyPath(key), child, optional || childOptional);
    }
  };

  for (const path of roots) {
    if (lock.workspaces[path] === undefined) {
      throw new Error(`no workspace ${path} in bun.lock`);
    }
    visitWorkspace(path);
  }
  return found;
}

/** Name and whether it may be missing, for every production edge. */
function dependencyNames(
  source: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
  optionalPeers: readonly string[],
): Array<[string, boolean]> {
  return [
    ...Object.keys(source.dependencies ?? {}).map(
      (name) => [name, false] as [string, boolean],
    ),
    ...Object.keys(source.optionalDependencies ?? {}).map(
      (name) => [name, true] as [string, boolean],
    ),
    // Bun installs peers; an optional one only if something else asks.
    ...Object.keys(source.peerDependencies ?? {}).map(
      (name) => [name, optionalPeers.includes(name)] as [string, boolean],
    ),
  ];
}

/** Whether an SPDX expression can be satisfied with PERMISSIVE ids alone. */
export function isPermissive(expression: string): boolean {
  // SPDX precedence: parentheses, then AND, then OR. Anything that does not
  // parse as an expression ("SEE LICENSE IN ...") is not permissive.
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const either = (): boolean => {
    let value = both();
    while (tokens[at] === "OR") {
      at += 1;
      const right = both();
      value = value || right;
    }
    return value;
  };
  const both = (): boolean => {
    let value = single();
    while (tokens[at] === "AND") {
      at += 1;
      const right = single();
      value = value && right;
    }
    return value;
  };
  const single = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const value = either();
      if (tokens[at++] !== ")") throw new SyntaxError(expression);
      return value;
    }
    if (token === undefined || [")", "AND", "OR", "WITH"].includes(token)) {
      throw new SyntaxError(expression);
    }
    // An exception changes the terms; that is a person's call.
    if (tokens[at] === "WITH") {
      at += 2;
      return false;
    }
    return PERMISSIVE.has(token);
  };
  try {
    const value = either();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}

export function reviewFor(name: string, license: string): string | undefined {
  const review =
    REVIEWED[name] ??
    Object.entries(REVIEWED).find(
      ([pattern]) =>
        pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)),
    )?.[1];
  return review?.license === license ? review.reason : undefined;
}

export type PackageInfo = {
  license: string;
  /** Verbatim NOTICE files the package ships, which Apache-2.0 §4(d) says to pass on. */
  notices: string[];
  /**
   * Set only when the package ships no license file of its own: the
   * copyright holder its package.json names, for the text the notices carry
   * in its place.
   */
  holder?: string;
};

export type Row = {
  name: string;
  version: string;
  license: string;
  images: Image[];
  notices: string[];
  holder?: string;
};

/** LICENSE, LICENSE.md, LICENSE-MIT, LICENCE, COPYING, ... */
export function isLicenseFile(file: string): boolean {
  return /^(licen[cs]e|copying)([.-].*)?$/i.test(file);
}

/**
 * The licenses whose text the notices carry for a package without its own
 * license file: MIT in full (with the package's holder), Apache-2.0 by the
 * copy Debian's base-files puts in every image. Any other license without a
 * file fails, so its text is added before it ships.
 */
const CARRIED_TEXTS = new Set(["MIT", "Apache-2.0"]);

/** Who package.json says holds the copyright, and where the package lives. */
export function holderOf(manifest: {
  author?: unknown;
  repository?: unknown;
}): string {
  const { author, repository } = manifest;
  // The name only: a maintainer's address is not ours to republish.
  const name =
    typeof author === "string"
      ? author.replace(/\s*[<(].*$/, "").trim()
      : typeof (author as { name?: unknown })?.name === "string"
        ? (author as { name: string }).name
        : "";
  const url =
    typeof repository === "string"
      ? repository
      : typeof (repository as { url?: unknown })?.url === "string"
        ? (repository as { url: string }).url
        : "";
  return [name || "저작자 표기 없음", url.replace(/^git\+/, "")]
    .filter(Boolean)
    .join(", ");
}

export function licenseOf(manifest: {
  license?: unknown;
  licenses?: unknown;
}): string {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license && typeof (license as { type?: unknown }).type === "string") {
    return (license as { type: string }).type;
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (entry as { type?: unknown }).type)
      .filter((type): type is string => typeof type === "string");
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNKNOWN";
}

/** Reads what the installed copy under node_modules says, if one is there. */
export function readInstalled(
  root: string,
  pkg: LockPackage,
): PackageInfo | undefined {
  const dir = join(
    root,
    "node_modules",
    ...keyPath(pkg.key).join("/node_modules/").split("/"),
  );
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `${pkg.key}: node_modules has ${manifest.version}, bun.lock ${pkg.version}; run bun install --frozen-lockfile`,
    );
  }
  const files = readdirSync(dir);
  const notices = files
    .filter((file) => /^notice(\.(md|txt))?$/i.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8").trim());
  return {
    license: licenseOf(manifest),
    notices,
    ...(files.some(isLicenseFile) ? {} : { holder: holderOf(manifest) }),
  };
}

async function fetchRegistry(pkg: LockPackage): Promise<PackageInfo> {
  const response = await fetch(
    `https://registry.npmjs.org/${pkg.name}/${pkg.version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    throw new Error(
      `${pkg.name}@${pkg.version}: registry answered ${response.status}`,
    );
  }
  const license = licenseOf(await response.json());
  // The manifest does not list files, so neither a NOTICE nor a missing
  // license file can be seen from here. A package that names its own license
  // file is taken at its word.
  if (license.includes("Apache") || !/^SEE LICENSE IN \S+$/.test(license)) {
    throw new Error(
      `${pkg.name}@${pkg.version} is ${license} and not installed here; generate on a machine that installs it so its files are read`,
    );
  }
  return { license, notices: [] };
}

export function problemsOf(rows: readonly Row[], base: BaseImage): string[] {
  return [
    ...pinProblems(rows, base),
    ...rows
      .filter(
        (row) =>
          !isPermissive(row.license) && !reviewFor(row.name, row.license),
      )
      .map(
        (row) =>
          `${row.name}@${row.version} is ${row.license}: not in PERMISSIVE and not REVIEWED in scripts/third-party-notices.ts`,
      ),
    ...rows
      .filter(
        (row) => row.holder !== undefined && !CARRIED_TEXTS.has(row.license),
      )
      .map(
        (row) =>
          `${row.name}@${row.version} ships no license file and the notices carry no ${row.license} text; add it to CARRIED_TEXTS and render in scripts/third-party-notices.ts`,
      ),
  ];
}

const UNREVIEWED = "(검토 전)";

/** The pins problemsOf asks for; render writes UNREVIEWED where one is missing. */
function pinProblems(rows: readonly Row[], base: BaseImage): string[] {
  const problems: string[] = [];
  if (BUN_BUILDS[base.bun] === undefined) {
    problems.push(
      `Bun ${base.bun} (the Dockerfiles' BUN_IMAGE) has no BUN_BUILDS entry in scripts/third-party-notices.ts`,
    );
  }
  for (const row of rows.filter((row) => row.name === AGENT_SDK)) {
    if (CLAUDE_CODE_BUN[row.version] === undefined) {
      problems.push(
        `${AGENT_SDK}@${row.version} has no CLAUDE_CODE_BUN entry in scripts/third-party-notices.ts`,
      );
    }
  }
  return problems;
}

function baseSection(rows: readonly Row[], base: BaseImage): string {
  const build = BUN_BUILDS[base.bun];
  const tag = `bun-v${base.bun}`;
  const sdk = rows.find((row) => row.name === AGENT_SDK);
  const lines = [
    "## 베이스 이미지와 OS 패키지",
    "",
    `세 이미지 모두 \`oven/bun:${base.bun}@${base.digest}\`(Dockerfile의 \`BUN_IMAGE\`) 위에 만든다. 이 베이스는 Debian 13(trixie) slim이다. 빌드할 때 \`apt-get upgrade\`로 Debian 보안 수정을 올리므로 이미지의 Debian 패키지 버전은 베이스 digest의 것보다 새로울 수 있다.`,
    "",
    `### Bun ${base.bun} (\`/usr/local/bin/bun\`)`,
    "",
    `- **라이선스.** Bun 자체는 MIT다. 함께 링크된 라이브러리와 각각의 라이선스는 https://github.com/oven-sh/bun/blob/${tag}/LICENSE.md 에 있다. 이미지에는 Oven이 배포한 실행 파일이 수정 없이 들어 있다.`,
    `- **빌드.** oven-sh/bun commit \`${build?.revision ?? UNREVIEWED}\`(\`bun --revision\`)이다. images.yml이 빌드한 이미지(linux/amd64, linux/arm64)마다 이 값을 확인한다.`,
    "- **LGPL-2.1 구성요소.** Bun은 아래 라이브러리를 정적으로 링크한다. LGPL-2.1 전문은 이미지 안 `/usr/share/common-licenses/LGPL-2.1`에 있다.",
    `  - JavaScriptCore·WebCore(WebKit): https://github.com/oven-sh/WebKit/tree/${build?.webkit ?? UNREVIEWED}`,
    `  - TinyCC: https://github.com/oven-sh/tinycc/tree/${build?.tinycc ?? UNREVIEWED}`,
    `- **대응 소스와 재링크.** 이 실행 파일 전체의 소스는 https://github.com/oven-sh/bun/tree/${tag} 이다. 위 라이브러리를 고쳐 Bun을 다시 링크하는 절차는 https://github.com/oven-sh/bun/blob/${tag}/CONTRIBUTING.md 의 "Building WebKit locally"다. WebKit을 위 commit으로 받아 \`bun run build:local\`로 빌드한다. LICENSE.md에 적힌 \`make jsc\`·\`zig build\`는 옛 절차다.`,
    "",
    "### Debian 패키지와 대응 소스",
    "",
    "- **라이선스.** 각 패키지의 저작권 표시와 라이선스 조건은 이미지 안 `/usr/share/doc/<패키지>/copyright`에 있다. GPL·LGPL·Apache-2.0처럼 여러 패키지가 쓰는 라이선스는 이 파일이 전문 대신 `/usr/share/common-licenses/`의 사본을 가리킨다. images.yml이 빌드한 이미지마다 설치된 모든 패키지에 copyright 파일이 있는지 확인한다.",
    "- **대응 소스.** 이미지마다 `/app/DEBIAN_SOURCES.md`가 설치된 모든 Debian 패키지의 source package 이름과 정확한 버전, 그 소스가 보관된 https://snapshot.debian.org/ 주소를 적는다. GPL·LGPL 패키지도 모두 여기에 들어 있다. 이 목록은 빌드할 때 그 이미지의 dpkg 데이터베이스에서 만든다(`bun scripts/third-party-notices.ts --debian-sources`). images.yml은 빌드한 이미지마다 목록이 실제 설치 상태와 같은지 확인하고, 게시할 때 snapshot.debian.org가 각 소스를 실제로 갖고 있는지 확인한다. 없다고 답한 소스가 있으면 게시하지 않는다. 답을 받지 못한 소스는 main 게시에서 경고로 남고, 릴리스(tag)에서는 게시를 막는다. `apt-get upgrade` 때문에 빌드마다 버전이 달라질 수 있어, 목록은 저장소가 아니라 이미지에 둔다.",
    "- **Dockerfile이 추가로 설치하는 Debian 패키지.** control-host는 ca-certificates(MPL-2.0·GPL-2.0+)·git(GPL-2.0)·tini(MIT), worker는 ca-certificates·git·tini·xfsprogs(GPL-2.0·LGPL-2.1)다. egress-proxy는 추가 패키지가 없다.",
    "",
    `### Git LFS ${GIT_LFS_VERSION} (worker, \`/usr/local/bin/git-lfs\`)`,
    "",
    `- **라이선스.** Git LFS 자체는 MIT다. 저작권 표시와 허가문 전문은 이미지 안 \`/usr/local/share/doc/git-lfs/LICENSE.md\`(https://github.com/git-lfs/git-lfs/blob/v${GIT_LFS_VERSION}/LICENSE.md)에 있다. 이미지의 실행 파일은 worker Dockerfile이 git-lfs 프로젝트의 v${GIT_LFS_VERSION} 소스 릴리스(sha256 고정)에서 Go ${GIT_LFS_GO}로 직접 빌드한 것이다. git-lfs 소스는 고치지 않았다. 바꾼 것은 의존 모듈 버전뿐이다: \`golang.org/x/net\`을 v${GIT_LFS_X_NET}으로, \`github.com/klauspost/compress\`를 v${GIT_LFS_COMPRESS}로 올렸고, 그에 따라 \`golang.org/x/crypto\`·\`x/sync\`·\`x/sys\`·\`x/text\`도 올라갔다(빌드가 go.mod·go.sum을 sha256으로 확인한다).`,
    `- **정적으로 링크된 Go 코드.** 이 실행 파일은 Go 표준 라이브러리를 링크한다. 그 BSD-3-Clause 문구도 같은 LICENSE.md에 있다. https://github.com/git-lfs/git-lfs/blob/v${GIT_LFS_VERSION}/go.mod 에 적힌 모듈(위에서 올린 버전 포함)도 링크하며, 각 모듈의 라이선스는 그 모듈의 소스에 있다. 링크한 모듈과 버전은 실행 파일에 기록되어 있어, 이미지 밖의 Go로 \`go version -m <실행 파일>\`을 실행하면 보인다.`,
    `- **대응 소스.** https://github.com/git-lfs/git-lfs/tree/v${GIT_LFS_VERSION} 와 apps/worker/Dockerfile의 \`git-lfs\` stage(모듈 버전 변경)`,
    "",
    `### GitHub CLI ${GH_VERSION} (worker, \`/usr/local/bin/gh\`)`,
    "",
    `- **라이선스.** GitHub CLI는 MIT다. 저작권 표시와 허가문 전문은 이미지 안 \`/usr/local/share/doc/gh/LICENSE\`(https://github.com/cli/cli/blob/v${GH_VERSION}/LICENSE)에 있다. 이미지의 실행 파일은 cli/cli 프로젝트가 배포한 v${GH_VERSION} linux 릴리스 바이너리(sha256 고정)를 수정 없이 넣은 것이다.`,
    `- **정적으로 링크된 Go 코드.** 이 실행 파일은 Go 표준 라이브러리와 https://github.com/cli/cli/blob/v${GH_VERSION}/go.mod 에 적힌 모듈을 링크한다. 각 모듈의 라이선스는 그 모듈의 소스에 있다. 링크한 모듈과 버전은 실행 파일에 기록되어 있어, 이미지 밖의 Go로 \`go version -m <실행 파일>\`을 실행하면 보인다.`,
    `- **소스.** https://github.com/cli/cli/tree/v${GH_VERSION}`,
  ];
  if (sdk !== undefined) {
    const embedded = CLAUDE_CODE_BUN[sdk.version] ?? UNREVIEWED;
    lines.push(
      "",
      "### Claude Code 실행 파일 (worker)",
      "",
      `- **권리와 조건.** \`${AGENT_SDK}@${sdk.version}\`과 그 플랫폼 빌드가 싣는 \`claude\` 실행 파일은 오픈소스가 아니다. © Anthropic PBC. All rights reserved. 이용 조건은 Anthropic Commercial Terms of Service(https://www.anthropic.com/legal/commercial-terms)와 Claude Code 법률 고지(https://code.claude.com/docs/en/legal-and-compliance)를 따른다.`,
      "- **싣는 방식.** Anthropic이 npm에 게시한 실행 파일을 수정하지 않고 그대로 싣는다. musl 빌드만 이미지에서 뺀다.",
      `- **내장 런타임.** 이 실행 파일은 Bun ${embedded} 런타임을 내장한다. 따라서 JavaScriptCore(LGPL-2.1)도 정적으로 링크되어 있다. images.yml이 worker 이미지(linux/amd64, linux/arm64)마다 실행 파일 안의 \`Bun v<버전>\` 표시로 이 버전을 확인한다.`,
    );
  }
  const codex = rows.find((row) => row.name === "@openai/codex");
  if (codex !== undefined) {
    lines.push(
      "",
      "### Codex 실행 파일 (worker-codex)",
      "",
      `- **라이선스.** \`@openai/codex@${codex.version}\`과 그 플랫폼 빌드(\`linux-x64\`, \`linux-arm64\`)는 Apache-2.0이다. 패키지가 싣는 LICENSE·NOTICE는 이미지 안 \`/app/node_modules/@openai/\` 아래에 함께 들어 있다.`,
      "- **싣는 방식.** OpenAI가 npm에 게시한 실행 파일을 수정하지 않고 그대로 싣는다. `WORKER_RUNTIME=codex_app_server`로 빌드한 worker 이미지에만 들어가며, 버전은 정확히 고정되어 빌드 로그에 `codex-cli <버전>`으로 찍힌다.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function render(rows: readonly Row[], base: BaseImage): string {
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const flagged = rows.filter((row) => !isPermissive(row.license));
  const withNotices = rows.filter((row) => row.notices.length > 0);
  const bare = rows.filter((row) => row.holder !== undefined);
  const lines = [
    "# 제3자 구성요소 고지",
    "",
    '배포 이미지(control-host·worker·egress-proxy)에 들어가는 제3자 구성요소와 그 라이선스다. npm 패키지의 라이선스 전문은 패키지가 싣고 있으면 이미지 안 `/app/node_modules/<패키지>/`에 함께 들어 있다. 싣지 않은 패키지는 아래 "라이선스 파일이 없는 npm 패키지" 절이 전문을 대신 싣는다.',
    "",
    "이 파일은 `bun scripts/third-party-notices.ts`가 `bun.lock`에서 만든다. 손으로 고치지 않는다. CI의 `check (static)`이 `--check`로 최신인지 확인한다.",
    "",
    baseSection(rows, base),
    "## 배포 조건이 붙은 구성요소",
    "",
    "허용 목록(MIT·Apache-2.0·BSD 계열·ISC 등) 밖의 라이선스다. 각각 스크립트의 `REVIEWED`에 검토 사유가 있다.",
    "",
    ...(flagged.length === 0
      ? ["없음."]
      : flagged.map(
          (row) =>
            `- \`${row.name}@${row.version}\` (${row.license}): ${reviewFor(row.name, row.license)}`,
        )),
    "",
    'Apache-2.0 패키지가 NOTICE 파일을 싣고 있으면 그 전문을 아래 "NOTICE 전문"에 옮긴다.',
    "",
    "## npm 패키지 (production closure)",
    "",
    "| 패키지 | 버전 | 라이선스 | 이미지 |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${cell(row.name)} | ${cell(row.version)} | ${cell(row.license)} | ${row.images.join(", ")} |`,
    ),
    "",
    BARE_HEADING,
    "",
    ...(bare.length === 0
      ? ["없음.", ""]
      : [
          "아래 패키지는 배포본에 라이선스 파일도 저작권 표시도 싣지 않는다. package.json이 밝힌 라이선스와 author(저작자 표기)·저장소를 적고, 라이선스 전문은 이 절에 대신 싣는다. author는 package.json의 표기일 뿐 확인된 저작권자가 아니다. 실제 저작권 표시는 각 저장소에서 확인해야 한다. images.yml은 이미지의 `/app/node_modules`에서 라이선스 파일이 없는 패키지가 모두 여기에 있는지 확인한다.",
          "",
          ...bare.map(
            (row) =>
              `- \`${row.name}@${row.version}\` (${row.license}): ${row.holder}`,
          ),
          "",
          "### MIT 전문",
          "",
          '위 MIT 패키지의 허락 조건이다. "<저작권자>"는 각 패키지의 저작권자이며, 위 목록의 author는 그 표기다.',
          "",
          "```text",
          MIT_TEXT,
          "```",
          "",
          "### Apache-2.0 전문",
          "",
          "이미지 안 `/usr/share/common-licenses/Apache-2.0`에 있다(Debian base-files). https://www.apache.org/licenses/LICENSE-2.0 과 같은 글이다.",
          "",
        ]),
    "## NOTICE 전문",
    "",
    ...(withNotices.length === 0
      ? ["없음.", ""]
      : withNotices.flatMap((row) => [
          `### ${row.name}@${row.version}`,
          "",
          "```text",
          ...row.notices.flatMap((notice, index) =>
            index === 0 ? [notice] : ["", notice],
          ),
          "```",
          "",
        ])),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

const BARE_HEADING = "## 라이선스 파일이 없는 npm 패키지";

const MIT_TEXT = `MIT License

Copyright (c) <저작권자>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The rows of a file `render` wrote, keyed by name@version. */
export function parseRows(markdown: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  const holders = new Map<string, string>();
  let section = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) section = line;
    if (section === BARE_HEADING) {
      const bare = line.match(/^- `(.+)` \(.+?\): (.+)$/);
      if (bare) holders.set(bare[1] as string, bare[2] as string);
      continue;
    }
    const match = line.match(/^\| (.+?) \| (\S+) \| (.+?) \| ([a-z, -]+) \|$/);
    if (!match || match[1] === "패키지") continue;
    const [, name, version, license, images] = match as unknown as string[];
    rows.set(`${name}@${version}`, {
      name: name as string,
      version: version as string,
      license: (license as string).replaceAll("\\|", "|"),
      images: (images as string).split(", ") as Image[],
      notices: [],
    });
  }
  for (const [id, holder] of holders) {
    const row = rows.get(id);
    if (row !== undefined) row.holder = holder;
  }
  return rows;
}

export async function collectRows(
  root: string,
  fallback: (pkg: LockPackage) => Promise<PackageInfo>,
): Promise<Row[]> {
  const lock = parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
  const byId = new Map<string, Row>();
  for (const image of IMAGES) {
    for (const pkg of imageClosure(lock, image).values()) {
      if (removedFrom(image, pkg.name)) continue;
      const id = `${pkg.name}@${pkg.version}`;
      const known = byId.get(id);
      if (known !== undefined) {
        if (!known.images.includes(image)) known.images.push(image);
        continue;
      }
      const info = readInstalled(root, pkg) ?? (await fallback(pkg));
      byId.set(id, {
        name: pkg.name,
        version: pkg.version,
        ...info,
        images: [image],
      });
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name < b.name
        ? -1
        : 1,
  );
}

const OUTPUT = "THIRD_PARTY_NOTICES.md";

/**
 * Every name@version installed under a node_modules tree, nested ones
 * included, with the directory of each copy. Workspace links are this
 * repository's own code and skipped.
 */
export function installedPackages(nodeModules: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const candidates = entry.startsWith("@")
        ? readdirSync(join(dir, entry)).map((child) => join(dir, entry, child))
        : [join(dir, entry)];
      for (const candidate of candidates) {
        if (lstatSync(candidate).isSymbolicLink()) continue;
        const manifestPath = join(candidate, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const id = `${manifest.name}@${manifest.version}`;
        found.set(id, [...(found.get(id) ?? []), candidate]);
        walk(join(candidate, "node_modules"));
      }
    }
  };
  walk(nodeModules);
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const DPKG_STATUS = "/var/lib/dpkg/status";
const DEBIAN_SOURCES = "DEBIAN_SOURCES.md";
/** The license texts the notices point to, from Debian's base-files. */
const COMMON_LICENSES = [
  "/usr/share/common-licenses/Apache-2.0",
  "/usr/share/common-licenses/GPL-2",
  "/usr/share/common-licenses/GPL-3",
  "/usr/share/common-licenses/LGPL-2.1",
];
const CLAUDE_EXECUTABLE = "/usr/local/bin/claude";

export type DebianPackage = {
  name: string;
  version: string;
  source: string;
  sourceVersion: string;
  /** Other sources compiled into the package (Debian Policy §7.8). */
  builtUsing: Array<{ source: string; version: string }>;
};

/**
 * The installed packages of a dpkg status file, each with the source package
 * and version it was built from. Without a Source field the source is the
 * package itself; without a version in it (no binNMU), the same version.
 * Built-Using names the sources of code statically incorporated from other
 * packages, which are part of the corresponding source too.
 */
export function parseDpkgStatus(status: string): DebianPackage[] {
  const packages: DebianPackage[] = [];
  for (const stanza of status.split(/\n{2,}/)) {
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (match) fields.set(match[1] as string, match[2] as string);
    }
    if (!fields.get("Status")?.endsWith(" installed")) continue;
    const name = fields.get("Package");
    const version = fields.get("Version");
    if (!name || !version) {
      throw new Error(
        `dpkg status stanza without Package or Version: ${stanza}`,
      );
    }
    const source = fields.get("Source")?.match(/^(\S+)(?: \((\S+)\))?$/);
    const builtUsing = [
      ...(fields.get("Built-Using") ?? "").matchAll(/(\S+) \(= ([^)\s]+)\)/g),
    ].map((match) => ({
      source: match[1] as string,
      version: match[2] as string,
    }));
    packages.push({
      name,
      version,
      source: source?.[1] ?? name,
      sourceVersion: source?.[2] ?? version,
      builtUsing,
    });
  }
  return packages;
}

export function snapshotUrl(source: string, version: string): string {
  return `https://snapshot.debian.org/package/${encodeURIComponent(source)}/${encodeURIComponent(version)}/`;
}

/** Whether a copyright file names a GPL-family license (GPL, LGPL, AGPL). */
export function mentionsGpl(copyright: string): boolean {
  return /GPL|General Public License/.test(copyright);
}

/**
 * DEBIAN_SOURCES.md: the corresponding source of every Debian package in an
 * image, one row per source package and version.
 */
export function renderDebianSources(
  packages: readonly DebianPackage[],
  gpl: (pkg: DebianPackage) => boolean,
): string {
  const bySource = new Map<
    string,
    { source: string; version: string; binaries: string[]; gpl: boolean }
  >();
  const add = (
    source: string,
    version: string,
    binary: string,
    isGpl: boolean,
  ) => {
    const key = `${source} ${version}`;
    const entry = bySource.get(key) ?? {
      source,
      version,
      binaries: [],
      gpl: false,
    };
    entry.binaries.push(binary);
    entry.gpl ||= isGpl;
    bySource.set(key, entry);
  };
  for (const pkg of packages) {
    add(pkg.source, pkg.sourceVersion, pkg.name, gpl(pkg));
    for (const used of pkg.builtUsing) {
      add(used.source, used.version, `${pkg.name} (Built-Using)`, false);
    }
  }
  const entries = [...bySource.values()].sort((a, b) =>
    a.source === b.source
      ? a.version.localeCompare(b.version)
      : a.source < b.source
        ? -1
        : 1,
  );
  return `${[
    "# Debian 패키지의 대응 소스",
    "",
    '이 이미지에 설치된 Debian 패키지가 어느 source package의 어느 버전에서 빌드됐는지 적는다. 다른 source package의 코드를 정적으로 넣은 패키지는 그 소스도 "(Built-Using)"으로 적는다. 각 소스는 "소스" 열의 snapshot.debian.org 주소에서 받을 수 있다. 이 파일은 이미지를 빌드할 때 그 이미지의 dpkg 데이터베이스(`/var/lib/dpkg/status`)에서 `bun scripts/third-party-notices.ts --debian-sources`로 만든다. 제3자 구성요소 전체의 고지는 같은 디렉터리의 `THIRD_PARTY_NOTICES.md`에 있다.',
    "",
    '"GPL" 열은 바이너리 패키지의 `/usr/share/doc/<패키지>/copyright`가 GPL 계열(GPL·LGPL·AGPL)을 언급하는지다. 라이선스 판정이 아니라 찾아보기용 표시다.',
    "",
    `source package ${entries.length}개, 바이너리 패키지 ${packages.length}개.`,
    "",
    "| source package | 버전 | 바이너리 패키지 | GPL | 소스 |",
    "|---|---|---|---|---|",
    ...entries.map(
      (entry) =>
        `| ${entry.source} | ${entry.version} | ${entry.binaries.sort().join(", ")} | ${entry.gpl ? "예" : ""} | ${snapshotUrl(entry.source, entry.version)} |`,
    ),
  ].join("\n")}\n`;
}

/** The source package and version of every row of a DEBIAN_SOURCES.md. */
export function parseDebianSources(
  markdown: string,
): Array<{ source: string; version: string }> {
  return markdown
    .split("\n")
    .map((line) => line.match(/^\| (\S+) \| (\S+) \| .* \| https:\/\/snapshot/))
    .filter((match) => match !== null)
    .map((match) => ({
      source: match[1] as string,
      version: match[2] as string,
    }));
}

type SnapshotAnswer = "held" | "missing" | "unreachable";

const SNAPSHOT_REQUEST_MS = 30_000;
const SNAPSHOT_ROUND_PAUSE_MS = [15_000, 30_000, 60_000];
// One "no" can come from a service mid-outage; a release fails on it.
const SNAPSHOT_DENIALS_TO_BELIEVE = 2;

/**
 * How snapshot.debian.org answered, by HTTP status or failure kind ("timeout",
 * "error", "not-json"). Printed after a check so a log tells the service
 * shedding load (503, 504, 429) from this side failing to connect.
 */
export const snapshotResponses = new Map<string, number>();

function tally(kind: string): void {
  snapshotResponses.set(kind, (snapshotResponses.get(kind) ?? 0) + 1);
}

/**
 * Whether snapshot.debian.org holds a source package version, by its
 * machine-readable srcfiles listing: 404 or an empty listing says no, anything
 * else that is not a listing is no answer.
 */
export async function snapshotHolds(
  source: string,
  version: string,
  timeoutMs: number,
): Promise<SnapshotAnswer> {
  const url = `https://snapshot.debian.org/mr/package/${encodeURIComponent(source)}/${encodeURIComponent(version)}/srcfiles`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    tally(String(response.status));
    if (response.status === 404) return "missing";
    if (response.ok) {
      // Only a body that is not JSON is "not-json"; a timeout or reset while
      // reading it must still reach the outer catch.
      const body = (await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      })) as { result?: unknown } | undefined;
      if (Array.isArray(body?.result)) {
        return body.result.length > 0 ? "held" : "missing";
      }
      tally("not-json");
    }
  } catch (error) {
    tally(
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "error",
    );
    // No answer; the next round asks again.
  }
  return "unreachable";
}

const heldKey = (entry: { source: string; version: string }) =>
  `${entry.source} ${entry.version}`;

/** The "<source> <version>" lines of earlier attempts' held files, as a set. */
export function parseHeld(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\S+ \S+$/.test(line)),
  );
}

/**
 * Asks only for what no earlier attempt of this run found held. The answers
 * stay in the order of `wanted`, and a source carried over counts as held, so
 * the verdict is the one a full check would give. `held` is what to hand the
 * next attempt: the earlier set joined with what this one found.
 */
export async function snapshotAnswersWithPrior(
  wanted: { source: string; version: string }[],
  prior: Set<string>,
  budgetMs: number,
  holds?: typeof snapshotHolds,
  pause?: (ms: number) => Promise<unknown>,
): Promise<{ answers: SnapshotAnswer[]; held: Set<string> }> {
  const answers = wanted.map(
    (entry): SnapshotAnswer =>
      prior.has(heldKey(entry)) ? "held" : "unreachable",
  );
  const asking = wanted.flatMap((_, index) =>
    answers[index] === "held" ? [] : [index],
  );
  const asked = await snapshotAnswers(
    asking.map((index) => wanted[index] as (typeof wanted)[number]),
    budgetMs,
    holds,
    pause,
  );
  asking.forEach((index, position) => {
    answers[index] = asked[position] as SnapshotAnswer;
  });
  const held = new Set(prior);
  wanted.forEach((entry, index) => {
    if (answers[index] === "held") held.add(heldKey(entry));
  });
  return { answers, held };
}

/**
 * The answer for each wanted source, four at a time: snapshot.debian.org is a
 * volunteer service that sheds load with 503s and 504s. What stays open is
 * asked again in later rounds until `budgetMs` runs out, so an outage ends with
 * an answer and not a job timeout. A later `held` overrides a denial, and a
 * later silence does not erase one.
 */
export async function snapshotAnswers(
  wanted: { source: string; version: string }[],
  budgetMs: number,
  holds: typeof snapshotHolds = snapshotHolds,
  pause: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<SnapshotAnswer[]> {
  const deadline = Date.now() + budgetMs;
  const answers = wanted.map((): SnapshotAnswer => "unreachable");
  const denials = wanted.map(() => 0);
  const open = () =>
    wanted.flatMap((_, index) =>
      answers[index] !== "held" &&
      (denials[index] as number) < SNAPSHOT_DENIALS_TO_BELIEVE
        ? [index]
        : [],
    );
  for (let round = 0; ; round += 1) {
    const asking = open();
    for (let at = 0; at < asking.length; at += 4) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const batch = asking.slice(at, at + 4);
      const results = await Promise.all(
        batch.map((index) => {
          const { source, version } = wanted[index] as (typeof wanted)[number];
          return holds(source, version, Math.min(SNAPSHOT_REQUEST_MS, left));
        }),
      );
      results.forEach((answer, position) => {
        const index = batch[position] as number;
        if (answer === "unreachable") return;
        answers[index] = answer;
        if (answer === "missing") {
          denials[index] = (denials[index] as number) + 1;
        }
      });
    }
    const unanswered = open().length;
    const left = deadline - Date.now();
    console.log(`round ${round + 1}: ${unanswered} sources still open`);
    if (unanswered === 0 || left <= 0) break;
    await pause(
      Math.min(
        SNAPSHOT_ROUND_PAUSE_MS[round] ??
          (SNAPSHOT_ROUND_PAUSE_MS.at(-1) as number),
        left,
      ),
    );
  }
  answers.forEach((answer, index) => {
    if (answer === "held") return;
    const { source, version } = wanted[index] as (typeof wanted)[number];
    console.error(`${answer}: ${snapshotUrl(source, version)}`);
  });
  return answers;
}

/** DEBIAN_SOURCES.md for the Debian system this runs on. */
function debianSourcesHere(): string {
  return renderDebianSources(
    parseDpkgStatus(readFileSync(DPKG_STATUS, "utf8")),
    (pkg) => {
      const path = `/usr/share/doc/${pkg.name}/copyright`;
      return existsSync(path) && mentionsGpl(readFileSync(path, "utf8"));
    },
  );
}

/** Every `Bun v<x.y.z>` a compiled Bun executable names. */
export function embeddedBunVersions(executable: Buffer): string[] {
  const found = new Set<string>();
  const marker = Buffer.from("Bun v");
  for (
    let at = executable.indexOf(marker);
    at !== -1;
    at = executable.indexOf(marker, at + marker.length)
  ) {
    const tail = executable
      .subarray(at + marker.length, at + marker.length + 16)
      .toString("latin1");
    const version = tail.match(/^\d+\.\d+\.\d+(?![\d.])/)?.[0];
    if (version !== undefined) found.add(version);
  }
  return [...found].sort();
}

/**
 * What --verify checks beyond node_modules, inside a built image: the Bun it
 * runs, the bundled Claude Code's runtime, the license texts the notices
 * point to, and DEBIAN_SOURCES.md against the installed packages.
 */
function verifyImageFacts(
  root: string,
  image: Image,
  appDir: string,
): string[] {
  const problems: string[] = [];
  const base = baseImageOf(
    readFileSync(join(root, "apps", appOf(image), "Dockerfile"), "utf8"),
  );
  const build = BUN_BUILDS[base.bun];
  if (Bun.version !== base.bun || Bun.revision !== build?.revision) {
    problems.push(
      `${image} runs Bun ${Bun.version}+${Bun.revision}; ${OUTPUT} names ${base.bun}+${build?.revision}`,
    );
  }
  for (const path of COMMON_LICENSES) {
    if (!existsSync(path)) problems.push(`${image} lacks ${path}`);
  }
  const sourcesPath = join(appDir, DEBIAN_SOURCES);
  if (!existsSync(sourcesPath)) {
    problems.push(`${image} lacks ${sourcesPath}`);
  } else if (readFileSync(sourcesPath, "utf8") !== debianSourcesHere()) {
    problems.push(
      `${sourcesPath} does not match ${DPKG_STATUS}: a Dockerfile step after the one that writes it changed the installed packages`,
    );
  }
  if (image === "worker") {
    const sdk = JSON.parse(
      readFileSync(
        join(appDir, "node_modules", AGENT_SDK, "package.json"),
        "utf8",
      ),
    ) as { version: string };
    const expected = CLAUDE_CODE_BUN[sdk.version];
    const embedded = embeddedBunVersions(readFileSync(CLAUDE_EXECUTABLE));
    if (embedded.length !== 1 || embedded[0] !== expected) {
      problems.push(
        `${CLAUDE_EXECUTABLE} (${AGENT_SDK}@${sdk.version}) embeds Bun ${embedded.join(", ") || "(none found)"}; ${OUTPUT} names ${expected}`,
      );
    }
  }
  return problems;
}

async function main(argv: string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const outputPath = join(root, OUTPUT);
  const [mode, ...rest] = argv;

  if (mode === "--verify") {
    const [image, appDir] = rest;
    if (!IMAGES.includes(image as Image) || appDir === undefined) {
      console.error("usage: third-party-notices.ts --verify <image> <app-dir>");
      return 2;
    }
    const listed = parseRows(readFileSync(outputPath, "utf8"));
    // Workspace packages are links to this repository's own code; a copy
    // instead of a link would still be ours.
    const installed = installedPackages(join(appDir, "node_modules"));
    const held = [...installed.keys()].filter(
      (id) => !id.startsWith("@werft-ai/"),
    );
    const missing = held.filter(
      (id) => !listed.get(id)?.images.includes(image as Image),
    );
    for (const id of missing) {
      console.error(
        `${image} image holds ${id}, which ${OUTPUT} does not list for it`,
      );
    }
    // The notices carry the text of a package without its own license file;
    // one they think has a file must really have it.
    for (const id of held) {
      const dirs = installed.get(id) as string[];
      if (
        listed.get(id)?.holder === undefined &&
        dirs.some((dir) => !readdirSync(dir).some(isLicenseFile))
      ) {
        missing.push(id);
        console.error(
          `${image} image holds ${id} without a license file, which ${OUTPUT} does not carry the text for`,
        );
      }
    }
    console.log(
      `${image}: ${held.length} packages under ${appDir}/node_modules, ${missing.length} not in ${OUTPUT}`,
    );
    const problems = verifyImageFacts(root, image as Image, appDir);
    for (const problem of problems) console.error(problem);
    if (problems.length === 0) {
      console.log(
        `${image}: Bun ${Bun.version}+${Bun.revision}${image === "worker" ? `, Claude Code embeds Bun ${embeddedBunVersions(readFileSync(CLAUDE_EXECUTABLE)).join(", ")}` : ""}, license texts and ${DEBIAN_SOURCES} match ${OUTPUT}`,
      );
    }
    return missing.length === 0 && problems.length === 0 ? 0 : 1;
  }

  if (mode === "--debian-sources") {
    process.stdout.write(debianSourcesHere());
    return 0;
  }

  // Exit 1 when snapshot.debian.org lacks a listed source, 3 when it did not
  // answer for one; image-sources.sh decides what either means for a publish.
  if (mode === "--snapshot-check") {
    const [budget, ...args] = rest;
    const budgetSeconds = Number(budget);
    // --prior <file>: answers earlier attempts of this run found held.
    // --held-out <file>: where to write the held set for the next attempt.
    const files: string[] = [];
    let priorFile: string | undefined;
    let heldOut: string | undefined;
    for (let at = 0; at < args.length; at += 1) {
      if (args[at] === "--prior") priorFile = args[++at];
      else if (args[at] === "--held-out") heldOut = args[++at];
      else files.push(args[at] as string);
    }
    if (files.length === 0 || !(budgetSeconds > 0)) {
      console.error(
        "usage: third-party-notices.ts --snapshot-check <budget seconds> [--prior <file>] [--held-out <file>] <file>...",
      );
      return 2;
    }
    const wanted = new Map<string, { source: string; version: string }>();
    for (const file of files) {
      const listed = parseDebianSources(readFileSync(file, "utf8"));
      if (listed.length === 0) {
        console.error(`no sources listed in ${file}`);
        return 2;
      }
      for (const entry of listed) {
        wanted.set(`${entry.source} ${entry.version}`, entry);
      }
    }
    const prior = parseHeld(
      priorFile && existsSync(priorFile) ? readFileSync(priorFile, "utf8") : "",
    );
    const carried = [...wanted.keys()].filter((key) => prior.has(key)).length;
    if (carried > 0) {
      console.log(
        `${carried} of ${wanted.size} sources were found held by an earlier attempt`,
      );
    }
    const { answers, held: heldSet } = await snapshotAnswersWithPrior(
      [...wanted.values()],
      prior,
      budgetSeconds * 1000,
    );
    // Written before the verdict: a failed attempt is the one that hands on.
    if (heldOut) {
      writeFileSync(heldOut, `${[...heldSet].sort().join("\n")}\n`);
    }
    const held = answers.filter((answer) => answer === "held").length;
    console.log(
      `snapshot.debian.org responses: ${
        [...snapshotResponses].map(([kind, n]) => `${kind}=${n}`).join(" ") ||
        "none"
      } (4 requests at a time, ${SNAPSHOT_REQUEST_MS / 1000}s timeout, rounds pause ${SNAPSHOT_ROUND_PAUSE_MS.map((ms) => ms / 1000).join("/")}s)`,
    );
    console.log(
      `snapshot.debian.org holds ${held} of ${wanted.size} sources in ${files.length} lists`,
    );
    if (answers.includes("missing")) return 1;
    return answers.includes("unreachable") ? 3 : 0;
  }

  const checking = mode === "--check";
  if (mode !== undefined && !checking) {
    console.error(
      "usage: third-party-notices.ts [--check | --verify <image> <app-dir> | --debian-sources | --snapshot-check <file>]",
    );
    return 2;
  }
  const committed = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8")
    : "";
  const committedRows = parseRows(committed);
  const rows = await collectRows(root, async (pkg) => {
    if (!checking) return fetchRegistry(pkg);
    const row = committedRows.get(`${pkg.name}@${pkg.version}`);
    // A package the file does not name yet is drift, reported below.
    return {
      license: row?.license ?? "UNKNOWN",
      notices: [],
      ...(row?.holder === undefined ? {} : { holder: row.holder }),
    };
  });
  // tests/images.test.ts holds every app Dockerfile to the same base.
  const base = baseImageOf(
    readFileSync(join(root, "apps/worker/Dockerfile"), "utf8"),
  );
  const problems = problemsOf(rows, base);
  for (const problem of problems) console.error(problem);
  const next = render(rows, base);
  if (checking) {
    if (next !== committed) {
      const nextRows = parseRows(next);
      for (const id of nextRows.keys()) {
        if (!committedRows.has(id)) console.error(`+ ${id}`);
      }
      for (const id of committedRows.keys()) {
        if (!nextRows.has(id)) console.error(`- ${id}`);
      }
      console.error(
        `${OUTPUT} does not match bun.lock and node_modules; run \`bun scripts/third-party-notices.ts\` and commit the result`,
      );
      return 1;
    }
    console.log(`${OUTPUT} is current: ${rows.length} packages`);
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0) return 1;
  writeFileSync(outputPath, next);
  console.log(`wrote ${OUTPUT}: ${rows.length} packages`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
