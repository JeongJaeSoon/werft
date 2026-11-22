import type { SkillCheckFinding, SkillCheckRule } from "@werft-ai/contracts";
import { type CanonicalBundleFile, runsAsScript } from "./bundle-validator.ts";
import { unifiedLineDiff } from "./line-diff.ts";

// Fixed-rule checks of one skill version against the approved version
// before it. They only narrow approval: a finding stops protected-branch
// auto-approve for that skill and is shown to the reviewer; nothing here
// approves or rejects. Rules can be evaded (padding, other spellings), so
// passing them proves nothing.

export type { SkillCheckFinding, SkillCheckRule };

/** Changed text lines (added plus removed) past which a person reads it. */
export const LARGE_CHANGE_LINES = 300;
const MAX_SAMPLES = 20;

/**
 * Sentences that read as an instruction to the agent rather than to the
 * reader of a skill. Matched on added lines after NFKC and lower-casing.
 * The one list; tests hold a match and a near miss for each.
 */
export const INSTRUCTION_PATTERNS: readonly { id: string; pattern: RegExp }[] =
  [
    {
      id: "ignore_instructions",
      pattern:
        /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|any|other|system)\b.{0,20}\b(?:instructions?|prompts?|rules?|directions?)\b/,
    },
    { id: "system_prompt", pattern: /\bsystem prompt\b/ },
    {
      id: "send_credentials",
      pattern:
        /\b(?:send|post|upload|exfiltrate|leak|forward|transmit)\b.{0,60}\b(?:secrets?|tokens?|passwords?|credentials?|api[ _-]?keys?|private keys?)\b/,
    },
    {
      id: "hide_from_user",
      pattern:
        /\b(?:do not|don't|never)\b.{0,20}\b(?:tell|inform|mention|show)\b.{0,20}\bthe user\b/,
    },
    {
      id: "ignore_instructions_ko",
      pattern:
        /(?:이전|앞의|위의|기존|모든)\s*(?:의\s*)?(?:모든\s*)?(?:지시|지침|명령|규칙)\S{0,4}\s*(?:을|를)?\s*(?:무시|잊)/,
    },
    {
      id: "send_credentials_ko",
      pattern:
        /(?:비밀\s*값|비밀번호|토큰|자격\s*증명|api\s*키).{0,30}(?:보내|전송|업로드|유출)/,
    },
    {
      id: "hide_from_user_ko",
      pattern: /사용자에게.{0,10}(?:알리지|말하지|보이지)\s*(?:마|말)/,
    },
  ];

/**
 * Text a reviewer cannot see: control characters other than tab and line
 * ends (a NUL included), zero-width and invisible operators, bidi marks and
 * controls, and tag characters.
 */
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;
/** The authority's host: a bracketed IPv6 literal or a name, after any userinfo. */
const URL_HOST =
  /\bhttps?:\/\/(?:[^\s/?#"'<>()[\]`\\@]*@)?(\[[^\]\s/]*\]|[^\s/?#"'<>()[\]`\\:]+)/gi;
const SCRIPTS_DIR = /^skills\/[^/]+\/scripts\//;
const MANIFEST = ".claude-plugin/plugin.json";

// Not fatal: a NUL or a bad byte must not take a file out of the checks.
// Bad bytes read as U+FFFD; a NUL is itself hidden text.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const textOf = (bytes: Uint8Array): string => decoder.decode(bytes);

function hostsOf(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_HOST)) {
    hosts.add((match[1] as string).toLowerCase().replace(/\.$/, ""));
  }
  return hosts;
}

function descriptionOf(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  return (
    lines
      .slice(1, end === -1 ? 1 : end)
      .find((line) => line.startsWith("description:")) ?? null
  );
}

