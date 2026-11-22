import type { SkillCheckFinding, SkillCheckRule } from "@werft-ai/contracts";
import {
  micromark,
  parse as parseMarkdown,
  postprocess,
  preprocess,
} from "micromark";
import { parse, parseFragment } from "parse5";
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
/** Where a URL starts; each start is read on its own, so one URL cannot swallow the next. */
const URL_START = /\bhttps?:\/\//gi;
const SCRIPTS_DIR = /^skills\/[^/]+\/scripts\//;
const MANIFEST = ".claude-plugin/plugin.json";

// Not fatal: a NUL or a bad byte must not take a file out of the checks.
// Bad bytes read as U+FFFD; a NUL is itself hidden text.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const textOf = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * A URL ends where Markdown ends it: at whitespace, a line end or an angle
 * bracket (CommonMark link destinations and autolinks hold none). Inside
 * that, the authority runs to the path, query or fragment.
 */
const AUTHORITY = /[^/?#\\\s<>]*/y;
const TRAILING = /[.,;:!?)\]"'`*_~]/;

const count = (text: string, char: string): number =>
  text.split(char).length - 1;

/** The host a client reaches, or null when no URL parser would take it. */
function parsedHost(scheme: string, authority: string): string | null {
  try {
    // Userinfo, ports, percent-escapes, quotes and IDN spellings resolve as
    // a client resolves them.
    return new URL(`${scheme}//${authority}`).hostname;
  } catch {
    return null;
  }
}

/** Markdown's closing ")" or "]", quotes and a sentence's end at a URL's end. */
function withoutTrailing(authority: string): string {
  // A bracket that closes one opened before it (IPv6) is the URL's.
  const opened = { ")": count(authority, "("), "]": count(authority, "[") };
  const closed = { ")": count(authority, ")"), "]": count(authority, "]") };
  let cut = authority.length;
  while (cut > 0 && TRAILING.test(authority[cut - 1] as string)) {
    const last = authority[cut - 1];
    if (last === ")" || last === "]") {
      if (opened[last] >= closed[last]) break;
      closed[last] -= 1;
    }
    cut -= 1;
  }
  return authority.slice(0, cut);
}

function hostsInText(text: string): Set<string> {
  const hosts = new Set<string>();
  const add = (host: string) =>
    hosts.add(host.toLowerCase().replace(/\.$/, ""));
  for (const start of text.matchAll(URL_START)) {
    const scheme = start[0].slice(0, start[0].indexOf(":") + 1);
    // The parser skips extra slashes before the host. Each authority stops
    // at the next URL's "//" at the latest, so the text is read once.
    let from = start.index + start[0].length;
    while (text[from] === "/" || text[from] === "\\") from++;
    AUTHORITY.lastIndex = from;
    let authority = AUTHORITY.exec(text)?.[0] ?? "";
    const next = text[from + authority.length];
    const ended = next === undefined || /[\s<>]/.test(next);
    // Punctuation is the sentence's only where the URL ends; before a path
    // the parser keeps it in the host.
    // An autolink ends at its ">": what is inside it is all the URL's.
    const autolink = text[start.index - 1] === "<" && next === ">";
    if (ended && !autolink) authority = withoutTrailing(authority);
    add(parsedHost(scheme, authority) ?? authority);
  }
  return hosts;
}

/** Markdown or HTML larger than this is not rendered: its hosts cannot be judged. */
export const RENDER_LIMIT = 256 * 1024;
/** The new_url sample of a file whose hosts cannot be judged. */
export const UNREADABLE = "unreadable";
const MARKDOWN = /\.(?:md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

/** The parse5 tree as far as the checks read it. */
interface HtmlNode {
  readonly nodeName: string;
  readonly value?: string;
  readonly data?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly content?: HtmlNode;
}

/**
 * The Markdown with a reference to every link definition put first, so a
 * definition nothing uses still renders as the link a reader of the source
 * sees. First, not last: an unclosed code fence would swallow a tail.
 */
function withDefinitionsUsed(text: string): string {
  const events = postprocess(
    parseMarkdown()
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const labels = events
    .filter(
      ([kind, token]) =>
        kind === "enter" && token.type === "definitionLabelString",
    )
    .map(([, token, context]) => `[${context.sliceSerialize(token)}]`);
  return labels.length === 0 ? text : `${labels.join("\n\n")}\n\n${text}`;
}

/** The host of a link target as a browser follows it, or null. */
function targetHost(target: string): string | null {
  const value = target
    .replace(/[\t\n\r]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser strips C0 and space around a URL
    .replace(/^[\u{0}-\u{20}]+|[\u{0}-\u{20}]+$/gu, "");
  const url = value.startsWith("//") ? `https:${value}` : value;
  if (!/^https?:/i.test(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Hosts a file's URLs reach, read one way for the approved and the new
 * version alike. Markdown is read as CommonMark renders it and HTML as a
 * browser parses it: every attribute value that is a URL, and the text and
 * comments by the plain-text rule. Any other file is plain text. URLs a
 * script assembles, other encodings and plain text broken across lines are
 * not read. null: too large to render, or the renderer failed.
 */
function hostsOf(path: string, text: string): Set<string> | null {
  const markdown = MARKDOWN.test(path);
  if (!markdown && !HTML.test(path)) return hostsInText(text);
  if (text.length > RENDER_LIMIT) return null;
  let root: HtmlNode;
  try {
    root = (markdown
      ? parseFragment(
          micromark(withDefinitionsUsed(text), {
            allowDangerousHtml: true,
            allowDangerousProtocol: true,
          }),
        )
      : parse(text)) as unknown as HtmlNode;
  } catch {
    return null;
  }
  const hosts = new Set<string>();
  const pending: HtmlNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const attr of node.attrs ?? []) {
      const host = targetHost(attr.value);
      if (host !== null) hosts.add(host);
    }
    const shown =
      node.nodeName === "#text"
        ? node.value
        : node.nodeName === "#comment"
          ? node.data
          : undefined;
    if (shown !== undefined) {
      for (const host of hostsInText(shown)) hosts.add(host);
    }
    for (const child of node.childNodes ?? []) pending.push(child);
    if (node.content !== undefined) pending.push(node.content);
  }
  return hosts;
}

function descriptionOf(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
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
    // A file that cannot be read names no host as approved.
    for (const host of hostsOf(file.path, textOf(file.bytes)) ?? []) {
      beforeHosts.add(host);
    }
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

    // Hosts come from the whole file, compared with every approved file's;
    // a file whose hosts cannot be read fails the rule.
    const hosts = hostsOf(file.path, text);
    if (hosts === null) flag("new_url", file.path, UNREADABLE);
    for (const host of hosts ?? []) {
      if (!beforeHosts.has(host)) flag("new_url", file.path, host);
    }
    for (const line of added) {
      for (const char of line.match(HIDDEN) ?? []) {
        flag("hidden_unicode", file.path, codePoint(char));
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
