import type { Span } from "@werft-ai/observability";

export interface ContentMasker {
  mask(text: string): string;
}

export interface ContentPolicy {
  readonly mode: "full" | "metadata";
  readonly maxBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; originalBytes: number; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { text, originalBytes: bytes.byteLength, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return {
    text: decoder.decode(bytes.subarray(0, end)),
    originalBytes: bytes.byteLength,
    truncated: true,
  };
}

function maskLeaves(value: unknown, masker: ContentMasker): unknown {
  if (typeof value === "string") return masker.mask(value);
  if (Array.isArray(value))
    return value.map((item) => maskLeaves(item, masker));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        masker.mask(name),
        maskLeaves(item, masker),
      ]),
    );
  }
  return value;
}

/**
 * Text for an attribute, masked on the raw strings: JSON escaping a quote or a
 * backslash would otherwise hide a secret from its pattern.
 */
export function maskedText(value: unknown, masker: ContentMasker): string {
  if (typeof value === "string") return masker.mask(value);
  try {
    return JSON.stringify(maskLeaves(value, masker)) ?? "";
  } catch {
    return "";
  }
}

// Mask before cutting: a secret cut in half would escape its pattern.
export function setContentAttribute(
  span: Span,
  key: string,
  value: unknown,
  policy: ContentPolicy,
  masker: ContentMasker,
): void {
  if (policy.mode !== "full") return;
  const cut = truncateUtf8(maskedText(value, masker), policy.maxBytes);
  span.setAttribute(key, cut.text);
  if (cut.truncated)
    span.setAttribute(`werft.truncated.${key}`, cut.originalBytes);
}
