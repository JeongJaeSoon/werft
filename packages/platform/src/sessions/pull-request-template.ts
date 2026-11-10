// The template is input from the repository: anyone who may write to its
// default branch wrote it.

import {
  PULL_REQUEST_TEMPLATE_MAX_BYTES,
  type PullRequestTemplateRecord,
} from "@werft-ai/contracts";
import type { RepositoryReadable } from "../action/ports/capabilities.ts";
import type { GitTreeEntry } from "../action/ports/github-api.ts";
import { closeOpenBlocks } from "./git-attribution.ts";
import { breakReferences, stripEngineSignatures } from "./pull-request-text.ts";

// `&#12;` is an entity, not a reference. An address is broken in its path,
// whatever its scheme or host is written as: a URL parser normalises a host,
// not a path.
const LOCAL_REFERENCE = /(^|[^\w&])(#|GH-)(?=\d)/gi;
const NUMBERED_PATH = /(\/(?:issues|pull)\/)(?=[^\s])/gi;
const COMMIT_PATH = /(\/commit\/)(?=[^\s])/gi;
const COMMIT_REFERENCE = /(^|[^\w/.-])([\w.-]+\/[\w.-]+@)(?=[0-9a-f]{7})/gi;
const COMMIT_HASH = /\b([0-9a-f]{7})(?=[0-9a-f]{33}\b)/gi;

// A character reference that spells a printable ASCII character is how a
// path or an address would be written to get past the checks below; it is
// shown as text instead of being resolved.
const ASCII_ENTITY =
  /&(?=#(?:x[0-9a-f]+|\d+);|(?:sol|bsol|num|colon|commat|period);)/gi;

function breakLinks(text: string): string {
  return text
    .replace(ASCII_ENTITY, `&${ZWSP}`)
    .replace(LOCAL_REFERENCE, `$1$2${ZWSP}`)
    .replace(NUMBERED_PATH, `$1${ZWSP}`)
    .replace(COMMIT_PATH, `$1${ZWSP}`)
    .replace(COMMIT_REFERENCE, `$1$2${ZWSP}`)
    .replace(COMMIT_HASH, `$1${ZWSP}`);
}

export const SECTION_NAMES = [
  "summary",
  "changes",
  "rationale",
  "testing",
  "related",
  "notes",
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export type SectionBlocks = Partial<Record<SectionName, string>>;

export const TEMPLATE_MAX_BYTES = PULL_REQUEST_TEMPLATE_MAX_BYTES;
const ZWSP = "​";

type TemplateSkip = NonNullable<PullRequestTemplateRecord["skipped"]>;

export type TemplateRead =
  | {
      kind: "found";
      commit: string;
      path: string;
      blobSha: string;
      template: PreparedTemplate;
    }
  | { kind: "none"; commit: string }
  | {
      kind: "skipped";
      commit: string | null;
      reason: TemplateSkip;
      path?: string;
      error?: string;
    };

class Skip extends Error {
  constructor(
    readonly reason: TemplateSkip,
    readonly path?: string,
  ) {
    super(reason);
  }
}

const SINGLE_NAME = "pull_request_template.md";
const DIRECTORY_NAME = "pull_request_template";
// Where GitHub looks, in its order: `.github/`, the root, `docs/`.
const LOCATIONS: readonly (string | null)[] = [".github", null, "docs"];
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const MAX_PATH_RECORD = 200;

function recordedPath(parts: readonly string[]): string {
  return stripHidden(parts.join("/"))
    .replace(/[\p{Cc}\p{Cf}]/gu, "?")
    .slice(0, MAX_PATH_RECORD);
}

/**
 * The repository's template at the default branch's commit as it is when
 * this starts. Never throws: a read that fails is `read_failed`, and the
 * caller opens the pull request on the platform's default template.
 */
export async function readRepositoryTemplate(
  forge: RepositoryReadable,
  options: {
    templateName?: string | null;
  } = {},
): Promise<TemplateRead> {
  const wanted = options.templateName?.toLowerCase() ?? null;
  let commit: string | null = null;
  try {
    const { defaultBranch } = await forge.getRepository();
    const head = await forge.getBranchHead(defaultBranch);
    commit = head.commitSha;
    const trees = new Map<string, Promise<GitTreeEntry[]>>();
    const tree = (sha: string) => {
      let entries = trees.get(sha);
      if (entries === undefined) {
        entries = forge.readTree(sha).then((read) => {
          // A cut list may be missing the template, or hide a second one.
          if (read.truncated) throw new Skip("read_failed");
          return read.entries;
        });
        trees.set(sha, entries);
      }
      return entries;
    };
    // GitHub matches names without regard to case.
    const named = (
      entries: readonly GitTreeEntry[],
      wanted: (name: string) => boolean,
    ) => entries.filter((entry) => wanted(entry.name.toLowerCase()));
    const only = (found: GitTreeEntry[]): GitTreeEntry | null => {
      if (found.length > 1) throw new Skip("multiple");
      return found[0] ?? null;
    };
    const locationTree = async (
      location: string | null,
    ): Promise<{ entries: GitTreeEntry[]; at: string[] } | null> => {
      const root = await tree(head.treeSha);
      if (location === null) return { entries: root, at: [] };
      const directory = only(named(root, (name) => name === location));
      if (directory === null || directory.type !== "tree") return null;
      return { entries: await tree(directory.sha), at: [directory.name] };
    };

    const candidate = async (
      entry: GitTreeEntry,
      at: readonly string[],
    ): Promise<TemplateRead> => {
      const parts = [...at, entry.name];
      const path = recordedPath(parts);
      if (entry.type !== "blob" || !FILE_MODES.has(entry.mode)) {
        throw new Skip("not_file", path);
      }
      if (entry.size !== null && entry.size > TEMPLATE_MAX_BYTES) {
        throw new Skip("too_large", path);
      }
      const bytes = await forge.readBlob(entry.sha);
      if (bytes.length > TEMPLATE_MAX_BYTES) throw new Skip("too_large", path);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Skip("not_utf8", path);
      }
      const prepared = prepareTemplate(text);
      if (prepared === null) throw new Skip("unbalanced_comment", path);
      return {
        kind: "found",
        commit: head.commitSha,
        path,
        blobSha: entry.sha,
        template: prepared,
      };
    };

    for (const location of LOCATIONS) {
      const here = await locationTree(location);
      if (here === null) continue;
      const file = only(named(here.entries, (name) => name === SINGLE_NAME));
      if (file !== null) return await candidate(file, here.at);
    }
    for (const location of LOCATIONS) {
      const here = await locationTree(location);
      if (here === null) continue;
      const directory = only(
        named(here.entries, (name) => name === DIRECTORY_NAME),
      );
      if (directory === null || directory.type !== "tree") continue;
      const inside = await tree(directory.sha);
      const files = named(inside, (name) => name.endsWith(".md"));
      if (files.length === 0) continue;
      const matching = files.filter(
        (file) => file.name.toLowerCase() === wanted,
      );
      const chosen =
        files.length === 1
          ? files[0]
          : matching.length === 1
            ? matching[0]
            : undefined;
      if (chosen === undefined) {
        throw new Skip("multiple", recordedPath([...here.at, directory.name]));
      }
      return await candidate(chosen, [...here.at, directory.name]);
    }
    return { kind: "none", commit: head.commitSha };
  } catch (error) {
    if (error instanceof Skip) {
      return {
        kind: "skipped",
        commit,
        reason: error.reason,
        ...(error.path === undefined ? {} : { path: error.path }),
      };
    }
    return {
      kind: "skipped",
      commit,
      reason: "read_failed",
      error: error instanceof Error ? error.name : "error",
    };
  }
}

export function templateRecord(read: TemplateRead): PullRequestTemplateRecord {
  switch (read.kind) {
    case "found":
      return { commit: read.commit, path: read.path, blob_sha: read.blobSha };
    case "none":
      return { commit: read.commit };
    case "skipped":
      return {
        commit: read.commit,
        ...(read.path === undefined ? {} : { path: read.path }),
        skipped: read.reason,
      };
  }
}

// The joiners (U+200C, U+200D) stay: scripts and emoji need them.
const HIDDEN = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F",
    "\\u00AD\\u061C\\u180E\\u200B\\u200E\\u200F\\u2028\\u2029",
    "\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB",
    "\\u{E0000}-\\u{E007F}]",
  ].join(""),
  "gu",
);

function stripHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

type Part = { text: string; comment: boolean };

export type TemplateRow = {
  text: string;
  startsInComment: boolean;
  skippable: boolean;
  slot?: SectionName;
  heading?: string;
};

export type PreparedTemplate = { rows: readonly TemplateRow[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SLOT_LINE = /^<!--\s*werft:slot\s+([a-z]+)\s*-->$/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const BOLD_HEADING = /^ {0,3}(?:\*\*|__)([^*_].*?)(?:\*\*|__)[ \t]*:?[ \t]*$/;
const MARKUP = /<[A-Za-z/!?]/;
// A link in angle brackets; one holding a quote could be a tag's attribute.
const AUTOLINK =
  /<(?:[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'`]*|[^\s<>@"'`]+@[^\s<>"'`]+)>/g;
const TABLE_DELIMITER =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DEFINITION = /^ {0,3}\[[^\]\n]*\]:/;

function hasMarkup(text: string): boolean {
  return MARKUP.test(text.replace(AUTOLINK, " "));
}

// A comment the platform reads or whose text it writes itself: its own tail
// markers, and the identifiers it may add later. A template's comment cannot
// pass for one of them. The identifier is changed, not the comment's syntax, so
// whatever was hidden stays hidden.
const PLATFORM_COMMENT = /(<!--\s*\/?\s*)(werft)(:)(?!slot\b)/gi;
// Lines a squash merge reads as co-authors, and the session's own trailer.
const TRAILER_LINE = /^([ \t>]*)(co-authored-by|agent-session)(?=\s*:)/i;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

type Scanned = {
  rows: Array<{
    parts: Part[];
    startsInComment: boolean;
    code: boolean;
    indent: number;
  }>;
  rejected: boolean;
};

// A fence is accepted only at the start of a line. After indentation or a
// list or quote marker it may belong to a container, which ends where a
// renderer decides, not where this scan does.
const NESTED_FENCE =
  /^(?:[ \t]+|[ \t]*(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])[ \t]+)+)(?:`{3,}|~{3,})/;

function scan(text: string): Scanned {
  const rows: Scanned["rows"] = [];
  let fence: string | null = null;
  let inComment = false;
  let rejected = false;
  for (const line of text.split("\n")) {
    const row = {
      parts: [] as Part[],
      startsInComment: inComment,
      code: false,
      indent: indentOf(line),
    };
    rows.push(row);
    // A fence inside a list item or a quote is not tracked here. Markdown reads
    // `\/` as `/`, which would hide a path from the reference breaking.
    if (
      !inComment &&
      fence === null &&
      (NESTED_FENCE.test(line) || line.includes("\\/"))
    ) {
      rejected = true;
    }
    if (!inComment) {
      const marks = FENCE_OPEN.exec(line);
      if (fence !== null) {
        row.code = true;
        row.parts.push({ text: line, comment: false });
        if (hasMarkup(line)) rejected = true;
        const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1] ?? "";
        if (run !== "" && run[0] === fence[0] && run.length >= fence.length) {
          fence = null;
        }
        continue;
      }
      if (
        marks?.[1] !== undefined &&
        !(marks[1][0] === "`" && marks[2]?.includes("`"))
      ) {
        fence = marks[1];
        row.code = true;
        row.parts.push({ text: line, comment: false });
        if (hasMarkup(line)) rejected = true;
        continue;
      }
    }
    if (
      !inComment &&
      (DEFINITION.test(line) ||
        (line.includes("|") && TABLE_DELIMITER.test(line)))
    ) {
      rejected = true;
    }
    if (inComment || line.startsWith("<!--")) {
      // `<!-->` and `<!--->` end at once for some parsers and not for others.
      if (!inComment && (line.startsWith(">", 4) || line.startsWith("->", 4))) {
        rejected = true;
      }
      const close = line.indexOf("-->", inComment ? 0 : 4);
      const end = close === -1 ? line.length : close + 3;
      const chunk = line.slice(0, end);
      // Some parsers end a comment at `--!>`; the renderer here does not.
      if (chunk.includes("--!>")) rejected = true;
      if (close !== -1 && line.slice(end).trim() !== "") rejected = true;
      row.parts.push({ text: chunk, comment: true });
      inComment = close === -1;
      continue;
    }
    if (hasMarkup(line)) rejected = true;
    if (line !== "") row.parts.push({ text: line, comment: false });
  }
  return { rows, rejected: rejected || inComment };
}

/**
 * The template made inert, as rows. Null when it holds anything beyond
 * headings, plain text, lists, checkboxes, fences and comments of their own
 * rows, or a comment left open, which would hide the platform's tail. The
 * text is cleaned first and the cleaned text is what is judged and used, so
 * what is checked is what is sent.
 */
export function prepareTemplate(raw: string): PreparedTemplate | null {
  const cleaned = stripEngineSignatures(
    stripHidden(raw.replace(/\r\n?/g, "\n")),
  );
  const scanned = scan(cleaned);
  if (scanned.rejected) return null;

  const visible = scanned.rows
    .map((row) =>
      row.parts.map((part) => (part.comment ? " " : part.text)).join(""),
    )
    .join("\n");
  const broken = breakLinks(breakReferences(visible));
  const added: number[] = new Array(visible.length + 1).fill(0);
  let j = 0;
  for (let i = 0; i <= visible.length; i += 1) {
    while (broken[j] === ZWSP) {
      added[i] = (added[i] ?? 0) + 1;
      j += 1;
    }
    if (i < visible.length) {
      if (broken[j] !== visible[i]) {
        throw new Error("Template reference breaking changed its text");
      }
      j += 1;
    }
  }
  let offset = 0;
  const rows: TemplateRow[] = scanned.rows.map((row) => {
    let line = "";
    for (const part of row.parts) {
      if (part.comment) {
        line += breakLinks(breakReferences(part.text)).replace(
          PLATFORM_COMMENT,
          `$1$2${ZWSP}$3`,
        );
        offset += 1;
        continue;
      }
      for (const char of part.text) {
        line += ZWSP.repeat(added[offset] ?? 0) + char;
        offset += char.length;
      }
    }
    offset += 1;
    line = line.replace(
      TRAILER_LINE,
      (_, lead: string, word: string) =>
        `${lead}${word.slice(0, 1)}${ZWSP}${word.slice(1)}`,
    );
    const shown = row.parts
      .filter((part) => !part.comment)
      .map((part) => part.text)
      .join("");
    const result: TemplateRow = {
      text: line,
      startsInComment: row.startsInComment,
      skippable: !row.code && shown.trim() === "",
    };
    const fillable = !row.startsInComment && !row.code && row.indent <= 3;
    if (fillable) {
      const only = row.parts.length === 1 ? row.parts[0] : undefined;
      const slot = only?.comment ? SLOT_LINE.exec(only.text.trim()) : null;
      const field = slot?.[1];
      if (field !== undefined && isSection(field)) result.slot = field;
      const title =
        ATX_HEADING.exec(shown)?.[1] ?? BOLD_HEADING.exec(shown)?.[1];
      if (title !== undefined && result.slot === undefined) {
        result.heading = title;
      }
    }
    return result;
  });
  return { rows };
}

export type TemplateTextResult =
  | { ok: true; template: PreparedTemplate }
  | { ok: false; reason: "too_large" | "not_utf8" | "unsupported" };

export function prepareTemplateText(text: string): TemplateTextResult {
  // A lone surrogate cannot be written as UTF-8; a pair is one code point.
  // PostgreSQL text and jsonb cannot hold NUL either.
  if (/\p{Cs}/u.test(text) || text.includes("\u0000")) {
    return { ok: false, reason: "not_utf8" };
  }
  if (new TextEncoder().encode(text).length > TEMPLATE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const template = prepareTemplate(text);
  return template === null
    ? { ok: false, reason: "unsupported" }
    : { ok: true, template };
}

function isSection(name: string): name is SectionName {
  return (SECTION_NAMES as readonly string[]).includes(name);
}

const PHRASES: Record<SectionName, readonly string[]> = {
  summary: [
    "개요",
    "요약",
    "설명",
    "summary",
    "description",
    "overview",
    "概要",
    "説明",
  ],
  changes: [
    "변경 사항",
    "변경사항",
    "변경점",
    "작업 내용",
    "changes",
    "what changed",
    "変更点",
    "変更内容",
  ],
  rationale: [
    "배경",
    "이유",
    "목적",
    "동기",
    "why",
    "motivation",
    "background",
    "context",
    "背景",
    "目的",
  ],
  testing: [
    "테스트",
    "검증",
    "확인 방법",
    "test",
    "testing",
    "how to test",
    "verification",
    "テスト",
    "確認方法",
  ],
  related: ["관련 이슈", "이슈", "티켓", "related", "issue", "ticket", "関連"],
  notes: [
    "참고",
    "비고",
    "리뷰 포인트",
    "notes",
    "remarks",
    "reviewer",
    "備考",
  ],
};

function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|️|‍/gu, " ")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MATCHERS = SECTION_NAMES.flatMap((section) =>
  PHRASES[section].map((phrase) => {
    const norm = normalizeHeading(phrase);
    const escapedPhrase = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A Latin phrase is a word (a plural is the same word); CJK has no spaces.
    const latin = /^[a-z0-9 ]+$/.test(norm);
    return {
      section,
      length: norm.length,
      test: latin
        ? new RegExp(
            `(?<![\\p{L}\\p{N}])${escapedPhrase}s?(?![\\p{L}\\p{N}])`,
            "u",
          )
        : new RegExp(escapedPhrase, "u"),
    };
  }),
);

export function sectionOfHeading(heading: string): SectionName | null {
  const norm = normalizeHeading(heading);
  let best: { section: SectionName; length: number } | null = null;
  for (const matcher of MATCHERS) {
    if (!matcher.test.test(norm)) continue;
    if (best === null || matcher.length > best.length) {
      best = { section: matcher.section, length: matcher.length };
    }
  }
  return best?.section ?? null;
}

/**
 * The template with the fields put in, and nothing of it taken out. With slot
 * rows, only they place a field; otherwise a heading does. A field with no
 * place gets a section of the platform's own after the template; a template
 * with neither slot nor heading goes below the platform's default layout.
 */
export function fillTemplate(
  template: PreparedTemplate,
  blocks: SectionBlocks,
  headings: Record<SectionName, string>,
): string {
  const { rows } = template;
  const filled = SECTION_NAMES.filter((name) => (blocks[name] ?? "") !== "");
  const before = new Map<number, SectionName[]>();
  const placed = new Set<SectionName>();
  const put = (at: number, name: SectionName) => {
    placed.add(name);
    before.set(at, [...(before.get(at) ?? []), name]);
  };
  const bySlot = rows.some((row) => row.slot !== undefined);
  const claimed = new Set<SectionName>();
  rows.forEach((row, index) => {
    if (bySlot) {
      if (row.slot === undefined || claimed.has(row.slot)) return;
      claimed.add(row.slot);
      if (filled.includes(row.slot)) put(index + 1, row.slot);
      return;
    }
    if (row.heading === undefined) return;
    const name = sectionOfHeading(row.heading);
    if (name === null || claimed.has(name)) return;
    claimed.add(name);
    if (!filled.includes(name)) return;
    let at = index + 1;
    while (at < rows.length) {
      const next = rows[at];
      if (next === undefined || !next.skippable) break;
      at += 1;
    }
    if (rows[at]?.startsInComment) return;
    put(at, name);
  });

  const hasPlace = bySlot || rows.some((row) => row.heading !== undefined);
  const unplaced = filled.filter((name) => !placed.has(name));
  const section = (name: SectionName) =>
    `## ${headings[name]}\n${blocks[name]}`;
  if (!hasPlace && unplaced.length > 0) {
    const text = rows
      .map((row) => row.text)
      .join("\n")
      .trim();
    const top = unplaced.map(section).join("\n\n");
    return text === "" ? top : `${top}\n\n${text}`;
  }
  const out: string[] = [];
  const emit = (at: number) => {
    for (const name of before.get(at) ?? []) {
      if (out.length > 0 && (out.at(-1) ?? "").trim() !== "") out.push("");
      out.push(...(blocks[name] ?? "").split("\n"));
      if (at < rows.length && (rows[at]?.text ?? "").trim() !== "")
        out.push("");
    }
  };
  rows.forEach((row, index) => {
    emit(index);
    out.push(row.text);
  });
  emit(rows.length);
  const text = out.join("\n").trimEnd();
  if (unplaced.length === 0) return text;
  const closed = closeOpenBlocks(text);
  const tail = unplaced.map(section).join("\n\n");
  return closed === "" ? tail : `${closed}\n\n${tail}`;
}
