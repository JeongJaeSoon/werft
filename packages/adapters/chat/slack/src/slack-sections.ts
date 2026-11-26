import { urlEnd } from "./slack-mrkdwn.ts";
import { isSafeLink, mapCodeAndText } from "./slack-presentation.ts";

// A section's text may not pass 3000 characters.
const SECTION_TEXT_MAX = 3_000;
const FENCE = "```";

// A control, or a bare URL up to what cannot be part of one: a space, a
// bracket (escaped or not), a pipe or a backtick.
const CONTROL_OR_URL = /<[^<>\n]*>|https?:\/\/(?:(?!&lt;|&gt;)[^\s<>|`])+/g;

// A section reads `#channel` and `@name` as links unless verbatim, which also
// leaves a bare URL as text: each goes in brackets, as a post's text links it.
const linkBareUrls = (text: string) =>
  mapCodeAndText(
    text,
    (part) =>
      part.replace(CONTROL_OR_URL, (found) => {
        if (found.startsWith("<")) return found;
        let end = urlEnd(found);
        // The `;` that ends an escape such as `&amp;` is no punctuation.
        if (found[end] === ";" && /&[a-z]+$/.test(found.slice(0, end)))
          end += 1;
        const url = found.slice(0, end);
        return isSafeLink(url) ? `<${url}>${found.slice(end)}` : found;
      }),
    (code) => code,
  );

type Span = { start: number; end: number; mark: string };

/** Where the text's code is, as the escaping reads it. */
function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  mapCodeAndText(
    text,
    (part) => {
      at += part.length;
      return part;
    },
    (code) => {
      const mark = code.startsWith(FENCE) ? FENCE : "`";
      spans.push({ start: at, end: at + code.length, mark });
      at += code.length;
      return code;
    },
  );
  return spans;
}

/**
 * Where the piece from `from` ends, at or before `max`, and whether the
 * character there is a break the next piece leaves out. Null when no cut is
 * safe.
 */
function cutAt(
  text: string,
  spans: Span[],
  from: number,
  max: number,
): { end: number; skip: 0 | 1 } | null {
  const line = text.lastIndexOf("\n", max);
  if (line > from) return { end: line, skip: 1 };
  const space = text.lastIndexOf(" ", max);
  let end = space > from ? space : max;
  // Not inside a control, an escape such as `&lt;`, inline code that fits a
  // piece of its own, a fence's backticks or a surrogate pair.
  const open = text.lastIndexOf("<", end - 1);
  if (open >= from && open > text.lastIndexOf(">", end - 1)) end = open;
  const amp = text.lastIndexOf("&", end - 1);
  if (amp >= from && amp > end - 6 && !text.slice(amp, end).includes(";")) {
    end = amp;
  }
  const inline = spans.find(
    (span) => span.mark === "`" && span.start < end && end < span.end,
  );
  if (inline !== undefined && inline.start > from) end = inline.start;
  while (end > from && text[end - 1] === "`" && text[end] === "`") end -= 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  if (end <= from) return null;
  return { end, skip: text[end] === " " ? 1 : 0 };
}

/**
 * A post's escaped mrkdwn as sections that read as its text did, cut at line
 * ends where it can and inside a long line where it cannot, code cut open
 * closed and opened again. Null when it cannot be cut.
 */
export function slackTextSections(text: string): unknown[] | null {
  const linked = linkBareUrls(text);
  const spans = codeSpans(linked);
  const pieces: string[] = [];
  let from = 0;
  let reopen = "";
  while (reopen.length + linked.length - from > SECTION_TEXT_MAX) {
    // Room for the fence this piece may have to close.
    const room = SECTION_TEXT_MAX - reopen.length - FENCE.length - 1;
    const cut = cutAt(linked, spans, from, from + room);
    if (cut === null) return null;
    const { end, skip } = cut;
    const inside = spans.find((span) => span.start < end && end < span.end);
    const close =
      inside === undefined
        ? ""
        : inside.mark === FENCE
          ? `\n${FENCE}`
          : inside.mark;
    pieces.push(reopen + linked.slice(from, end) + close);
    reopen =
      inside === undefined
        ? ""
        : inside.mark === FENCE
          ? `${FENCE}\n`
          : inside.mark;
    from = end + skip;
  }
  pieces.push(reopen + linked.slice(from));
  // A section of nothing but space is refused.
  return pieces
    .filter((piece) => piece.trim() !== "")
    .map((piece) => ({
      type: "section",
      text: { type: "mrkdwn", text: piece, verbatim: true },
    }));
}
