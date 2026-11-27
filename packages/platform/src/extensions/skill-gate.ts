import { type CanonicalBundleFile, runsAsScript } from "./bundle-validator.ts";
import { unifiedLineDiff } from "./line-diff.ts";
import { INSTRUCTION_PATTERNS, plainTextHosts } from "./skill-checks.ts";

// The automatic gate a repository skill's new version must pass before it is
// stored. Blocking rules read every file of the version: they decide whether
// it may exist at all. Warnings and notices read only what changed since the
// approved version before it, so an update shows what it brought.

export type SkillGateRule =
  | "file_type"
  | "hidden_override"
  | "hidden_unicode"
  | "instruction_like"
  | "host_not_allowlisted"
  | "network_call"
  | "license_missing"
  | "license_unclassified"
  | "license_notice_missing"
  | "license_changed"
  | "binary_added";

export type SkillGateFinding = {
  rule: SkillGateRule;
  paths: string[];
  samples: string[];
};

export type SkillGateVerdict = "block" | "warn" | "pass";

export type SkillGateResult = {
  verdict: SkillGateVerdict;
  blocks: SkillGateFinding[];
  warnings: SkillGateFinding[];
  notices: SkillGateFinding[];
};

export type SkillGateInput = {
  /** The approved version the diff starts from; null on the first enable. */
  before: readonly CanonicalBundleFile[] | null;
  /** The validator's tree: the bytes the engine reads. */
  after: readonly CanonicalBundleFile[];
  /** Hosts of the egress allowlist, compared as text: no DNS, no port. */
  allowedHosts: ReadonlySet<string>;
  /** File names at the root of the source repository, outside the skill. */
  repositoryRootFiles: readonly string[];
};

const MAX_SAMPLES = 20;
const MANIFEST = ".claude-plugin/plugin.json";
const SCRIPTS_DIR = /^skills\/[^/]+\/scripts\//;
const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/;
const LICENSE_FILE = /^(?:licen[cs]e|copying)/i;
const NOTICE_FILE = /^(?:notice|third_party_notices)/i;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * The media a skill may carry besides UTF-8 text, by extension and leading
 * bytes; both must agree. Passing proves the format, not that the file is
 * harmless: a reader's parser still reads it.
 */
const MEDIA: readonly {
  kind: string;
  extensions: readonly string[];
  matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    kind: "png",
    extensions: [".png"],
    matches: (b) =>
      startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    kind: "jpeg",
    extensions: [".jpg", ".jpeg"],
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    kind: "gif",
    extensions: [".gif"],
    matches: (b) =>
      startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  },
  {
    kind: "webp",
    extensions: [".webp"],
    matches: (b) =>
      startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  },
  {
    kind: "ttf",
    extensions: [".ttf"],
    matches: (b) =>
      startsWith(b, [0x00, 0x01, 0x00, 0x00]) || startsWith(b, ascii("true")),
  },
  {
    kind: "otf",
    extensions: [".otf"],
    matches: (b) => startsWith(b, ascii("OTTO")),
  },
  {
    kind: "woff",
    extensions: [".woff"],
    matches: (b) => startsWith(b, ascii("wOFF")),
  },
  {
    kind: "woff2",
    extensions: [".woff2"],
    matches: (b) => startsWith(b, ascii("wOF2")),
  },
  {
    kind: "pdf",
    extensions: [".pdf"],
    matches: (b) => startsWith(b, ascii("%PDF-")),
  },
];

