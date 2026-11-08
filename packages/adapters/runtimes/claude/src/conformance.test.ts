import { describe, test } from "bun:test";
import {
  ADAPTER_CONFORMANCE,
  type AdapterConformanceHarness,
} from "@werft-ai/runtime-core/testing/conformance";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

const config: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "conformance",
  mode: "new",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Bash"],
};

const harness: AdapterConformanceHarness = {
  engineSignature(permissionMode) {
    const { settings } = buildSdkOptions(
      { ...config, permissionMode },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    const raw = typeof settings === "object" ? settings.attribution : undefined;
    const attribution = typeof raw === "object" ? raw : undefined;
    return { commit: attribution?.commit, pr: attribution?.pr };
  },
  engineLaunch(gitEnvironment) {
    const { env, ...rest } = buildSdkOptions(
      { ...config, gitEnvironment },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    return { environment: env ?? {}, rest };
  },
  async toolJudgment(call) {
    const ledger = new TurnLedger("conformance");
    if (call.admission === "fails") {
      ledger.holdAdmission(async () => {
        throw new Error("gateway down");
      });
    }
    const pre = buildSdkOptions(
      {
        ...config,
        permissionMode: call.permissionMode,
        tools: [...call.allowlist],
        trustedTools: call.trusted,
      },
      { onPermission: async () => ({ behavior: "allow" }) },
      ledger,
    ).hooks?.PreToolUse?.[0]?.hooks[0];
    if (pre === undefined) throw new Error("PreToolUse hook is required");
    const answer = await pre(
      {
        hook_event_name: "PreToolUse",
        tool_name: call.tool,
        tool_input: {},
        tool_use_id: "toolu_conformance",
      } as never,
      "toolu_conformance",
      { signal: new AbortController().signal },
    );
    const decision =
      "hookSpecificOutput" in answer
        ? (answer.hookSpecificOutput as { permissionDecision?: string })
            .permissionDecision
        : undefined;
    if (decision === "deny") return "refused";
    return decision === "allow" ? "skipped" : "engine";
  },
};

describe("Claude adapter conformance", () => {
  for (const item of ADAPTER_CONFORMANCE) {
    test(item.name, () => item.check(harness));
  }
});
