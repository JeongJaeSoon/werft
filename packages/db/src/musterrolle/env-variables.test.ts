import { describe, expect, test } from "bun:test";
import { ENV_SESSION_VALUES_MAX_BYTES } from "@werft-ai/contracts";
import {
  ENV_START_RETENTION_MS,
  envStartRefusal,
  plainEnvOf,
  UNREADABLE_ENV_START,
} from "./env-variables.ts";

const NOW = new Date("2026-11-09T00:00:00.000Z");
const CAPTURED = "2026-11-08T00:00:00.000Z";

const plain = (name: string, value: string) => ({
  name,
  scope: "agent",
  kind: "plain",
  version: 1,
  value,
});
const snapshot = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  entries,
  skipped: [],
  captured_at: CAPTURED,
  ...over,
});

describe("the claim's judgement of a session's variable snapshot", () => {
  test("a session without a snapshot is not refused", () => {
    expect(envStartRefusal(null, NOW)).toBeNull();
    expect(envStartRefusal(undefined, NOW)).toBeNull();
  });

  test("a snapshot of allowed names passes, and so does one with a field a later build adds", () => {
    const entries = [plain("API_URL", "https://example.invalid")];
    expect(envStartRefusal(snapshot(entries), NOW)).toBeNull();
    expect(envStartRefusal(snapshot(entries, { later: 1 }), NOW)).toBeNull();
  });

  test("a name the platform reserves is refused, even one stored before it was", () => {
    expect(envStartRefusal(snapshot([plain("PATH", "/tmp")]), NOW)).toBe(
      "reserved_name",
    );
    expect(
      envStartRefusal(snapshot([plain("ANTHROPIC_API_KEY", "x")]), NOW),
    ).toBe("reserved_name");
  });

  test("a name that is no variable name at all is refused like a reserved one", () => {
    expect(envStartRefusal(snapshot([plain("lower_case", "v")]), NOW)).toBe(
      "reserved_name",
    );
  });

  test("values over the session limit are refused by UTF-8 bytes", () => {
    // 3 bytes per character: under the limit as characters, over it as bytes.
    const half = "가".repeat(
      Math.ceil(ENV_SESSION_VALUES_MAX_BYTES / 3 / 2) + 1,
    );
    expect(half.length).toBeLessThan(ENV_SESSION_VALUES_MAX_BYTES);
    expect(
      envStartRefusal(
        snapshot([plain("A_ONE", half), plain("B_TWO", half)]),
        NOW,
      ),
    ).toBe("too_large");
  });

  test.each([
    ["not an object", "nope"],
    [
      "entries is not a list",
      { entries: "nope", skipped: [], captured_at: CAPTURED },
    ],
    ["no captured_at", { entries: [], skipped: [] }],
    ["captured_at is not a time", snapshot([], { captured_at: "soon" })],
    ["no skipped list", { entries: [], captured_at: CAPTURED }],
    ["an entry is a scalar", snapshot(["bad"])],
    ["an entry has no name", snapshot([{ ...plain("A_ONE", "v"), name: 7 }])],
    [
      "an entry has no scope",
      snapshot([{ name: "A_ONE", kind: "plain", version: 1, value: "v" }]),
    ],
    [
      "an entry has an unknown scope",
      snapshot([{ ...plain("A_ONE", "v"), scope: "session" }]),
    ],
    [
      "an entry has no version",
      snapshot([{ name: "A_ONE", scope: "agent", kind: "plain", value: "v" }]),
    ],
    [
      "an entry has version 0",
      snapshot([{ ...plain("A_ONE", "v"), version: 0 }]),
    ],
    [
      "an entry has an unknown kind",
      snapshot([{ ...plain("A_ONE", "v"), kind: "other" }]),
    ],
    [
      "a plain entry lost its value",
      snapshot([{ name: "A_ONE", scope: "agent", kind: "plain", version: 1 }]),
    ],
  ])(
    "a snapshot this build cannot read is refused, not run blind: %s",
    (_why, stored) => {
      expect(envStartRefusal(stored, NOW)).toBe("unresolved");
    },
  );

  test("what the purge leaves of an unreadable snapshot is refused too", () => {
    expect(envStartRefusal(UNREADABLE_ENV_START, NOW)).toBe("unresolved");
    expect(plainEnvOf(UNREADABLE_ENV_START)).toBeUndefined();
  });

  test("a secret entry holds no value and passes; one that holds a value is refused", () => {
    const secret = {
      name: "A_SECRET",
      scope: "workspace",
      kind: "secret",
      version: 3,
    };
    expect(envStartRefusal(snapshot([secret]), NOW)).toBeNull();
    expect(
      envStartRefusal(snapshot([{ ...secret, value: "kept-by-mistake" }]), NOW),
    ).toBe("unresolved");
  });

  test("a snapshot older than the retention is refused, one exactly at it is not", () => {
    const stored = snapshot([plain("API_URL", "v")]);
    const at = (ms: number) =>
      new Date(Date.parse(CAPTURED) + ENV_START_RETENTION_MS + ms);
    expect(envStartRefusal(stored, at(0))).toBeNull();
    expect(envStartRefusal(stored, at(1))).toBe("unresolved");
  });
});
