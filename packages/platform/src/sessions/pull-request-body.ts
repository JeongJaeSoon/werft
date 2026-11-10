import type { RelatedIssue, UserLocale } from "@werft-ai/contracts";
import { repoRefOf } from "../action/ports/forge.ts";
import { closeOpenBlocks, withPullRequestTail } from "./git-attribution.ts";
import {
  fillTemplate,
  type PreparedTemplate,
  SECTION_NAMES,
  type SectionBlocks,
  type SectionName,
} from "./pull-request-template.ts";
import {
  cleanBodies,
  cut,
  lineRedactor,
  stripEngineSignatures,
} from "./pull-request-text.ts";

/** The fields the agent gives, before the platform lays them out. */
export type PullRequestFields = {
  summary?: string | undefined;
  changes?: readonly string[] | undefined;
  rationale?: string | undefined;
  testing?: string | undefined;
  notes?: string | undefined;
  related?: readonly RelatedIssue[] | undefined;
};

const HEADINGS: Record<UserLocale, Record<SectionName, string>> = {
  ko: {
    summary: "요약",
    changes: "변경 사항",
    rationale: "배경",
    testing: "테스트",
    related: "관련 이슈",
    notes: "참고",
  },
  en: {
    summary: "Summary",
    changes: "Changes",
    rationale: "Background",
    testing: "Testing",
    related: "Related issues",
    notes: "Notes",
  },
  ja: {
    summary: "概要",
    changes: "変更点",
    rationale: "背景",
    testing: "テスト",
    related: "関連イシュー",
    notes: "備考",
  },
};

const OMITTED: Record<UserLocale, string> = {
  ko: "…(생략)",
  en: "…(omitted)",
  ja: "…(省略)",
};

// The order a body too long for the forge gives text up: the least central
// first.
const SHRINK_ORDER = [
  "notes",
  "testing",
  "rationale",
  "changes",
  "summary",
] as const;
type ShrinkField = (typeof SHRINK_ORDER)[number];

const MAX_RELATED_REPOSITORY_NAME = 140;

/**
 * The line a `related` item becomes, or null when the platform cannot name
 * it. Only the pull request's own repository's issue is closed; any other is
 * referenced. The reference is built here from validated parts, never from
 * agent text, so it is the one place a closing keyword or a cross-reference
 * is written on purpose.
 */
function relatedLine(
  item: RelatedIssue,
  repository: {
    id: string;
    repositories: Readonly<Record<string, { url: string }>>;
  },
): string | null {
  const own =
    item.repository_id === undefined || item.repository_id === repository.id;
  if (own) return `${item.closes ? "Closes" : "Refs"} #${item.number}`;
  const id = item.repository_id ?? "";
  const entry = Object.hasOwn(repository.repositories, id)
    ? repository.repositories[id]
    : undefined;
  const ref = entry === undefined ? null : repoRefOf(entry.url);
  if (ref === null) return null;
  const name = `${ref.owner}/${ref.name}`;
  if (name.length > MAX_RELATED_REPOSITORY_NAME) return null;
  return `Refs ${name}#${item.number}`;
}

type Cleaned = {
  summary: string;
  changes: string[];
  rationale: string;
  testing: string;
  notes: string;
  related: string[];
};

function blocksOf(fields: Cleaned): SectionBlocks {
  const bullets = (items: readonly string[]) =>
    items.map((item) => `- ${item}`).join("\n");
  return {
    summary: fields.summary,
    changes: bullets(fields.changes),
    rationale: fields.rationale,
    testing: fields.testing,
    related: bullets(fields.related),
    notes: fields.notes,
  };
}

function assemble(
  fields: Cleaned,
  locale: UserLocale,
  template: PreparedTemplate | null,
): string {
  const headings = HEADINGS[locale];
  const blocks = blocksOf(fields);
  if (template !== null) return fillTemplate(template, blocks, headings);
  return SECTION_NAMES.filter((name) => (blocks[name] ?? "") !== "")
    .map((name) => `## ${headings[name]}\n${blocks[name]}`)
    .join("\n\n");
}

