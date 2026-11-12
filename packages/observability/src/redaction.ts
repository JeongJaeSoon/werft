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

function sanitizeValue(value: unknown, includeMessageBodies: boolean): unknown {
  if (typeof value === "string") {
    // Line by line, so one matching line of a stack or a log tail does not
    // hide the lines that say why the process failed.
    return value.replace(/[^\r\n]+/g, (line) => sanitizeText(line));
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
