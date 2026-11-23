import { describe, expect, test } from "bun:test";
import { formatSurfaceRef, surfaceBindingSchema } from "./surfaces.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000e1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000e2";
const BINDING_ID = "019a0000-0000-7000-8000-0000000000e4";
const SESSION_ID = "019a0000-0000-7000-8000-0000000000e5";
const AT = "2026-09-22T01:00:00Z";
const BINDING = {
  id: BINDING_ID,
  workspace_id: WORKSPACE_ID,
  owner_id: "owner_1",
  surface: "slack",
  installation_id: SESSION_ID,
  external_surface_id: "C01",
  surface_kind: "private_channel",
  agent_id: AGENT_ID,
  mode: "on",
  listen: "free",
  ceiling: { actions: ["session.read", "session.submit"], disclosure: "full" },
  home: false,
  memory_write_policy: "deny",
  status: "ready",
  muted: false,
  revision: 0,
  created_at: AT,
  revoked_at: null,
};

describe("surfaces", () => {
  test("a binding decides whether an agent may write at all", () => {
    const binding = BINDING;
    expect(surfaceBindingSchema.parse(binding).memory_write_policy).toBe(
      "deny",
    );
    expect(
      surfaceBindingSchema.safeParse({
        ...binding,
        memory_write_policy: "allow_all",
      }).success,
    ).toBe(false);
  });

  test("a ready slack binding cannot be missing what routing needs", () => {
    const binding = BINDING;
    for (const field of [
      "installation_id",
      "external_surface_id",
      "surface_kind",
    ] as const) {
      expect(
        surfaceBindingSchema.safeParse({ ...binding, [field]: null }).success,
      ).toBe(false);
      // `partial` is exactly the state where the column is still empty.
      expect(
        surfaceBindingSchema.safeParse({
          ...binding,
          status: "partial",
          [field]: null,
        }).success,
      ).toBe(true);
    }
  });

  test("one dm binding covers every dm, so it names no channel", () => {
    const dm = { ...BINDING, surface_kind: "dm", external_surface_id: null };
    expect(surfaceBindingSchema.safeParse(dm).success).toBe(true);
    expect(
      surfaceBindingSchema.safeParse({ ...dm, external_surface_id: "D01" })
        .success,
    ).toBe(false);
    // Home is where the agent greets a channel; a DM is nobody's channel.
    expect(surfaceBindingSchema.safeParse({ ...dm, home: true }).success).toBe(
      false,
    );
    expect(
      surfaceBindingSchema.safeParse({ ...BINDING, home: true }).success,
    ).toBe(true);
  });

  test("a revoked binding cannot also report itself ready", () => {
    // One consumer reads `status`, another reads `revoked_at`; if they can
    // disagree, one of them keeps routing into a revoked binding.
    const binding = BINDING;
    expect(
      surfaceBindingSchema.safeParse({ ...binding, revoked_at: AT }).success,
    ).toBe(false);
    expect(
      surfaceBindingSchema.safeParse({ ...binding, status: "revoked" }).success,
    ).toBe(false);
    expect(
      surfaceBindingSchema.safeParse({
        ...binding,
        status: "revoked",
        revoked_at: AT,
      }).success,
    ).toBe(true);
  });

  test("a surface ref cannot be spelled two ways", () => {
    // Channel and thread ids are opaque, and a surface may put a colon in
    // either; concatenating raw would make these two the same reserved key.
    expect(formatSurfaceRef("a:b", "c")).not.toBe(formatSurfaceRef("a", "b:c"));
    expect(formatSurfaceRef("C01", "1700000000.000100")).toBe(
      "C01:1700000000.000100",
    );
    expect(() => formatSurfaceRef("", "c")).toThrow(TypeError);
  });
});
