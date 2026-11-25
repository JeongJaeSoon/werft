import { describe, expect, test } from "bun:test";
import {
  WERFT_VERSION_UNKNOWN,
  WERFT_VERSION_VARIABLE,
  werftVersionOf,
} from "./version.ts";

describe("werftVersionOf", () => {
  test("is what the build wrote, and a fixed word for a build that wrote none", () => {
    expect(werftVersionOf({ [WERFT_VERSION_VARIABLE]: " v0.6.0 " })).toBe(
      "v0.6.0",
    );
    expect(werftVersionOf({ [WERFT_VERSION_VARIABLE]: "" })).toBe(
      WERFT_VERSION_UNKNOWN,
    );
    expect(werftVersionOf({})).toBe(WERFT_VERSION_UNKNOWN);
  });
});
