/**
 * What every process's log keeps out: sensitive keys, secret-shaped values,
 * the login in a URL and, unless asked for, message bodies.
 *
 * No imports, so the egress proxy, whose image installs nothing, runs the
 * same rules: apps/egress-proxy/src/redaction.ts is a byte-for-byte copy,
 * and apps/egress-proxy/src/logger.test.ts fails when the two differ.
 */

export const REDACTED = "[REDACTED]";

const sensitiveKey =
  /(?:authorization|token|secret|password|credential|api[-_]?key|access[-_]?key|private[-_]?key)/i;
const messageBodyKey =
  /(?:message|body|content|prompt|input|output|transcript)/i;
const secretValue =
  /(?:\bbearer\s+\S+|\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16})\b)/i;
const sensitiveText =
  /(?:\b(?:authorization|token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key)\b\s*[:=]|\b(?:(?:request|response)[-_ ]?)?(?:message|body|content|prompt|input|output|transcript)\b\s*[:=])/i;
// Only the login goes: the rest of the URL is what says which call failed.
// Up to the authority's last `@`, as a URL parser reads an unescaped one in
// the password. The scheme is bounded so a long dotted word cannot make
// this quadratic.
const urlLogin = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]*@/gi;

export type LogFields = Readonly<Record<string, unknown>>;

export function sanitizeText(value: string): string {
  const text = value.replace(urlLogin, `$1${REDACTED}@`);
  return secretValue.test(text) || sensitiveText.test(text) ? REDACTED : text;
}

const secretValues = new RegExp(secretValue.source, "gi");
const lineBreak = /(\r\n|\r|\n)/;

/**
 * A multi-line value (a stack, a failed worker's log tail) loses only what
 * the rules point at, so the lines before it that say why a process failed
 * survive. A secret-shaped value has an end: the lines it spans go. A key such as
 * `password:` or `input:` does not say where its value ends, so every line
 * from it on goes. Hidden lines in a row become one `[REDACTED]`.
 */
function sanitizeLines(value: string): string {
  const text = value.replace(urlLogin, `$1${REDACTED}@`);
  const named = sensitiveText.exec(text);
  if (named === null && !secretValue.test(text)) return text;

  const cut =
    named === null
      ? text.length
      : Math.max(
          text.lastIndexOf("\n", named.index - 1),
          text.lastIndexOf("\r", named.index - 1),
        ) + 1;
  // In order and apart, so one pass over the lines reads them.
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(secretValues)) {
    if (match.index >= cut) break;
    ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.push([cut, Number.POSITIVE_INFINITY]);

  // Alternates line, break, line, …
  const parts = text.split(lineBreak);
  let out = "";
  let at = 0;
  let next = 0;
  let hiding = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "";
    const end = at + line.length;
    while ((ranges[next]?.[1] ?? Number.POSITIVE_INFINITY) <= at) next++;
    const range = ranges[next];
    const hide = range !== undefined && range[0] < end && range[1] > at;
    if (!(hide && hiding)) {
      out += (i === 0 ? "" : parts[i - 1]) + (hide ? REDACTED : line);
    }
    hiding = hide;
    at = end + (parts[i + 1]?.length ?? 0);
  }
  return out;
}

function sanitizeValue(value: unknown, includeMessageBodies: boolean): unknown {
  if (typeof value === "string") {
    return sanitizeLines(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, includeMessageBodies));
  }

  if (value !== null && typeof value === "object") {
    return sanitizeFields(
      value as Readonly<Record<string, unknown>>,
      includeMessageBodies,
    );
  }

  return value;
}

export function sanitizeFields(
  fields: LogFields,
  includeMessageBodies = false,
): LogFields {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (sensitiveKey.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }
    if (!includeMessageBodies && messageBodyKey.test(key)) {
      continue;
    }
    sanitized[key] = sanitizeValue(value, includeMessageBodies);
  }

  return sanitized;
}
