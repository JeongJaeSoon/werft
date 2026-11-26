import { urlEnd } from "./slack-mrkdwn.ts";
import { isSafeLink, mapCodeAndText } from "./slack-presentation.ts";

// A section's text may not pass 3000 characters.
const SECTION_TEXT_MAX = 3_000;
const FENCE = "```";

// A section reads `#channel` and `@name` as links unless verbatim, which also
// leaves a bare URL as text: each goes in brackets, as a post's text links it.
const linkBareUrls = (text: string) =>
  mapCodeAndText(
    text,
    (part) =>
      part.replace(/<[^<>\n]*>|https?:\/\/[^\s<>|]+/g, (found) => {
        if (found.startsWith("<")) return found;
        const url = found.slice(0, urlEnd(found));
        return isSafeLink(url) ? `<${url}>${found.slice(url.length)}` : found;
      }),
    (code) => code,
  );

/** Where to cut `text` at or before `max`; 0 when no cut is safe. */
function cutAt(text: string, max: number): number {
  const line = text.lastIndexOf("\n", max);
  if (line > 0) return line;
  const space = text.lastIndexOf(" ", max);
  let cut = space > 0 ? space : max;
  // Not inside a control, an escape such as `&lt;`, a fence's backticks or a
  // surrogate pair.
  const open = text.lastIndexOf("<", cut - 1);
  if (open > text.lastIndexOf(">", cut - 1)) cut = open;
  const amp = text.lastIndexOf("&", cut - 1);
  if (amp !== -1 && amp > cut - 6 && !text.slice(amp, cut).includes(";")) {
    cut = amp;
  }
  while (cut > 0 && text[cut - 1] === "`" && text[cut] === "`") cut -= 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return Math.max(cut, 0);
}

/**
 * A post's escaped mrkdwn as sections that read as its text did, cut at line
 * ends where it can and inside a long line where it cannot, a code fence
 * closed and opened again across a cut. Null when one cannot be cut.
 */
export function slackTextSections(text: string): unknown[] | null {
  const pieces: string[] = [];
  let rest = linkBareUrls(text);
  let reopen = "";
  while (reopen.length + rest.length > SECTION_TEXT_MAX) {
    // Room for the fence this piece may have to close.
    const cut = cutAt(
      rest,
      SECTION_TEXT_MAX - reopen.length - FENCE.length - 1,
    );
    if (cut === 0) return null;
    const piece = reopen + rest.slice(0, cut);
    const fenced = piece.split(FENCE).length % 2 === 0;
    pieces.push(fenced ? `${piece}\n${FENCE}` : piece);
    reopen = fenced ? `${FENCE}\n` : "";
    rest = rest.slice(/\s/.test(rest[cut] ?? "") ? cut + 1 : cut);
  }
  pieces.push(reopen + rest);
  // A section of nothing but space is refused.
  return pieces
    .filter((piece) => piece.trim() !== "")
    .map((piece) => ({
      type: "section",
      text: { type: "mrkdwn", text: piece, verbatim: true },
    }));
}