/** Characters that make text read differently than it shows: always refused. */
const OVERRIDE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]/gu;
/**
 * Invisible characters with honest uses (emoji joiners, right-to-left
 * scripts, form feeds in old sources): shown, not refused. A byte order mark
 * counts only past a file's start, which is stripped before reading.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\u{61C}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}]/gu;

/** A comment line, often a usage example rather than a call the script makes. */
const COMMENT = /^\s*(?:#|\/\/|--)/;
/** Lines of a script that install a package or reach the network; comment lines are skipped. */
export const NETWORK_CALL_PATTERNS: readonly { id: string; pattern: RegExp }[] =
  [
    {
      id: "package_runner",
      pattern: /\b(?:npx|bunx|uvx|(?:pnpm|yarn)\s+dlx|npm\s+exec)\b/,
    },
    {
      id: "package_install",
      pattern:
        /\b(?:pip3?|uv|npm|npx|pnpm|yarn|bun|bunx|gem|cargo|go|apt(?:-get)?|apk|brew|conda)(?:\s+-\S+(?:\s+(?:"[^"]{0,200}"|'[^']{0,200}'|[^\s"'-]\S*))??){0,6}(?:\s+pip(?:\s+-\S+(?:\s+(?:"[^"]{0,200}"|'[^']{0,200}'|[^\s"'-]\S*))??){0,6})?\s+(?:install|add|get|i|ci|sync)\b/,
    },
    {
      id: "download",
      pattern:
        /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|git(?:\s+-\S+(?:\s+(?:"[^"]{0,200}"|'[^']{0,200}'|[^\s"'-]\S*))??){0,6}\s+(?:clone|fetch|pull|ls-remote))\b/,
    },
    {
      id: "http_call",
      pattern:
        /\b(?:fetch\s*\(|requests\.(?:get|post|put|patch|delete|head|request)\b|urllib\.request\b|urlopen\s*\(|http\.client\b|httpx\.|aiohttp\.|axios\b|net\/http\b|socket\.(?:socket|create_connection)\b)/,
    },
  ];

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The file as text, without a leading byte order mark; null when it is not text. */
function textOf(file: CanonicalBundleFile): string | null {
  if (file.bytes.includes(0)) return null;
  try {
    return strict.decode(file.bytes).replace(/^\u{FEFF}/u, "");
  } catch {
    return null;
  }
}

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const skillOf = (path: string) => /^skills\/([^/]+)\//.exec(path)?.[1] ?? null;

function mediaOf(file: CanonicalBundleFile): string | null {
  const extension = extensionOf(file.path);
  const media = MEDIA.find((entry) => entry.extensions.includes(extension));
  return media?.matches(file.bytes) ? media.kind : null;
}

type Kind = { text: string } | { media: string } | { refused: string };

// Media first: an ASCII-only PDF is also valid UTF-8, and must still be
// held to the media rules (no execute bit).
function kindOf(file: CanonicalBundleFile): Kind {
  const media = mediaOf(file);
  if (media !== null) {
    return (file.mode & 0o111) !== 0
      ? { refused: "executable_media" }
      : { media };
  }
  const text = textOf(file);
  return text === null ? { refused: "not_text_or_allowed_media" } : { text };
}

const codePoint = (char: string) =>
  `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * What the new text changed: the lines it adds, and the 0-based indexes of
 * new lines an addition or a removal sits at (null: every line, when there is
 * no old text or the two are too large to compare).
 */
function changesOf(
  earlier: string | null,
  text: string,
): { added: string[]; at: Set<number> | null } {
  const diff = earlier === null ? null : unifiedLineDiff(earlier, text);
  if (diff === null) return { added: text.split("\n"), at: null };
  const added: string[] = [];
  const at = new Set<number>();
  let next = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+),(\d+) @@$/.exec(line);
    if (hunk !== null) {
      const start = Number(hunk[1]);
      next = Number(hunk[2]) === 0 ? start : start - 1;
    } else if (line.startsWith("+")) {
      added.push(line.slice(1));
      at.add(next++);
    } else if (line.startsWith("-")) {
      at.add(next);
    } else {
      next++;
    }
  }
  return { added, at };
}

/** The `license` value of a canonical SKILL.md, whose values are JSON strings. */
function licenseOf(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  const line = lines
    .slice(1, end === -1 ? 1 : end)
    .find((l) => l.startsWith("license: "));
  if (line === undefined) return null;
  const raw = line.slice("license: ".length);
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : raw;
  } catch {
    return raw;
  }
}

/**
 * An SPDX license expression by its grammar: license ids (`+` allowed),
 * LicenseRef and DocumentRef references, joined by AND and OR, with
 * parentheses; WITH ties one exception to one license. Ids are not looked up
 * in the SPDX list. Free text such as "Complete terms in LICENSE.txt" fails.
 */
const SPDX_LICENSE =
  /^(?:(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+|(?!LicenseRef-|DocumentRef-)[A-Za-z0-9.-]+\+?)$/;
const SPDX_EXCEPTION = /^[A-Za-z0-9.-]+$/;
const OPERATORS = new Set(["AND", "OR", "WITH", "(", ")"]);
export function isSpdxExpression(value: string): boolean {
  // SPDX expressions are ASCII, split by spaces.
  if (/[^ -~]/.test(value)) return false;
  // Operators are words: "MIT AND(Apache-2.0)" is not an expression.
  if (/(?:AND|OR|WITH)\(|\)(?:AND|OR|WITH)\b/.test(value)) return false;
  const tokens = value.replace(/[()]/g, " $& ").trim().split(/ +/);
  let at = 0;
  const term = (): boolean => {
    const token = tokens[at++];
    if (token === "(") return expression() && tokens[at++] === ")";
    if (token === undefined || OPERATORS.has(token)) return false;
    if (!SPDX_LICENSE.test(token)) return false;
    if (tokens[at] !== "WITH") return true;
    at++;
    const exception = tokens[at++];
    return (
      exception !== undefined &&
      !OPERATORS.has(exception) &&
      SPDX_EXCEPTION.test(exception) &&
      !/^(?:LicenseRef|DocumentRef)-/.test(exception)
    );
  };
  const expression = (): boolean => {
    if (!term()) return false;
    while (tokens[at] === "AND" || tokens[at] === "OR") {
      at++;
      if (!term()) return false;
    }
    return true;
  };
  return expression() && at === tokens.length;
}

const BLOCK_RULES: readonly SkillGateRule[] = ["file_type", "hidden_override"];
const WARN_RULES: readonly SkillGateRule[] = [
  "hidden_unicode",
  "instruction_like",
  "host_not_allowlisted",
  "network_call",
  "license_missing",
  "license_unclassified",
  "license_notice_missing",
];
const NOTICE_RULES: readonly SkillGateRule[] = [
  "license_changed",
  "binary_added",
];

const URL_START = /https?:\/\//gi;
const URL_ONE = /https?:\/\//i;
const CLEAN_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

/**
 * Hosts a line of code names. Each URL is read alone, up to the next one: as
 * written first (a quote may sit inside userinfo), and when that gives no
 * clean host, with the quotes, commas and brackets of code read as ends.
 */
/** Linear: a line can be a megabyte, and the gate runs on the event loop. */
function userinfoCrossesCode(segment: string): boolean {
  const start = segment.search(URL_ONE);
  if (start === -1) return false;
  const rest = segment.slice(start).replace(URL_ONE, "");
  const space = rest.search(/\s/);
  const authority = space === -1 ? rest : rest.slice(0, space);
  const at = authority.indexOf("@");
  return at > 0 && /["`,]/.test(authority.slice(0, at));
}

function codeHosts(line: string): Set<string> {
  const starts = [...line.matchAll(URL_START)].map((match) => match.index);
  const hosts = new Set<string>();
  starts.forEach((start, index) => {
    // One character before the URL keeps an autolink's "<" in view.
    const segment = line.slice(Math.max(0, start - 1), starts[index + 1]);
    const clean = (text: string) =>
      [...plainTextHosts(text)].find((host) => CLEAN_HOST.test(host));
    // Userinfo reached across a quote or comma is another string of code.
    const crossed = userinfoCrossesCode(segment);
    const split = clean(segment.replace(/["'`,;(){}$|&<>]/g, " "));
    const host = crossed
      ? (split ?? clean(segment))
      : (clean(segment) ?? split);
    if (host !== undefined) hosts.add(host);
  });
  return hosts;
}

const normalized = (line: string) =>
  line
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(OVERRIDE, "")
    .toLowerCase();

/**
 * The commands of a script the update touched. A line ending in "\\" goes on
 * in the next ("npm \\" then "ci"), so the whole new text is read as logical
 * lines, and one counts when any of its lines is at a change. Comments are
 * left out: a comment line (as written: a fullwidth "＃" starts none), and a
 * "#" or "//" after a space up to the line's end.
 */
function changedCalls(text: string, at: Set<number> | null): string[] {
  const calls: string[] = [];
  let parts: string[] = [];
  let touched = false;
  text.split("\n").forEach((line, index) => {
    if (at === null || at.has(index)) touched = true;
    if (parts.length === 0 && COMMENT.test(line)) {
      touched = false;
      return;
    }
    const comment = line.search(/(?:^|\s)(?:#|\/\/)/);
    if (comment === -1 && line.endsWith("\\")) {
      parts.push(line.slice(0, -1));
      return;
    }
    parts.push(comment === -1 ? line : line.slice(0, comment));
    if (touched) calls.push(normalized(parts.join(" ")));
    parts = [];
    touched = false;
  });
  if (parts.length > 0 && touched) calls.push(normalized(parts.join(" ")));
  return calls;
}

/** Judges one version of a repository skill; never throws on content. */
export function gateSkillVersion(input: SkillGateInput): SkillGateResult {
  const { before, after } = input;
  const allowedHosts = new Set(
    [...input.allowedHosts].map((host) =>
      host.toLowerCase().replace(/\.$/, ""),
    ),
  );
  const found = new Map<
    SkillGateRule,
    { paths: Set<string>; samples: Set<string> }
  >();
  const flag = (rule: SkillGateRule, path: string, sample?: string) => {
    const entry = found.get(rule) ?? { paths: new Set(), samples: new Set() };
    found.set(rule, entry);
    entry.paths.add(path);
    if (sample !== undefined) entry.samples.add(sample);
  };
  const old = new Map((before ?? []).map((file) => [file.path, file]));
  const files = after.filter((file) => file.path !== MANIFEST);

  for (const file of after) {
    const kind = kindOf(file);
    if ("refused" in kind) flag("file_type", file.path, kind.refused);
    for (const char of file.path.match(OVERRIDE) ?? []) {
      flag("hidden_override", file.path, codePoint(char));
    }
    if ("text" in kind) {
      for (const char of kind.text.match(OVERRIDE) ?? []) {
        flag("hidden_override", file.path, codePoint(char));
      }
    }

    const earlier = old.get(file.path);
    const earlierKind = earlier === undefined ? null : kindOf(earlier);
    // Before the unchanged-bytes skip: media refused only for its execute bit
    // becomes allowed by a mode change alone.
    if (
      "media" in kind &&
      (earlierKind === null || !("media" in earlierKind))
    ) {
      flag("binary_added", file.path, kind.media);
    }
    if (earlier?.sha256 === file.sha256) continue;
    if (earlier === undefined) {
      for (const char of file.path.match(INVISIBLE) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
      }
    }
    if (!("text" in kind)) continue;

    const script =
      runsAsScript(file.path, file.mode, file.bytes) ||
      SCRIPTS_DIR.test(file.path);
    // Media was never read as text, so all of a file that became text is new.
    // CRLF reads as LF: a line end is not a hidden character, a lone CR is.
    const earlierText =
      earlierKind !== null && "text" in earlierKind
        ? earlierKind.text.replace(/\r\n/g, "\n")
        : null;
    const newText = kind.text.replace(/\r\n/g, "\n");
    const { added, at } = changesOf(earlierText, newText);
    for (const line of added) {
      for (const char of line.match(INVISIBLE) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
      }
      const plain = normalized(line);
      for (const { id, pattern } of INSTRUCTION_PATTERNS) {
        if (pattern.test(plain)) flag("instruction_like", file.path, id);
      }
      if (!script) continue;
      for (const host of codeHosts(line)) {
        if (!allowedHosts.has(host))
          flag("host_not_allowlisted", file.path, host);
      }
    }
    if (!script) continue;
    for (const call of changedCalls(newText, at)) {
      for (const { id, pattern } of NETWORK_CALL_PATTERNS) {
        if (pattern.test(call)) flag("network_call", file.path, id);
      }
    }
  }

  const rootNotice = input.repositoryRootFiles.some((name) =>
    NOTICE_FILE.test(name),
  );
  const licenseState = (
    tree: readonly CanonicalBundleFile[],
    skill: string,
  ) => {
    const own = tree.filter((f) => skillOf(f.path) === skill);
    const named = (pattern: RegExp) =>
      own
        .filter((f) => pattern.test(baseName(f.path)))
        .map((f) => `${f.path}:${f.sha256}`)
        .sort()
        .join("\n");
    const md = own.find((f) => f.path === `skills/${skill}/SKILL.md`);
    return {
      license: md === undefined ? null : licenseOf(textOf(md)),
      licenseFiles: named(LICENSE_FILE),
      noticeFiles: named(NOTICE_FILE),
    };
  };
  for (const file of files) {
    const skill = SKILL_FILE.exec(file.path)?.[1];
    if (skill === undefined) continue;
    const now = licenseState(after, skill);
    // A skill new in this version is judged as on a first enable.
    const was = before?.some((f) => f.path === file.path)
      ? licenseState(before, skill)
      : null;
    const licenseChanged =
      was !== null &&
      (was.license !== now.license || was.licenseFiles !== now.licenseFiles);
    if (licenseChanged) flag("license_changed", file.path);
    // Warnings read the diff: an update that leaves the terms alone repeats none.
    if (
      was !== null &&
      !licenseChanged &&
      was.noticeFiles === now.noticeFiles
    ) {
      continue;
    }
    // A LICENSE file in the skill states the terms, whatever the field says.
    const licenseFile = now.licenseFiles !== "";
    if (now.license === null && !licenseFile) {
      flag("license_missing", file.path);
    }
    if (
      now.license !== null &&
      !licenseFile &&
      !isSpdxExpression(now.license)
    ) {
      flag("license_unclassified", file.path, now.license.slice(0, 80));
    }
    if (rootNotice && now.noticeFiles === "") {
      flag("license_notice_missing", file.path);
    }
  }

  const collect = (rules: readonly SkillGateRule[]) =>
    rules.flatMap((rule) => {
      const entry = found.get(rule);
      return entry === undefined
        ? []
        : [
            {
              rule,
              paths: [...entry.paths].slice(0, MAX_SAMPLES),
              samples: [...entry.samples].slice(0, MAX_SAMPLES),
            },
          ];
    });
  const blocks = collect(BLOCK_RULES);
  const warnings = collect(WARN_RULES);
  return {
    verdict:
      blocks.length > 0 ? "block" : warnings.length > 0 ? "warn" : "pass",
    blocks,
    warnings,
    notices: collect(NOTICE_RULES),
  };
}
