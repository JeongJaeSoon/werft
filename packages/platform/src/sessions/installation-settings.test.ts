import { describe, expect, test } from "bun:test";
import { settingsSnapshot, settingsView } from "./installation-settings.ts";
import type { InstallationSettings } from "./ports/installation-settings-store.ts";

const settings: InstallationSettings = {
  generation: 3,
  connections: [
    {
      id: "readable",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", stored: "connection:readable" },
      },
      models: ["claude-sonnet-5"],
    },
    {
      id: "unreadable",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", stored: "connection:unreadable" },
      },
    },
  ],
  repositories: [],
  mcpServers: [],
  stored: new Map([["connection:readable", "sk-test-readable-key"]]),
  invalid: ["connection:broken"],
};

describe("settingsSnapshot", () => {
  test("a connection without its stored value is unavailable, not gone", () => {
    const snapshot = settingsSnapshot(settings);
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
      stored: new Map([
        ["connection:readable", "sk-test-readable-key"],
        ["connection:unreadable", "sk-test-unreadable-key"],
        ["connection:luna", "luna-key"],
      ]),
    };
    const snapshot = settingsSnapshot(withLuna);
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
