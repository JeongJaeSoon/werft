import { describe, expect, test } from "bun:test";
import {
  type ExtensionMode,
  type ExtensionRef,
  resolveExtensions,
  type ScopeEntry,
} from "./resolve.ts";

function ref(
  name: string,
  digestChar: string,
  opts: { scripts?: boolean; skills?: string[] } = {},
): ExtensionRef {
  return {
    bundleId: `id-${name}-${digestChar}`,
    name,
    digest: digestChar.repeat(64),
    manifest: {
      schema: 1,
      slug: name,
      skills: (opts.skills ?? ["review"]).map((skill) => ({
        name: skill,
        has_scripts: opts.scripts === true,
      })),
    },
  };
}

const entry = (mode: ExtensionMode, r: ExtensionRef): ScopeEntry => ({
  mode,
  ref: r,
});

const base = {
  permissionMode: "default",
  runtimeOffersSkills: true,
  tools: ["Read", "Skill"],
} as const;

function refusalOf(result: ReturnType<typeof resolveExtensions>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

describe("resolveExtensions: scope rules", () => {
  test("a required bundle is applied at the scope that required it", () => {
    const result = resolveExtensions({
      ...base,
      scopes: { workspace: [entry("required", ref("lint", "a"))] },
    });
    expect(result).toEqual({
      ok: true,
      extensions: [
        {
          bundleId: "id-lint-a",
          name: "lint",
          digest: "a".repeat(64),
          scope: "workspace",
        },
      ],
    });
  });

  test("an inner scope cannot drop a required bundle", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        workspace: [entry("required", ref("lint", "a"))],
        agent: [entry("forbidden", ref("lint", "a"))],
      },
    });
    expect(refusalOf(result).code).toBe("required_removed");
    const relaxed = resolveExtensions({
      ...base,
      scopes: {
        workspace: [entry("required", ref("lint", "a"))],
        agent: [entry("optional", ref("lint", "a"))],
      },
    });
    expect(refusalOf(relaxed).code).toBe("required_removed");
  });

  test("an inner scope cannot swap a required bundle for another version", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        workspace: [entry("required", ref("lint", "a"))],
        agent: [entry("required", ref("lint", "b"))],
      },
    });
    expect(refusalOf(result).code).toBe("required_replaced");
  });

  test("an inner scope cannot revive a forbidden name", () => {
    for (const mode of ["required", "optional"] as const) {
      const result = resolveExtensions({
        ...base,
        scopes: {
          workspace: [entry("forbidden", ref("lint", "a"))],
          agent: [entry(mode, ref("lint", "b"))],
        },
      });
      expect(refusalOf(result).code).toBe("forbidden_revived");
    }
  });

  test("the session cannot turn on a forbidden name or turn off a required one", () => {
    const forbidden = resolveExtensions({
      ...base,
      scopes: { agent: [entry("forbidden", ref("lint", "a"))] },
      session: { enable: [ref("lint", "a")], disable: [] },
    });
    expect(refusalOf(forbidden).code).toBe("forbidden_revived");
    const required = resolveExtensions({
      ...base,
      scopes: { agent: [entry("required", ref("lint", "a"))] },
      session: { enable: [], disable: [ref("lint", "a")] },
    });
    expect(refusalOf(required).code).toBe("not_optional");
  });

  test("the session cannot name a bundle no scope offers", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {},
      session: { enable: [ref("lint", "a")], disable: [] },
    });
    expect(refusalOf(result).code).toBe("not_optional");
  });

  test("an optional bundle is off until the session turns it on, and can be turned off again", () => {
    const optional = { agent: [entry("optional", ref("lint", "a"))] };
    expect(resolveExtensions({ ...base, scopes: optional })).toEqual({
      ok: true,
      extensions: [],
    });
    const on = resolveExtensions({
      ...base,
      scopes: optional,
      session: { enable: [ref("lint", "a")], disable: [] },
    });
    expect(on.ok && on.extensions.map((e) => [e.name, e.scope])).toEqual([
      ["lint", "session"],
    ]);
    const off = resolveExtensions({
      ...base,
      scopes: optional,
      session: { enable: [], disable: [ref("lint", "a")] },
    });
    expect(off).toEqual({ ok: true, extensions: [] });
  });

  test("the session cannot name an optional bundle at another version", () => {
    const result = resolveExtensions({
      ...base,
      scopes: { agent: [entry("optional", ref("lint", "a"))] },
      session: { enable: [ref("lint", "b")], disable: [] },
    });
    expect(refusalOf(result).code).toBe("not_optional");
  });

  test("an agent's optional version overrides the workspace's optional one", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        workspace: [entry("optional", ref("lint", "a"))],
        agent: [entry("optional", ref("lint", "b"))],
      },
      session: { enable: [ref("lint", "b")], disable: [] },
    });
    expect(result.ok && result.extensions[0]?.digest).toBe("b".repeat(64));
  });

  test("a profile-scope requirement binds the scopes inside it", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        profile: [entry("required", ref("policy", "c"))],
        agent: [entry("forbidden", ref("policy", "c"))],
      },
    });
    expect(refusalOf(result).code).toBe("required_removed");
  });
});

