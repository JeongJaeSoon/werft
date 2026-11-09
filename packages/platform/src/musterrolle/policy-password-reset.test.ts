import { describe, expect, test } from "bun:test";
import { passwordResetIssueDenial } from "./member-rules.ts";

describe("password reset issue policy truth table", () => {
  test.each([
    ["owner", "target", null],
    ["owner", "actor", "self_protected"],
    ["admin", "target", "owner_required"],
    ["admin", "actor", "owner_required"],
    ["member", "target", "owner_required"],
    ["member", "actor", "owner_required"],
  ] as const)("%s → %s", (role, targetUserId, expected) => {
    expect(
      passwordResetIssueDenial({ userId: "actor", role }, targetUserId),
    ).toBe(expected);
  });
});
