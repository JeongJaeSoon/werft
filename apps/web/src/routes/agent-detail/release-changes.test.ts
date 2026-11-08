import { describe, expect, test } from "bun:test";
import type { AgentCard, AgentRelease } from "@werft-ai/contracts";
import { previousRelease, releaseChanges } from "./release-changes.ts";

const FEATURES = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: true,
};

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: {
    mcp: null,
    forbidden: [],
    credential_refs: ["github-token"],
  },
  rules: [],
  agent_instructions: "PR을 리뷰한다.",
  ...over,
});

const release = (over: Partial<AgentRelease> = {}): AgentRelease => ({
  id: "sha256:a",
  agent_id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
  version_id: "v1",
  card_sha256: "a".repeat(64),
  runtime_profile_id: "claude-coding-local",
  repository_id: "sample-app",
  profile_digest: "digest-1",
  runtime_config_snapshot: {
    model: "claude-sonnet-5",
    tools: ["Read", "Bash"],
    permission_mode: "default",
    provider: { kind: "anthropic", endpoint: "https://api.example.test" },
    env_ref: "env:OLD_KEY_NAME",
  },
  effective_tools: { tools: ["Read", "Bash"], mcp: [] },
  policy_pins: {
    tools: {
      default: { builtin: "allow", mcp: "ask" },
      per_tool: { Read: "allow", Bash: "ask" },
    },
    github: {
      repositories: ["sample-app"],
      push_approval: true,
      features: FEATURES,
      actions_allow: [],
    },
  },
  created_by: null,
  created_at: "2026-11-04T01:00:00.000Z",
  approved_by: null,
  approved_at: null,
  note: null,
  label: "2026-11-04_10:00:00",
  activated_at: null,
  deactivated_at: null,
  ...over,
});

const before = release();
const after = release({
  id: "sha256:b",
  version_id: "v2",
  card_sha256: "b".repeat(64),
  profile_digest: "digest-2",
  runtime_config_snapshot: {
    model: "claude-opus-5",
    tools: ["Read", "Bash", "Edit"],
    permission_mode: "acceptEdits",
    provider: { kind: "anthropic", endpoint: "https://api.example.test" },
    env_ref: "env:NEW_KEY_NAME",
  },
  effective_tools: { tools: ["Read", "Bash", "Edit"], mcp: [] },
  policy_pins: {
    tools: {
      default: { builtin: "allow", mcp: "ask" },
      per_tool: { Read: "allow", Bash: "allow", Edit: "ask" },
    },
    github: {
      repositories: ["sample-app", "agent-skills"],
      push_approval: true,
      features: FEATURES,
      actions_allow: [],
    },
  },
  created_at: "2026-11-04T02:00:00.000Z",
  label: "2026-11-04_11:00:00",
});
const cards = new Map([
  ["v1", card()],
  [
    "v2",
    card({
      model: "claude-opus-5",
      agent_instructions: "PR을 리뷰한다.\nagent-skills도 본다.",
      capabilities: {
        mcp: null,
        forbidden: [],
        credential_refs: ["github-token", "slack-bot"],
      },
    }),
  ],
]);

