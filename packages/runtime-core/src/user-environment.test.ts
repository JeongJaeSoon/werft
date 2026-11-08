import { describe, expect, test } from "bun:test";

import { assertUserEnvironment } from "./user-environment.ts";

describe("assertUserEnvironment", () => {
  test("returns what it was given when every name and value is acceptable", () => {
    const environment = { API_URL: "https://example.test", EMPTY: "" };
    expect(assertUserEnvironment(environment)).toBe(environment);
    expect(assertUserEnvironment({})).toEqual({});
  });

  test.each([
    "PATH",
    "HOME",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_MAX_RETRIES",
    "GIT_CONFIG_COUNT",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "LD_PRELOAD",
  ])("refuses the name the platform sets itself: %s", (name) => {
    expect(() => assertUserEnvironment({ [name]: "x" })).toThrow(
      `userEnvironment carries ${name}`,
    );
  });

  test("refuses a lowercase or malformed name", () => {
    expect(() => assertUserEnvironment({ http_proxy: "x" })).toThrow(
      "invalid name",
    );
    expect(() => assertUserEnvironment({ "A-B": "x" })).toThrow("invalid name");
  });

  test("refuses a value with NUL, and never echoes the value", () => {
    const error = (() => {
      try {
        assertUserEnvironment({ TOKEN_X: "sekret\0value" });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toBe(
      "userEnvironment's TOKEN_X is not a valid value",
    );
    expect(error?.message).not.toContain("sekret");
  });
});
