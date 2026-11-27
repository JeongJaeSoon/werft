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
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][^/]*)?$/i;
const NOTICE_FILE = /^(?:notice|third[_-]?party[_-]?notices?)(?:[.-][^/]*)?$/i;

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
  /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}\u{61C}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}]/gu;

/** A comment line, often a usage example rather than a call the script makes. */
const COMMENT = /^\s*(?:#|\/\/|--)/;
/** Lines of a script that install a package or reach the network; comment lines are skipped. */
export const NETWORK_CALL_PATTERNS: readonly { id: string; pattern: RegExp }[] =
  [
    {
      id: "package_install",
      pattern:
        /\b(?:pip3?|uv|npm|npx|pnpm|yarn|bun|bunx|gem|cargo|go|apt(?:-get)?|apk|brew|conda)\s+(?:pip\s+)?(?:install|add|get|i)\b/,
    },
    {
      id: "download",
      pattern: /\b(?:curl|wget|invoke-webrequest|invoke-restmethod)\b/,
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

function kindOf(file: CanonicalBundleFile): Kind {
  const text = textOf(file);
  if (text !== null) return { text };
  const media = mediaOf(file);
  if (media === null) return { refused: "not_text_or_allowed_media" };
  return (file.mode & 0o111) !== 0
    ? { refused: "executable_media" }
    : { media };
}

const codePoint = (char: string) =>
  `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;

/** Lines the new text adds over the old one; all of it when there is none or it is too large to compare. */
function addedLines(earlier: string | null, text: string): string[] {
  if (earlier === null) return text.split("\n");
  const diff = unifiedLineDiff(earlier, text);
  if (diff === null) return text.split("\n");
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1));
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
 * An SPDX expression by its shape: identifiers joined by AND, OR or WITH,
 * with parentheses. Free text such as "Complete terms in LICENSE.txt" is not.
 */
const SPDX_ID = /^(?:[A-Za-z0-9.-]+\+?|LicenseRef-[A-Za-z0-9.-]+)$/;
export function isSpdxExpression(value: string): boolean {
  const tokens = value.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let depth = 0;
  let expectId = true;
  for (const token of tokens) {
    if (token === "(") {
      if (!expectId) return false;
      depth++;
    } else if (token === ")") {
      if (expectId || --depth < 0) return false;
    } else if (token === "AND" || token === "OR" || token === "WITH") {
      if (expectId) return false;
      expectId = true;
    } else {
      if (!expectId || !SPDX_ID.test(token)) return false;
      expectId = false;
    }
  }
  return !expectId && depth === 0;
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

/** Judges one version of a repository skill; never throws on content. */
export function gateSkillVersion(input: SkillGateInput): SkillGateResult {
  const { before, after, allowedHosts } = input;
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

  for (const file of files) {
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
    if (earlier?.sha256 === file.sha256) continue;
    if (
      "media" in kind &&
      (earlier === undefined || textOf(earlier) !== null)
    ) {
      flag("binary_added", file.path, kind.media);
    }
    if (earlier === undefined) {
      for (const char of file.path.match(INVISIBLE) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
      }
    }
    if (!("text" in kind)) continue;

    const script =
      runsAsScript(file.path, file.mode, file.bytes) ||
      SCRIPTS_DIR.test(file.path);
    const earlierText = earlier === undefined ? null : textOf(earlier);
    for (const line of addedLines(earlierText, kind.text)) {
      for (const char of line.match(INVISIBLE) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
      }
      const plain = line
        .normalize("NFKC")
        .replace(INVISIBLE, "")
        .replace(OVERRIDE, "")
        .toLowerCase();
      for (const { id, pattern } of INSTRUCTION_PATTERNS) {
        if (pattern.test(plain)) flag("instruction_like", file.path, id);
      }
      if (!script) continue;
      for (const host of plainTextHosts(line)) {
        if (!allowedHosts.has(host))
          flag("host_not_allowlisted", file.path, host);
      }
      if (COMMENT.test(plain)) continue;
      for (const { id, pattern } of NETWORK_CALL_PATTERNS) {
        if (pattern.test(plain)) flag("network_call", file.path, id);
      }
    }
  }

  const rootNotice = input.repositoryRootFiles.some((name) =>
    NOTICE_FILE.test(name),
  );
  const skillMd = (tree: readonly CanonicalBundleFile[], skill: string) => {
    const file = tree.find(
      (entry) => entry.path === `skills/${skill}/SKILL.md`,
    );
    return file === undefined ? null : textOf(file);
  };
  const licenseFiles = (tree: readonly CanonicalBundleFile[], skill: string) =>
    tree
      .filter(
        (f) => skillOf(f.path) === skill && LICENSE_FILE.test(baseName(f.path)),
      )
      .map((f) => `${f.path}:${f.sha256}`)
      .sort();
  for (const file of files) {
    const skill = SKILL_FILE.exec(file.path)?.[1];
    if (skill === undefined) continue;
    const license = licenseOf(skillMd(after, skill));
    const inSkill = files
      .filter((f) => skillOf(f.path) === skill)
      .map((f) => baseName(f.path));
    // A LICENSE file in the skill states the terms, whatever the field says.
    const licenseFile = inSkill.some((name) => LICENSE_FILE.test(name));
    if (license === null && !licenseFile) {
      flag("license_missing", file.path);
    }
    if (license !== null && !licenseFile && !isSpdxExpression(license)) {
      flag("license_unclassified", file.path, license.slice(0, 80));
    }
    if (rootNotice && !inSkill.some((name) => NOTICE_FILE.test(name))) {
      flag("license_notice_missing", file.path);
    }
    if (before === null) continue;
    const beforeFiles = licenseFiles(before, skill);
    const afterFiles = licenseFiles(after, skill);
    const changedFiles =
      beforeFiles.length !== afterFiles.length ||
      beforeFiles.some((entry, index) => entry !== afterFiles[index]);
    if (license !== licenseOf(skillMd(before, skill)) || changedFiles) {
      flag("license_changed", file.path);
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
