import { describe, expect, test } from "bun:test";
import type { StoredEngineSettings } from "@werft-ai/contracts";
import { reachOf } from "./engine-settings-service.ts";

const settings = (
  permissions: StoredEngineSettings["permissions"] = {},
  auto_mode: StoredEngineSettings["auto_mode"] = {},
): StoredEngineSettings => ({ permissions, auto_mode });

describe("reachOf", () => {
  test("nothing on either side reaches nothing", () => {
    expect(reachOf(settings(), settings())).toEqual({
      agent_allow_without_effect: {
        permissions: [],
        auto_mode_allow: [],
        auto_mode_environment: [],
      },
      workspace_allow_inactive: false,
    });
  });

  test("an agent grant the workspace does not share does nothing", () => {
    const reach = reachOf(
      settings({ allow: ["Read"] }),
      settings({ allow: ["Read", "WebFetch"] }),
    );
    expect(reach.agent_allow_without_effect.permissions).toEqual(["WebFetch"]);
    expect(reach.workspace_allow_inactive).toBe(false);
  });

  test("a workspace grant the agent leaves empty does not reach the agent", () => {
    expect(
      reachOf(settings({ allow: ["Read"] }), settings())
        .workspace_allow_inactive,
    ).toBe(true);
  });

  test("each of the three grant lists is judged on its own", () => {
    const reach = reachOf(
      settings({}, { allow: ["may read docs"], environment: ["a repo"] }),
      settings({}, { allow: ["may read docs", "may push"] }),
    );
    expect(reach.agent_allow_without_effect).toEqual({
      permissions: [],
      auto_mode_allow: ["may push"],
      auto_mode_environment: [],
    });
    // The workspace's environment list has an entry; the agent's has none.
    expect(reach.workspace_allow_inactive).toBe(true);
  });

  test("restrictions are not grants and never show here", () => {
    const reach = reachOf(
      settings({ deny: ["Bash"], ask: ["Read"] }, { hard_deny: ["x"] }),
      settings({ deny: ["WebFetch"] }),
    );
    expect(reach.workspace_allow_inactive).toBe(false);
    expect(reach.agent_allow_without_effect.permissions).toEqual([]);
  });
});
