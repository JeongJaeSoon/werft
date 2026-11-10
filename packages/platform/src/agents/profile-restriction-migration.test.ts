import { describe, expect, test } from "bun:test";
import type { ToolCatalogView } from "@werft-ai/contracts";
import {
  planProfileRestrictionMigration,
  type RestrictionFact,
  type RestrictionProfile,
  type RestrictionResolver,
  restrictionOf,
} from "./profile-restriction-migration.ts";

const CATALOG: ToolCatalogView = {
  id: "engine@2",
  tools: [
    { name: "Read", boundary: "local" },
    { name: "Edit", boundary: "local" },
    { name: "Bash", boundary: "local" },
    { name: "WebFetch", boundary: "egress" },
  ],
};

const fact = (over: Partial<RestrictionFact> = {}): RestrictionFact => ({
  workspace_id: "w1",
  agent_id: "a1",
  name: "agent one",
  release: { id: "r2", runtime_profile_id: "p1", tools: ["Read", "Edit"] },
  release_ids: ["r2", "r1"],
  existing: [],
  ...over,
});

const profile = (
  over: Partial<RestrictionProfile> = {},
): RestrictionProfile => ({
  tools: ["Read", "Edit", "Bash"],
  mcp_deny: [],
  catalog: CATALOG,
  ...over,
});

const resolveWith =
  (found: RestrictionProfile | undefined): RestrictionResolver =>
  () =>
    found;

describe("the restriction a profile puts on an agent", () => {
  test("blocks what the profile and the release together leave out of the catalog", () => {
    // Bash is in the profile but not the release; WebFetch is in neither.
    const result = restrictionOf(fact(), resolveWith(profile()));
    expect(result.decision).toBe("write");
    expect(result.permissions_deny).toEqual(["Bash", "WebFetch"]);
    expect(result.entry?.exempt_release_ids).toEqual(["r1", "r2"]);
  });

  test("keeps a tool the release allows but the profile has since taken away blocked", () => {
    const result = restrictionOf(
      fact(),
      resolveWith(profile({ tools: ["Read"] })),
    );
    expect(result.permissions_deny).toEqual(["Edit", "Bash", "WebFetch"]);
  });

  test("carries the profile's mcp__ names, sorted", () => {
    const result = restrictionOf(
      fact(),
      resolveWith(
        profile({ mcp_deny: ["mcp__b__x", "mcp__a__y", "mcp__b__x"] }),
      ),
    );
    expect(result.mcp_deny).toEqual(["mcp__a__y", "mcp__b__x"]);
  });

  test("is idempotent: a second plan over what the first wrote adds nothing", () => {
    const first = restrictionOf(fact(), resolveWith(profile()));
    const second = restrictionOf(
      fact({ existing: [first.entry] }),
      resolveWith(profile()),
    );
    expect(second.decision).toBe("skip");
    expect(second.reason).toBe("already_covered");
  });

  test("adds only the rules no stored entry covers", () => {
    const first = restrictionOf(fact(), resolveWith(profile()));
    const later = restrictionOf(
      fact({ existing: [first.entry] }),
      resolveWith(profile({ mcp_deny: ["mcp__a__y"] })),
    );
    expect(later.decision).toBe("write");
    expect(later.permissions_deny).toEqual([]);
    expect(later.mcp_deny).toEqual(["mcp__a__y"]);
  });

  test("skips an agent without a release and one the profile blocks nothing for", () => {
    expect(
      restrictionOf(fact({ release: null }), resolveWith(profile())).reason,
    ).toBe("no_release");
    expect(
      restrictionOf(
        fact({
          release: {
            id: "r2",
            runtime_profile_id: "p1",
            tools: CATALOG.tools.map((tool) => tool.name),
          },
        }),
        resolveWith(
          profile({
            tools: CATALOG.tools.map((tool) => tool.name),
          }),
        ),
      ).reason,
    ).toBe("nothing_to_deny");
  });

  test("blocks, writes nothing, when the profile or its catalog is gone or the stored list does not parse", () => {
    expect(restrictionOf(fact(), resolveWith(undefined)).reason).toBe(
      "profile_gone",
    );
    expect(
      restrictionOf(fact(), resolveWith(profile({ catalog: undefined })))
        .reason,
    ).toBe("catalog_missing");
    const broken = restrictionOf(
      fact({ existing: [{ nonsense: true }] }),
      resolveWith(profile()),
    );
    expect(broken.decision).toBe("blocked");
    expect(broken.reason).toBe("stored_admin_deny_invalid");
    expect(broken.entry).toBeNull();
  });

  test("blocks rather than cuts when the rules would pass the budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => `mcp__s__t${i}`);
    const result = restrictionOf(
      fact(),
      resolveWith(profile({ mcp_deny: many })),
    );
    expect(result.decision).toBe("blocked");
    expect(result.reason).toBe("over_budget");
    expect(result.detail).toContain("too_many_rules");
    expect(result.entry).toBeNull();
  });
});

describe("the plan over all agents", () => {
  test("is sorted and counted, and its bytes depend on the data alone", () => {
    const facts = [
      fact({ workspace_id: "w2", agent_id: "b" }),
      fact({ agent_id: "z", release: null }),
      fact({ agent_id: "a" }),
    ];
    const resolve = resolveWith(profile());
    const plan = planProfileRestrictionMigration({ facts, resolve });
    expect(
      plan.agents.map((entry) => `${entry.workspace_id}/${entry.agent_id}`),
    ).toEqual(["w1/a", "w1/z", "w2/b"]);
    expect(plan.totals).toEqual({
      write: 2,
      skip: 1,
      blocked: 0,
      permissions_rules: 4,
      mcp_rules: 0,
    });
    expect(
      JSON.stringify(
        planProfileRestrictionMigration({
          facts: [...facts].reverse(),
          resolve,
        }),
      ),
    ).toBe(JSON.stringify(plan));
  });
});
