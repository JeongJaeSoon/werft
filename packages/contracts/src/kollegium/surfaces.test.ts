import { describe, expect, test } from "bun:test";
import {
  formatSurfaceRef,
  sessionLinkSchema,
  surfaceBindingSchema,
} from "./surfaces.ts";

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

  test("a live session link carries both pins or it cannot be bound", () => {
    const link = {
      id: "019a0000-0000-7000-8000-0000000000e6",
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      session_id: SESSION_ID,
      surface: "slack",
      installation_id: "019a0000-0000-7000-8000-0000000000e7",
      surface_binding_id: BINDING_ID,
      surface_ref: formatSurfaceRef("C01", "1700000000.000100"),
      channel_id: "C01",
      thread_id: "1700000000.000100",
      agent_id: AGENT_ID,
      release_id: "rel_9f2c",
      role: "primary",
      visibility: "full",
      muted: false,
      revision: 0,
      created_by: null,
      created_at: AT,
      revoked_at: null,
    };
    expect(sessionLinkSchema.safeParse(link).success).toBe(true);
    // `(installation_id, surface_ref)` is a reserved natural key, so one
    // conversation gets one spelling — a hand-concatenated ref would reserve
    // a second key for the same thread and open a second session on it.
    expect(
      sessionLinkSchema.safeParse({
        ...link,
        surface_ref: `${link.channel_id}:${link.thread_id}x`,
      }).success,
    ).toBe(false);
    // Half an identity would skip canonicalisation and let any spelling
    // through — exactly the second key this is meant to prevent.
    expect(
      sessionLinkSchema.safeParse({ ...link, thread_id: null }).success,
    ).toBe(false);
    // Components the id schemas accept must have a representable ref, and
    // asking for one must not throw out of safeParse. Hangul is the worst
    // case: one code unit becomes nine percent-encoded characters, so a pair
    // of maximum-length ids is an order of magnitude longer than the ids.
    const long = "채".repeat(128);
    expect(() =>
      sessionLinkSchema.safeParse({
        ...link,
        channel_id: long,
        thread_id: long,
        surface_ref: formatSurfaceRef(long, long),
      }),
    ).not.toThrow();
    expect(
      sessionLinkSchema.safeParse({
        ...link,
        channel_id: long,
        thread_id: long,
        surface_ref: formatSurfaceRef(long, long),
      }).success,
    ).toBe(true);
    for (const field of ["release_id"] as const) {
      expect(
        sessionLinkSchema.safeParse({ ...link, [field]: null }).success,
      ).toBe(false);
      // A revoked link may have lost its pins; nothing binds through it.
      expect(
        sessionLinkSchema.safeParse({
          ...link,
          [field]: null,
          revoked_at: AT,
        }).success,
      ).toBe(true);
    }
  });
});