const codePoint = (char: string) =>
  `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;

const runs = (file: CanonicalBundleFile) =>
  runsAsScript(file.path, file.mode, file.bytes) || SCRIPTS_DIR.test(file.path);

/**
 * The approved version a version's diff and checks start from: the last
 * approved one registered before it (archived ones too), in registration
 * order. `id` null asks for a version not written yet, after all of them.
 */
export function checkBaseline<
  T extends {
    id: string;
    version: number | null;
    review: string;
    registeredAt: Date;
  },
>(named: readonly T[], id: string | null): T | null {
  const ordered = [...named].sort(
    (a, b) =>
      (a.version ?? 0) - (b.version ?? 0) ||
      a.registeredAt.getTime() - b.registeredAt.getTime(),
  );
  const at =
    id === null ? ordered.length : ordered.findIndex((row) => row.id === id);
  return (
    ordered
      .slice(0, Math.max(0, at))
      .filter((row) => row.review === "approved")
      .at(-1) ?? null
  );
}

const RULE_ORDER: readonly SkillCheckRule[] = [
  "scripts_added",
  "large_change",
  "new_url",
  "hidden_unicode",
  "instruction_like",
  "description_changed",
];

/**
 * The rules a version fails, one finding per rule, in rule order; empty
 * when it fails none. `before` is the approved version the reviewer's
 * diff starts from, null when none: then every file is added and
 * `description_changed` has nothing to compare.
 */
export function checkSkillVersion(
  before: readonly CanonicalBundleFile[] | null,
  after: readonly CanonicalBundleFile[],
): SkillCheckFinding[] {
  const old = new Map((before ?? []).map((file) => [file.path, file]));
  const found = new Map<
    SkillCheckRule,
    { paths: Set<string>; samples: Set<string> }
  >();
  const flag = (rule: SkillCheckRule, path: string, sample?: string) => {
    const entry = found.get(rule) ?? { paths: new Set(), samples: new Set() };
    found.set(rule, entry);
    entry.paths.add(path);
    if (sample !== undefined) entry.samples.add(sample);
  };

  const beforeHosts = new Set<string>();
  for (const file of before ?? []) {
    for (const host of hostsOf(textOf(file.bytes))) beforeHosts.add(host);
  }

  let changedLines = 0;
  const changedPaths: string[] = [];
  for (const file of after) {
    if (file.path === MANIFEST) continue;
    const earlier = old.get(file.path);
    if (earlier?.sha256 === file.sha256 && earlier.mode === file.mode) continue;
    if (runs(file) && (earlier === undefined || !runs(earlier))) {
      flag("scripts_added", file.path);
    }
    for (const char of file.path.match(HIDDEN) ?? []) {
      flag("hidden_unicode", file.path, codePoint(char));
    }
    if (earlier?.sha256 === file.sha256) continue; // only the execute bit
    changedPaths.push(file.path);

    const text = textOf(file.bytes);
    const earlierText = earlier === undefined ? null : textOf(earlier.bytes);
    let added: string[] = [];
    if (earlierText === null) {
      added = text.split("\n");
      changedLines += added.length;
    } else {
      const diff = unifiedLineDiff(earlierText, text);
      if (diff === null) {
        // Too large to compare: every line counts as new, and the size alone fails.
        added = text.split("\n");
        changedLines = Number.POSITIVE_INFINITY;
      } else {
        const lines = diff.split("\n").filter((line) => !line.startsWith("@@"));
        for (const line of lines) {
          if (line.startsWith("-")) changedLines++;
          if (line.startsWith("+")) {
            changedLines++;
            added.push(line.slice(1));
          }
        }
      }
    }

    for (const line of added) {
      for (const char of line.match(HIDDEN) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
      }
      for (const host of hostsOf(line)) {
        if (!beforeHosts.has(host)) flag("new_url", file.path, host);
      }
      const plain = line.normalize("NFKC").replace(HIDDEN, "").toLowerCase();
      for (const { id, pattern } of INSTRUCTION_PATTERNS) {
        if (pattern.test(plain)) flag("instruction_like", file.path, id);
      }
    }

    if (
      before !== null &&
      /^skills\/[^/]+\/SKILL\.md$/.test(file.path) &&
      descriptionOf(text) !== descriptionOf(earlierText)
    ) {
      flag("description_changed", file.path);
    }
  }
  // A file dropped whole is a change of every line it had.
  const kept = new Set(after.map((file) => file.path));
  for (const file of before ?? []) {
    if (file.path === MANIFEST || kept.has(file.path)) continue;
    changedLines += textOf(file.bytes).split("\n").length;
    changedPaths.push(file.path);
  }
  if (changedLines > LARGE_CHANGE_LINES) {
    const sample = Number.isFinite(changedLines)
      ? String(changedLines)
      : "too_large";
    for (const path of changedPaths) flag("large_change", path, sample);
  }

  return RULE_ORDER.flatMap((rule) => {
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
}
