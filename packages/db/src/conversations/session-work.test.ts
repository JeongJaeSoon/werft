import { describe, expect, test } from "bun:test";
import { ADMISSION_STATE_VALUES } from "@werft-ai/contracts";
import { sessionWorkClosed } from "./session-work.ts";

describe("sessionWorkClosed (decision 35)", () => {
  test("closing and closed are closed work; every other admission is open", () => {
    expect(
      ADMISSION_STATE_VALUES.filter((state) => sessionWorkClosed(state)),
    ).toEqual(["closing", "closed"]);
    for (const open of ["active", "paused", "stopped"]) {
      expect(sessionWorkClosed(open)).toBe(false);
    }
  });

  test("no session left is closed work; a value outside the enum throws", () => {
    expect(sessionWorkClosed(undefined)).toBe(true);
    expect(() => sessionWorkClosed("idle")).toThrow();
  });
});
