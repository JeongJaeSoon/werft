import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@werft-ai/contracts";

import { storableLegacyConfig } from "./legacy-runtime-configs.ts";

describe("storableLegacyConfig", () => {
  test("leaves out the merged engine settings and denies a claim re-applies", () => {
    const config = {
      model: "sonnet-5-0",
      tools: ["Read"],
      permission_mode: "bypassPermissions",
      provider: { auth: { kind: "egress_token", token: "secret" } },
      disallowed_tools: ["Skill"],
      engine_settings: { permissions: { ask: ["Bash(git push:*)"] } },
    } as unknown as RuntimeConfig;
    const stored = storableLegacyConfig(config);
    expect("engine_settings" in stored).toBe(false);
    expect("disallowed_tools" in stored).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("git push");
  });
});
