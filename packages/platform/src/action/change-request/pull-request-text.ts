// Text that reaches a pull request is partly the agent's, and GitHub acts on
// it: a mention notifies, a cross-reference links another repository, a
// closing keyword closes an issue on merge, and an HTML comment hides text
// from the reader. A zero-width space keeps each visible but inert.

const ZWSP = "​";
export const PULL_REQUEST_TITLE_MAX = 256;
const TRUNCATED = "\n\n…(truncated)";
const REDACTED_LINE = "[REDACTED]";
const keyBegin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const keyEnd = /-----END [A-Z ]*PRIVATE KEY-----/;
// Credential shapes a forge or chat hands out that the shared redactor does
// not know, checked before it.
const credentialLine = /github_pat_\w|\bxox[a-z]-\w/;

const closingKeyword =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)(?=#\d|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d|https?:\/\/)/gi;
const crossReference = /\b([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d)/g;
const mention = /(^|[^\w])@([A-Za-z0-9])/g;

export function breakReferences(text: string): string {
  return text
    .replace(
      closingKeyword,
      (_, word: string, gap: string) =>
        `${word[0]}${ZWSP}${word.slice(1)}${gap}`,
    )
    .replace(crossReference, `$1#${ZWSP}$2`)
    .replace(mention, `$1@${ZWSP}$2`);
}

export function neutralizeReferences(text: string): string {
  return breakReferences(text).replaceAll("<!--", `<!${ZWSP}--`);
}

// Lines an engine appends to a pull request body on its own (Claude Code's
// default). Removed only when the whole line matches.
const ENGINE_SIGNATURE_LINES: ReadonlySet<string> = new Set([
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  "🤖 Generated with [Claude Code](https://claude.ai/code)",
  "Generated with [Claude Code](https://claude.com/claude-code)",
  "Generated with [Claude Code](https://claude.ai/code)",
]);

/** `text` without the engine's own signature lines, and the blank run they leave at the end. */
export function stripEngineSignatures(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter(
    // Only a CRLF's `\r` is ignored: a line with anything else added is not the signature.
    (line) => !ENGINE_SIGNATURE_LINES.has(line.replace(/\r$/, "")),
  );
  if (kept.length === lines.length) return text;
  return kept.join("\n").trimEnd();
}

export function cut(text: string, max: number, suffix: string): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, Math.max(0, max - suffix.length));
  // Never leave half of a surrogate pair at the cut.
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${suffix}`;
}

/**
 * A body or comment as the forge may take it: each line through `redact`
 * (a secret-shaped line becomes a placeholder), references neutralized,
 * cut to `max` characters.
 */
export function cleanBody(
  text: string,
  max: number,
  redact: (line: string) => string,
): string {
  return cleanBodies([text], max, redact)[0] ?? "";
}

/**
 * Several texts of one body, cleaned as `cleanBody` does each, with a private
 * key block that starts in one staying hidden through the next ones: a key
 * split over fields or list items is not a key per piece.
 */
export function cleanBodies(
  texts: readonly string[],
  max: number,
  redact: (line: string) => string,
): string[] {
  const redactLine = lineRedactor(redact);
  return texts.map((text) => {
    const redacted = text.split("\n").map(redactLine).join("\n");
    return cut(neutralizeReferences(redacted), max, TRUNCATED);
  });
}

export function lineRedactor(
  redact: (line: string) => string,
): (line: string) => string {
  let inKey = false;
  return (line) => {
    if (keyBegin.test(line)) inKey = true;
    const hidden = inKey || credentialLine.test(line);
    if (keyEnd.test(line)) inKey = false;
    return hidden ? REDACTED_LINE : redact(line);
  };
}

/** One line, redacted and neutralized, at most `PULL_REQUEST_TITLE_MAX`. */
export function cleanTitle(
  text: string,
  redact: (line: string) => string,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const line =
    keyBegin.test(flat) || credentialLine.test(flat)
      ? REDACTED_LINE
      : redact(flat);
  return cut(neutralizeReferences(line), PULL_REQUEST_TITLE_MAX, "…");
}