const ZWSP = "​";

/**
 * A change item as one bullet line. A zero-width space in front keeps the text
 * from starting a block inside the bullet (fence, rule, heading, quote, list,
 * checkbox, link definition, HTML), each of which would hide the text or take
 * in the next item or the tail. It is not whitespace to Markdown.
 */
function oneLine(item: string): string {
  const line = item.replace(/\s*\n\s*/g, " ");
  return line === "" ? "" : `${ZWSP}${line}`;
}

// Slack for the closing text a cut may add.
const CLOSING_ROOM = 16;

/**
 * What starts HTML in Markdown: a tag, a closing tag, a processing instruction,
 * a declaration, CDATA. An HTML block runs on past the next section and the
 * tail, and each kind ends differently, so fields carry none: a zero-width
 * space after the `<` leaves the text as it reads. (Comments are already
 * broken by the cleaning.)
 */
const HTML_START = new RegExp(`<(?=[A-Za-z/?]|!(?!${ZWSP}))`, "g");

/** Each text cleaned in order (a private key block carries over). */
function cleanAll(
  values: readonly string[],
  redact: (line: string) => string,
): string[] {
  return cleanBodies(
    values.map((value) =>
      // A lone CR also ends a line for Markdown.
      stripEngineSignatures(value.replace(/\r\n?/g, "\n")),
    ),
    Number.MAX_SAFE_INTEGER,
    redact,
  ).map((text) => fenceSafe(text.trim().replace(HTML_START, `<${ZWSP}`)));
}

