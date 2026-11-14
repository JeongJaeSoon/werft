import { describe, expect, test } from "bun:test";
import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import { settingsSnapshot, settingsView } from "./installation-settings.ts";

const settings: InstallationSettings = {
  generation: 3,
  connections: [
    {
      id: "readable",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value_env: "READABLE_KEY" },
      },
      models: ["claude-sonnet-5"],
    },
    {
      id: "unreadable",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value_env: "MISSING_KEY" },
      },
    },
  ],
  repositories: [],
  mcpServers: [],
  stored: new Map(),
  invalid: ["connection:broken"],
};

describe("settingsSnapshot", () => {
  test("a connection whose credential this host cannot read is unavailable here, not gone", () => {
    const snapshot = settingsSnapshot(settings, (ref) =>
      "value_env" in ref && ref.value_env === "READABLE_KEY"
        ? "sk-test-readable-key"
        : undefined,
    );
    expect(Object.keys(snapshot.connections)).toEqual(["readable"]);
    expect([...snapshot.unavailable_connections].sort()).toEqual([
      "broken",
      "unreadable",
    ]);
  });

  test("an openai_decisions connection is the judge's, never one an agent runs on", () => {
    const withLuna: InstallationSettings = {
      ...settings,
      connections: [
        ...settings.connections,
        {
          id: "luna",
          provider: {
            kind: "openai_decisions",
            endpoint: "https://api.openai.com",
            auth: { kind: "api_key", stored: "connection:luna" },
          },
        },
      ],
      stored: new Map([["connection:luna", "luna-key"]]),
    };
    const snapshot = settingsSnapshot(withLuna, () => "sk-test-readable-key");
    expect(Object.keys(snapshot.connections).sort()).toEqual([
      "readable",
      "unreadable",
    ]);
    expect(snapshot.judge_connections).toEqual({
      luna: {
        kind: "openai_decisions",
        endpoint: "https://api.openai.com",
        auth: {
          kind: "api_key",
          value: "luna-key",
          ref: { stored: "connection:luna" },
        },
      },
    });
    const view = settingsView(withLuna, () => "x");
    expect(Object.keys(view.connections).sort()).toEqual([
      "readable",
      "unreadable",
    ]);
    expect(view.judge_connections).toEqual({});
  });
});
