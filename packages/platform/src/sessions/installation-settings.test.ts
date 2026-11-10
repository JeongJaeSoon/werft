import { describe, expect, test } from "bun:test";
import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import { settingsSnapshot } from "./installation-settings.ts";

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
});