const FENCE_RUN = /`{3,}|~{3,}/g;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const breakRun = (run: string) => [...run].join(ZWSP);

// A task item with no text, in a list, a quote or both, takes the next line
// into itself in the renderer.
const EMPTY_TASK =
  /^((?:[ \t>]|[-*+]\s|\d+[.)]\s)*(?:[-*+]|\d+[.)])\s+\[[ xX]\])\s*$/;

/**
 * A field's code fences, made safe whatever Markdown makes of the text around
 * them. A fence is kept only as a pair, on a line of its own after a blank line
 * (one is added), at the left edge: an opening with no closing line is text, so
 * no closing fence is ever added that a renderer could read as the opening of a
 * new block. The closing is the first line a renderer would take as one. Every
 * other run of three or more backticks or tildes is broken with zero-width
 * spaces, so a fence in a list item, a quote, a table or an indented block does
 * not exist.
 */
function fenceSafe(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const plain = (line: string) =>
    line.replace(FENCE_RUN, breakRun).replace(EMPTY_TASK, `$1 ${ZWSP}`);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = open?.[1] ?? "";
    const info = open?.[2] ?? "";
    let close = -1;
    // A backtick fence's info string has no backtick: that line is inline code.
    if (open !== null && !(marks[0] === "`" && info.includes("`"))) {
      const closing = new RegExp(
        `^ {0,3}[${marks[0]}]{${marks.length},}[ \\t]*$`,
      );
      close = lines.findIndex(
        (candidate, i) => i > at && closing.test(candidate),
      );
    }
    if (close === -1) {
      out.push(plain(line));
      continue;
    }
    if (out.length > 0 && out.at(-1) !== "") out.push("");
    out.push(`${marks}${info.replace(FENCE_RUN, breakRun)}`);
    for (let i = at + 1; i < close; i += 1) out.push(lines[i] ?? "");
    out.push((lines[close] ?? "").trim());
    at = close;
  }
  return out.join("\n");
}

/**
 * `value` cut by at least `overflow` characters, closing included, or empty
 * when that cannot be done: a fence that closes with a run as long as its
 * opening would otherwise make a cut longer than what it cut.
 */
function shrunk(value: string, overflow: number, marker: string): string {
  const room = value.length - overflow - CLOSING_ROOM;
  if (room <= marker.length) return "";
  const next = closeOpenBlocks(cut(value, room, marker));
  return next.length <= value.length - overflow ? next : "";
}

/**
 * The platform's default body for structured fields: a heading per field that
 * has content, in the workspace's language, then the tail. Every field goes
 * through the same cleaning as a legacy body. The length is judged on the
 * final string, tail included: while it is over `maxLength`, text is cut from
 * `notes`, `testing`, `rationale`, `changes` (last item first) and `summary`,
 * in that order, leaving a marker where it was cut.
 */
export function renderPullRequestBody(input: {
  fields: PullRequestFields;
  locale: UserLocale;
  tail: string;
  maxLength: number;
  redact: (line: string) => string;
  repository: {
    id: string;
    repositories: Readonly<Record<string, { url: string }>>;
  };
  template?: PreparedTemplate | null | undefined;
}): { body: string; relatedDropped: number; templateUsed: boolean } {
  const { fields, locale, tail, maxLength, redact } = input;
  const redactRow = lineRedactor(redact);
  let template: PreparedTemplate | null =
    input.template == null
      ? null
      : {
          rows: input.template.rows.map((row) => ({
            ...row,
            text: redactRow(row.text),
          })),
        };
  // The validation judged the comment boundaries on the text as read. A row
  // inside or at the edge of a comment that redaction rewrote may have lost
  // its `-->` (or its `<!--`), and a rewritten fence line may have lost its
  // marker, so a closing fence would open one: the checked structure no longer
  // holds.
  if (
    template !== null &&
    input.template != null &&
    input.template.rows.some(
      (row, at) =>
        row.text !== template?.rows[at]?.text &&
        (row.startsInComment ||
          FENCE_LINE.test(row.text) ||
          row.text.includes("<!--") ||
          row.text.includes("-->")),
    )
  ) {
    template = null;
  }
  const related: string[] = [];
  let relatedDropped = 0;
  for (const item of fields.related ?? []) {
    const line = relatedLine(item, input.repository);
    if (line === null) relatedDropped += 1;
    else if (!related.includes(line)) related.push(line);
  }
  // In the order they appear in the body.
  const changeCount = fields.changes?.length ?? 0;
  const texts = cleanAll(
    [
      fields.summary ?? "",
      ...(fields.changes ?? []),
      fields.rationale ?? "",
      fields.testing ?? "",
      fields.notes ?? "",
    ],
    redact,
  );
  // A text that leaves a fence or element open is closed, so what follows it
  // is not swallowed. An item of `changes` is one line: a fence in a bullet
  // would be read as the start of a block the tail then falls into.
  const block = (at: number) => closeOpenBlocks(texts[at] ?? "");
  const cleaned: Cleaned = {
    summary: block(0),
    changes: texts
      .slice(1, 1 + changeCount)
      .map((change) => oneLine(change))
      .filter((change) => change !== ""),
    rationale: block(1 + changeCount),
    testing: block(2 + changeCount),
    notes: block(3 + changeCount),
    related,
  };
  const marker = OMITTED[locale];
  const render = () =>
    withPullRequestTail(assemble(cleaned, locale, template), tail);
  let body = render();
  const shrinkable = (field: ShrinkField) =>
    field === "changes" ? cleaned.changes.length > 0 : cleaned[field] !== "";
  while (body.length > maxLength) {
    const field = SHRINK_ORDER.find(shrinkable);
    if (field === undefined) {
      if (template !== null) {
        template = null;
        return renderPullRequestBody({ ...input, template: null });
      }
      // Only the platform's own lines are left over the limit.
      return {
        body: cut(body, maxLength, ""),
        relatedDropped,
        templateUsed: false,
      };
    }
    const overflow = body.length - maxLength;
    if (field === "changes") {
      const last = cleaned.changes.at(-1) ?? "";
      if (last.length - overflow > marker.length) {
        cleaned.changes[cleaned.changes.length - 1] = cut(
          last,
          last.length - overflow,
          marker,
        );
      } else {
        cleaned.changes.pop();
      }
    } else {
      cleaned[field] = shrunk(cleaned[field], overflow, marker);
    }
    body = render();
  }
  return { body, relatedDropped, templateUsed: template !== null };
}
