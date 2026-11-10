import type { Span } from "@werft-ai/observability";

/**
 * What the span code needs from masking, and nothing more. The worker's
 * `SecretScrubber` is the implementation today; a pattern-based masker joins
 * it behind this port without the span code changing.
 */
export interface ContentMasker {
  mask(text: string): string;
}

/** How much of a turn's content its spans may carry, from the claim and `nextInput`. */
export interface ContentPolicy {
  readonly mode: "full" | "metadata";
  /** UTF-8 bytes per attribute. */
  readonly maxBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character,
 * and says how many bytes the whole text had. A cut that lands inside a
 * multi-byte character drops that character entirely.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; originalBytes: number; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { text, originalBytes: bytes.byteLength, truncated: false };
  }
  let end = maxBytes;
  // A continuation byte is 10xxxxxx: step back to the lead byte of the cut character.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return {
    text: decoder.decode(bytes.subarray(0, end)),
    originalBytes: bytes.byteLength,
    truncated: true,
  };
}

/**
 * Puts one content attribute on `span` under the turn's policy: nothing at
 * all in `metadata` mode; otherwise masked first (a secret cut in half would
 * escape its pattern) and then cut to the byte limit, with the original size
 * under `werft.truncated.<key>`.
 */
export function setContentAttribute(
  span: Span,
  key: string,
  value: string,
  policy: ContentPolicy,
  masker: ContentMasker,
): void {
  if (policy.mode !== "full") return;
  const cut = truncateUtf8(masker.mask(value), policy.maxBytes);
  span.setAttribute(key, cut.text);
  if (cut.truncated)
    span.setAttribute(`werft.truncated.${key}`, cut.originalBytes);
}

/** Content that is not already text goes in as JSON. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
