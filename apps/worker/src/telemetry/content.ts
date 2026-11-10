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

// Mask before cutting: a secret cut in half would escape its pattern.
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

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
