import { describe, expect, test } from "bun:test";
import {
  createInstallationProfileRequestSchema,
  createWorkspaceProfileRequestSchema,
  installationProfileOptionsResponseSchema,
  listProfilesResponseSchema,
  type ProfileSummary,
} from "./profiles.ts";

const PROFILE: ProfileSummary = {
  id: "op_coding_v2",
  source: "operator",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read", "Edit"],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "none",
};

describe("profile deny", () => {
  test("a listing reads with deny, with deny null and without it", () => {
    for (const profile of [
      { ...PROFILE, deny: ["Bash", "WebSearch"] },
      { ...PROFILE, deny: [] },
      { ...PROFILE, deny: null },
      PROFILE,
    ]) {
      expect(listProfilesResponseSchema.parse({ items: [profile] })).toEqual({
        items: [profile],
      });
    }
    expect(
      listProfilesResponseSchema.safeParse({
        items: [{ ...PROFILE, deny: [""] }],
      }).success,
    ).toBe(false);
  });

  test("options read with the tool catalogs and without them", () => {
    const options = {
      connections: [],
      runtimes: [],
      repositories: [],
      unattended_allowed: false,
    };
    const tool_catalogs = [
      {
        id: "claude_agent_sdk@0.3.270+claude-code@2.1.270",
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        tools: [
          { name: "Read", boundary: "local" },
          { name: "WebSearch", boundary: "provider" },
        ],
      },
    ];
    const answers: unknown[] = [options, { ...options, tool_catalogs }];
    for (const answer of answers) {
      const parsed: unknown =
        installationProfileOptionsResponseSchema.parse(answer);
      expect(parsed).toEqual(answer);
    }
  });

  test("a request names exactly one of tools and deny, and accepts added tools only with deny", () => {
    const ceiling = {
      name: "coding",
      connection_id: "main",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default",
    };
    const version = {
      name: "strict",
      base_profile_id: "op_coding_v1",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default",
    };
    for (const [schema, request] of [
      [createInstallationProfileRequestSchema, ceiling],
      [createWorkspaceProfileRequestSchema, version],
    ] as const) {
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({ ...request, tools: [] }).data?.tools).toEqual(
        [],
      );
      for (const deny of [["Bash"], []]) {
        expect(schema.safeParse({ ...request, deny }).success).toBe(false);
      }
      const { tools: _, ...toolless } = request;
      expect(schema.safeParse(toolless).success).toBe(false);
      for (const deny of [["Bash"], []]) {
        const parsed = schema.safeParse({ ...toolless, deny });
        expect(parsed.data?.deny).toEqual(deny);
        expect(parsed.data && "tools" in parsed.data).toBe(false);
      }
      expect(
        schema.safeParse({
          ...toolless,
          deny: [],
          accept_added_tools: ["Bash"],
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...request, accept_added_tools: ["Bash"] }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...toolless, accept_added_tools: ["Bash"] }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...toolless, deny: [""] }).success).toBe(false);
    }
  });
});
