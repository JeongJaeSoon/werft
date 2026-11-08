import { describe, expect, test } from "bun:test";
import { teamMemberViewSchema } from "./teams.ts";
import { memberViewSchema } from "./workspaces.ts";

const USER = "0b8f6a4e-1c2d-4e3f-8a9b-000000000002";
const base = {
  user_id: USER,
  email: "a@example.com",
  display_name: null,
  role: "member",
  added_by: null,
  added_at: "2026-10-23T09:00:00Z",
};

describe("teamMemberViewSchema disabled_at", () => {
  test("is required and nullable, like the members list's field", () => {
    expect(teamMemberViewSchema.safeParse(base).success).toBe(false);
    expect(
      teamMemberViewSchema.safeParse({ ...base, disabled_at: null }).success,
    ).toBe(true);
    expect(
      teamMemberViewSchema.safeParse({
        ...base,
        disabled_at: "2026-11-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      teamMemberViewSchema.safeParse({ ...base, disabled_at: "yesterday" })
        .success,
    ).toBe(false);
  });

  test("shares its shape with memberViewSchema.disabled_at", () => {
    expect(teamMemberViewSchema.shape.disabled_at.toJSONSchema()).toEqual(
      memberViewSchema.shape.disabled_at.toJSONSchema(),
    );
  });
});
