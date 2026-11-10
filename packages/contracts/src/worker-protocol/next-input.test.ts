import { describe, expect, test } from "bun:test";
import { nextInputResponseSchema } from "./index.ts";

const input = {
  turn_id: "1",
  input_id: "7",
  message: "go",
  delivery_started_at: "2026-11-10T00:00:00.000Z",
};
const response = (extra: Record<string, unknown> = {}) => ({
  input: { ...input, ...extra },
  lease_expires_at: "2026-11-10T00:00:30.000Z",
});

describe("nextInputResponseSchema trace_context", () => {
  test("an answer without the field still parses, as older control hosts send it", () => {
    const parsed = nextInputResponseSchema.parse(response());
    expect(parsed.input?.trace_context).toBeUndefined();
  });

  test("carries a version 00 traceparent through", () => {
    const traceparent =
      "00-49195af5635b4ac7af24c52c73de7491-b7ad6b7169203331-01";
    expect(
      nextInputResponseSchema.parse(response({ trace_context: traceparent }))
        .input?.trace_context,
    ).toBe(traceparent);
  });

  test("refuses text that is not a traceparent", () => {
    for (const bad of ["", "not-a-traceparent", "00-ABC-def-01"]) {
      expect(() =>
        nextInputResponseSchema.parse(response({ trace_context: bad })),
      ).toThrow();
    }
  });
});