describe("releaseChanges", () => {
  test("two releases: what the second changed, by area, and nothing it kept", () => {
    expect(releaseChanges(before, after, (id) => cards.get(id))).toEqual([
      {
        area: "repositories",
        field: { key: "repositories" },
        kind: "list",
        added: ["agent-skills"],
        removed: [],
      },
      {
        area: "model",
        field: { key: "model" },
        kind: "value",
        before: "claude-sonnet-5",
        after: "claude-opus-5",
      },
      {
        area: "tools",
        field: { key: "tools" },
        kind: "list",
        added: ["Edit"],
        removed: [],
      },
      {
        area: "tools",
        field: { key: "toolPolicy" },
        kind: "list",
        added: ["Bash: allow", "Edit: ask"],
        removed: ["Bash: ask"],
      },
      {
        area: "prompt",
        field: { key: "instructions" },
        kind: "text",
        before: "PR을 리뷰한다.",
        after: "PR을 리뷰한다.\nagent-skills도 본다.",
      },
      {
        area: "settings",
        field: { key: "profileDigest" },
        kind: "changed",
      },
      {
        area: "settings",
        field: { path: "permission_mode" },
        kind: "value",
        before: "default",
        after: "acceptEdits",
      },
      { area: "secrets", field: { path: "env_ref" }, kind: "changed" },
      { area: "secrets", field: { key: "credentials" }, kind: "changed" },
    ]);
  });

  test("a credential shows as changed with neither its reference nor its names", () => {
    const shown = JSON.stringify(
      releaseChanges(before, after, (id) => cards.get(id)).filter(
        (change) => change.area === "secrets",
      ),
    );
    for (const value of [
      "OLD_KEY_NAME",
      "NEW_KEY_NAME",
      "github-token",
      "slack-bot",
    ])
      expect(shown).not.toContain(value);
  });

  test("a credential reference inside a list shows as changed, without the list", () => {
    const withRef = (name: string) =>
      release({
        runtime_config_snapshot: {
          model: "m",
          project_settings: { integrations: [{ api_key_ref: `env:${name}` }] },
        },
      });
    const changes = releaseChanges(
      withRef("OLD_NAME"),
      withRef("NEW_NAME"),
      () => undefined,
    );
    expect(changes).toEqual([
      {
        area: "secrets",
        field: { path: "project_settings.integrations" },
        kind: "changed",
      },
    ]);
  });

  test("a credential key in any case or inside a container shows as changed", () => {
    for (const settings of [
      (name: string) => ({ API_KEY_REF: `env:${name}` }),
      (name: string) => ({ slackBotToken_ref: `env:${name}` }),
      (name: string) => ({ env: { HOOK: `env:${name}` } }),
    ]) {
      const changes = releaseChanges(
        release({
          runtime_config_snapshot: {
            model: "m",
            project_settings: settings("OLD_NAME"),
          },
        }),
        release({
          runtime_config_snapshot: {
            model: "m",
            project_settings: settings("NEW_NAME"),
          },
        }),
        () => undefined,
      );
      expect(changes.map((change) => [change.area, change.kind])).toEqual([
        ["secrets", "changed"],
      ]);
      expect(JSON.stringify(changes)).not.toContain("NAME");
    }
  });

  test("no GitHub pin compares as its defaults: an explicit default pin changes only the repositories", () => {
    const { github: _dropped, ...unpinned } = before.policy_pins;
    const defaults = release({
      policy_pins: {
        ...unpinned,
        github: {
          repositories: ["sample-app"],
          push_approval: true,
          features: { ...FEATURES, review: false },
          actions_allow: [],
        },
      },
    });
    expect(
      releaseChanges(release({ policy_pins: unpinned }), defaults, (id) =>
        cards.get(id),
      ).map((change) => change.field),
    ).toEqual([{ key: "repositories" }]);
  });

  test("a snapshot path the release builder does not write shows no value", () => {
    const changes = releaseChanges(
      release({ runtime_config_snapshot: { model: "m", region: "a-1" } }),
      release({ runtime_config_snapshot: { model: "m", region: "b-2" } }),
      () => undefined,
    );
    expect(changes).toEqual([
      { area: "settings", field: { path: "region" }, kind: "changed" },
    ]);
  });

  test("no GitHub pin reads as the profile's range, not as no repository", () => {
    const { github: _dropped, ...unpinned } = before.policy_pins;
    expect(
      releaseChanges(release({ policy_pins: unpinned }), before, (id) =>
        cards.get(id),
      ).filter((change) => change.area === "repositories"),
    ).toEqual([
      {
        area: "repositories",
        field: { key: "repositories" },
        kind: "value",
        before: null,
        after: "sample-app",
      },
    ]);
  });

  test("a card change no row reads is still reported", () => {
    expect(
      releaseChanges(
        before,
        release({ id: "sha256:c", card_sha256: "c".repeat(64) }),
        () => card(),
      ),
    ).toEqual([{ area: "settings", field: { key: "card" }, kind: "changed" }]);
  });
});

describe("previousRelease", () => {
  test("is the release made just before, whatever order the list is in", () => {
    const middle = release({
      id: "sha256:m",
      created_at: "2026-11-04T01:30:00.000Z",
    });
    const releases = [after, before, middle];
    expect(previousRelease(releases, after)?.id).toBe("sha256:m");
    expect(previousRelease(releases, middle)?.id).toBe("sha256:a");
    expect(previousRelease(releases, before)).toBeUndefined();
  });
});
