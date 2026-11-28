import { describe, expect, test } from "bun:test";
import type { WorkspaceRole } from "@werft-ai/contracts";
import {
  type MemberTarget,
  managesMembers,
  mayGrantRole,
  memberActions,
  memberVerdict,
} from "./member-rules.ts";

const ACTOR = "019a0000-0000-7000-8000-0000000000a1";
const OTHER = "019a0000-0000-7000-8000-0000000000b1";

function target(
  role: WorkspaceRole,
  off: Partial<
    Pick<MemberTarget, "membershipDisabled" | "accountDisabled">
  > = {},
): MemberTarget {
  return {
    userId: OTHER,
    role,
    membershipDisabled: false,
    accountDisabled: false,
    ...off,
  };
}

describe("memberVerdict", () => {
  test("the managers are the policy's member.manage roles", () => {
    expect(["owner", "admin", "member"].filter(managesMembers)).toEqual([
      "owner",
      "admin",
    ]);
  });

  test("only an owner grants the owner role", () => {
    expect(mayGrantRole("owner", "owner")).toBe(true);
    expect(mayGrantRole("admin", "owner")).toBe(false);
    expect(mayGrantRole("admin", "admin")).toBe(true);
  });

  test("yourself comes first, whatever the action", () => {
    const self = { ...target("owner"), userId: ACTOR };
    expect(memberActions({ userId: ACTOR, role: "owner" }, self)).toEqual({
      change_role: {
        owner: { allowed: false, reason: "self_protected" },
        admin: { allowed: false, reason: "self_protected" },
        member: { allowed: false, reason: "self_protected" },
      },
      disable: { allowed: false, reason: "self_protected" },
      enable: { allowed: false, reason: "self_protected" },
    });
  });

  test("an admin neither touches an owner nor grants the role", () => {
    const admin = { userId: ACTOR, role: "admin" } as const;
    expect(memberActions(admin, target("owner"))).toEqual({
      change_role: {
        owner: { allowed: false, reason: "owner_protected" },
        admin: { allowed: false, reason: "owner_protected" },
        member: { allowed: false, reason: "owner_protected" },
      },
      disable: { allowed: false, reason: "owner_protected" },
      enable: { allowed: false, reason: "owner_protected" },
    });
    expect(memberActions(admin, target("member")).change_role).toEqual({
      owner: { allowed: false, reason: "owner_protected" },
      admin: { allowed: true },
      member: { allowed: false, reason: "unchanged" },
    });
  });

  test("an owner may demote another owner: no count of owners is asked", () => {
    expect(
      memberVerdict({ userId: ACTOR, role: "owner" }, target("owner"), {
        kind: "change_role",
        role: "member",
      }),
    ).toEqual({ allowed: true });
  });

  test.each([
    [
      "membership off",
      { membershipDisabled: true },
      "member_disabled",
      { allowed: false, reason: "unchanged" },
      { allowed: true },
    ],
    [
      "account off",
      { accountDisabled: true },
      "account_disabled",
      { allowed: true },
      { allowed: false, reason: "account_disabled" },
    ],
    [
      "both off",
      { membershipDisabled: true, accountDisabled: true },
      "account_disabled",
      { allowed: false, reason: "unchanged" },
      { allowed: false, reason: "account_disabled" },
    ],
  ] as const)("%s", (_name, off, roleReason, disable, enable) => {
    const actions = memberActions(
      { userId: ACTOR, role: "owner" },
      target("member", off),
    );
    expect(actions.change_role.admin).toEqual({
      allowed: false,
      reason: roleReason,
    });
    expect(actions.disable).toEqual(disable);
    expect(actions.enable).toEqual(enable);
  });
});
