import { describe, expect, test } from "bun:test";
import { MASKED, maskSecrets, maskSecretsIn } from "./secrets.ts";

// Built here, so no file holds a value shaped like a credential.
const tail = "A1b2C3d4".repeat(5);
const shaped = [
  `gh${"p"}_${tail}`,
  `gh${"s"}_${tail}`,
  `github${"_pat"}_${tail}`,
  `xo${"xb"}-${"1234567890".repeat(2)}-abc`,
  `xa${"pp"}-1-${tail}`,
  `s${"k"}-${tail}`,
  `AK${"IA"}${"ABCDEFGH".repeat(2)}`,
  `we${"p"}_${tail}`,
];

describe("maskSecrets", () => {
  test("replaces a value shaped like a credential and keeps the words around it", () => {
    for (const value of shaped) {
      expect(maskSecrets(`before ${value} after`)).toBe(
        `before ${MASKED} after`,
      );
    }
  });

  test("keeps the word Bearer and the rest of a URL, and takes the value and the login", () => {
    expect(maskSecrets(`Authorization: Bearer ${tail}`)).toBe(
      `Authorization: Bearer ${MASKED}`,
    );
    expect(maskSecrets("https://user:hunter2@example.test/path?q=1")).toBe(
      `https://${MASKED}@example.test/path?q=1`,
    );
  });

  test("takes a private key block whole, even one cut short", () => {
    const begin = `-----BEGIN ${"PRIVATE"} KEY-----`;
    const end = `-----END ${"PRIVATE"} KEY-----`;
    expect(maskSecrets(`a\n${begin}\nMIIB\nabcd\n${end}\nb`)).toBe(
      `a\n${MASKED}\nb`,
    );
    expect(maskSecrets(`a\n${begin}\nMIIB`)).toBe(`a\n${MASKED}`);
  });

  test("takes every token the platform mints, by its shape and whatever its prefix", () => {
    // 32 random bytes in base64url are 43 characters.
    const minted = `${tail}xY9`;
    for (const prefix of [
      "aps",
      "apr",
      "apv",
      "csp",
      "wec",
      "wct",
      "wej",
      "wet",
      "wln",
      "wsc",
      "zz",
      "next",
    ]) {
      expect(maskSecrets(`a ${prefix}_${minted} b`)).toBe(`a ${MASKED} b`);
    }
  });

  test("leaves an id and a long name alone", () => {
    const kept = [
      "att_123e4567-e89b-42d3-a456-426614174000",
      "req_123e4567-e89b-42d3-a456-426614174000",
      "max_concurrent_sessions_per_workspace_per_agent_limit",
      "werft_session_no_capacity_failures_total",
    ].join(" ");
    expect(maskSecrets(kept)).toBe(kept);
  });

  test("reads a long input once, whatever it is made of", () => {
    const long = [
      `https://${":".repeat(400_000)}`,
      "ab_a-".repeat(100_000),
      `Bearer ${" ".repeat(400_000)}`,
      `-----BEGIN ${"A ".repeat(200_000)}`,
    ];
    const started = performance.now();
    for (const text of long) expect(maskSecrets(text)).toBe(text);
    // A pattern that backtracks over these takes minutes.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("leaves documentation prose alone, the words token, secret and password included", () => {
    const prose =
      "Set the token in Settings > GitHub. The secret is stored encrypted; password: is never shown. Use `Bearer <token>` and sk-<your key>.";
    expect(maskSecrets(prose)).toBe(prose);
  });
});

describe("maskSecretsIn", () => {
  test("masks every string in a value, however deep, and keeps the rest", () => {
    const [token = ""] = shaped;
    expect(
      maskSecretsIn({
        ok: true,
        count: 2,
        none: null,
        list: [token, { nested: `x ${token}` }],
      }),
    ).toEqual({
      ok: true,
      count: 2,
      none: null,
      list: [MASKED, { nested: `x ${MASKED}` }],
    });
  });
});
