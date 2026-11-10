import { describe, expect, test } from "bun:test";
import type { Span } from "@werft-ai/observability";

import { setContentAttribute } from "./content.ts";

function recordingSpan() {
  const attributes: Record<string, unknown> = {};
  const span = {
    setAttribute: (key: string, value: unknown) => {
      attributes[key] = value;
    },
  } as unknown as Span;
  return { span, attributes };
}

const HIDDEN = "plum-marker-value";
const maskHidden = { mask: (text: string) => text.replaceAll(HIDDEN, "***") };

describe("setContentAttribute", () => {
  test("masks before cutting, so a value straddling the limit leaks no prefix", () => {
    const { span, attributes } = recordingSpan();
    // The limit lands in the middle of the hidden value.
    const value = `${"x".repeat(10)}${HIDDEN}${"y".repeat(10)}`;

    setContentAttribute(
      span,
      "k",
      value,
      { mode: "full", maxBytes: 20 },
      maskHidden,
    );

    expect(String(attributes.k)).not.toContain("plum");
    expect(attributes["werft.truncated.k"]).toBe(
      value.length - HIDDEN.length + 3,
    );
  });

  test("masks the raw strings, so JSON escaping cannot hide a value from its pattern", () => {
    const { span, attributes } = recordingSpan();
    const tricky = 'plum"marker\\value';
    const masker = { mask: (text: string) => text.replaceAll(tricky, "***") };

    setContentAttribute(
      span,
      "k",
      [
        {
          role: "user",
          content: `say ${tricky}`,
          args: { [tricky]: [tricky] },
        },
      ],
      { mode: "full", maxBytes: 1_000 },
      masker,
    );

    const text = String(attributes.k);
    expect(text).not.toContain("plum");
    expect(JSON.parse(text)).toEqual([
      { role: "user", content: "say ***", args: { "***": ["***"] } },
    ]);
  });

  test("sets nothing in metadata mode", () => {
    const { span, attributes } = recordingSpan();
    setContentAttribute(
      span,
      "k",
      "hello",
      { mode: "metadata", maxBytes: 20 },
      maskHidden,
    );
    expect(attributes).toEqual({});
  });
});