describe("resolveExtensions: name collisions", () => {
  test("two versions of one name in one scope are refused", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        agent: [
          entry("optional", ref("lint", "a")),
          entry("optional", ref("lint", "b")),
        ],
      },
    });
    expect(refusalOf(result).code).toBe("skill_name_collision");
  });

  test("a session that names one bundle twice is refused", () => {
    const result = resolveExtensions({
      ...base,
      scopes: { agent: [entry("optional", ref("lint", "a"))] },
      session: { enable: [ref("lint", "a")], disable: [ref("lint", "a")] },
    });
    expect(refusalOf(result).code).toBe("skill_name_collision");
  });

  test("the same skill name in two bundles does not collide: the engine namespaces by bundle", () => {
    const result = resolveExtensions({
      ...base,
      scopes: {
        workspace: [
          entry("required", ref("lint", "a")),
          entry("required", ref("docs", "b")),
        ],
      },
    });
    expect(result.ok && result.extensions.map((e) => e.name)).toEqual([
      "docs",
      "lint",
    ]);
  });
});

describe("resolveExtensions: what the profile can run", () => {
  const scripted = {
    agent: [entry("required", ref("tools", "a", { scripts: true }))],
  };

  test("a bundle with skills is refused where the profile's tools do not list Skill", () => {
    const scopes = { agent: [entry("required", ref("lint", "a"))] };
    const refused = resolveExtensions({ ...base, tools: ["Read"], scopes });
    expect(refusalOf(refused).code).toBe("skill_tool_not_allowed");
    expect(refusalOf(refused).name).toBe("lint");
    expect(resolveExtensions({ ...base, scopes }).ok).toBe(true);
    // Nothing to judge when no bundle applies.
    expect(resolveExtensions({ ...base, tools: [], scopes: {} })).toEqual({
      ok: true,
      extensions: [],
    });
  });

  test("a bundle with skills is refused where the runtime offers none", () => {
    const result = resolveExtensions({
      ...base,
      runtimeOffersSkills: false,
      scopes: { agent: [entry("required", ref("lint", "a"))] },
    });
    expect(refusalOf(result).code).toBe("feature_unsupported");
  });

  test("a bundle without skills needs no runtime feature", () => {
    const result = resolveExtensions({
      ...base,
      runtimeOffersSkills: false,
      scopes: { agent: [entry("required", ref("empty", "a", { skills: [] }))] },
    });
    expect(result.ok).toBe(true);
  });

  test("scripts pass in default mode and are refused in every other", () => {
    expect(resolveExtensions({ ...base, scopes: scripted }).ok).toBe(true);
    for (const permissionMode of [
      "auto",
      "bypassPermissions",
      "acceptEdits",
      "plan",
    ]) {
      const result = resolveExtensions({
        ...base,
        permissionMode,
        scopes: scripted,
      });
      expect(refusalOf(result).code).toBe("scripts_need_default_mode");
    }
  });

  test("an optional scripted bundle that stays off does not block a session", () => {
    const result = resolveExtensions({
      ...base,
      permissionMode: "auto",
      scopes: {
        agent: [entry("optional", ref("tools", "a", { scripts: true }))],
      },
    });
    expect(result).toEqual({ ok: true, extensions: [] });
  });

  test("activation judges the optional ones too", () => {
    const result = resolveExtensions({
      ...base,
      permissionMode: "auto",
      includeOptional: true,
      scopes: {
        agent: [entry("optional", ref("tools", "a", { scripts: true }))],
      },
    });
    expect(refusalOf(result).code).toBe("scripts_need_default_mode");
  });
});
