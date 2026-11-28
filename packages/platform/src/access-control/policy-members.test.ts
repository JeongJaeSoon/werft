import { describe, expect, test } from "bun:test";
import type { MemberVerdict, WorkspaceRole } from "@werft-ai/contracts";
import {
  assignableRoles,
  type MemberAction,
  memberActions,
  memberVerdict,
} from "./member-rules.ts";

const A = { allowed: true } as const;
const U = { allowed: false, reason: "unchanged" } as const;
const S = { allowed: false, reason: "self_protected" } as const;
const O = { allowed: false, reason: "owner_protected" } as const;
const M = { allowed: false, reason: "member_disabled" } as const;
const C = { allowed: false, reason: "account_disabled" } as const;

const states = {
  live: { membershipDisabled: false, accountDisabled: false },
  "membership off": { membershipDisabled: true, accountDisabled: false },
  "account off": { membershipDisabled: false, accountDisabled: true },
  "both off": { membershipDisabled: true, accountDisabled: true },
} as const;

type Row = readonly [
  actor: "owner" | "admin",
  target: WorkspaceRole | "self",
  state: keyof typeof states,
  changeOwner: MemberVerdict,
  changeAdmin: MemberVerdict,
  changeMember: MemberVerdict,
  disable: MemberVerdict,
  enable: MemberVerdict,
];

// Columns are change to owner/admin/member, disable, enable.
const rows = [
  ["owner", "self", "live", S, S, S, S, S],
  ["owner", "owner", "live", U, A, A, A, U],
  ["owner", "owner", "membership off", M, M, M, U, A],
  ["owner", "owner", "account off", C, C, C, A, C],
  ["owner", "owner", "both off", C, C, C, U, C],
  ["owner", "admin", "live", A, U, A, A, U],
  ["owner", "admin", "membership off", M, M, M, U, A],
  ["owner", "admin", "account off", C, C, C, A, C],
  ["owner", "admin", "both off", C, C, C, U, C],
  ["owner", "member", "live", A, A, U, A, U],
  ["owner", "member", "membership off", M, M, M, U, A],
  ["owner", "member", "account off", C, C, C, A, C],
  ["owner", "member", "both off", C, C, C, U, C],
  ["admin", "self", "live", S, S, S, S, S],
  ["admin", "owner", "live", O, O, O, O, O],
  ["admin", "owner", "membership off", O, O, O, O, O],
  ["admin", "owner", "account off", O, O, O, O, O],
  ["admin", "owner", "both off", O, O, O, O, O],
  ["admin", "admin", "live", O, U, A, A, U],
  ["admin", "admin", "membership off", O, M, M, U, A],
  ["admin", "admin", "account off", O, C, C, A, C],
  ["admin", "admin", "both off", O, C, C, U, C],
  ["admin", "member", "live", O, A, U, A, U],
  ["admin", "member", "membership off", O, M, M, U, A],
  ["admin", "member", "account off", O, C, C, A, C],
  ["admin", "member", "both off", O, C, C, U, C],
] as const satisfies readonly Row[];

const actions: readonly MemberAction[] = [
  { kind: "change_role", role: "owner" },
  { kind: "change_role", role: "admin" },
  { kind: "change_role", role: "member" },
  { kind: "disable" },
  { kind: "enable" },
];

describe("member policy truth table", () => {
  for (const [role, subject, state, ...expected] of rows) {
    const name = subject === "self" ? "self" : `${subject} (${state})`;
    test(`${role} → ${name}`, () => {
      const actor = { userId: "actor", role };
      const target = {
        userId: subject === "self" ? "actor" : "target",
        role: subject === "self" ? role : subject,
        ...states[state],
      };
      const [owner, admin, member, disable, enable] = expected;
      expect(memberActions(actor, target)).toEqual({
        change_role: { owner, admin, member },
        disable,
        enable,
      });
      expect(
        actions.map((action) => memberVerdict(actor, target, action)),
      ).toEqual([...expected]);
    });
  }

  test.each([
    ["owner", ["owner", "admin", "member"]],
    ["admin", ["admin", "member"]],
  ] as const)("%s assignable roles", (role, expected) => {
    expect(assignableRoles(role)).toEqual([...expected]);
  });
});
