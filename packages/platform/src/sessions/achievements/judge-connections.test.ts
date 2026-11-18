import { describe, expect, test } from "bun:test";
import type { JudgeProvider } from "../../catalog/catalog.ts";
import { settingsJudgeConnections } from "./judge-connections.ts";

const luna = (value: string): JudgeProvider => ({
  kind: "openai_decisions",
  endpoint: "https://api.openai.com",
  auth: { kind: "api_key", value, ref: { stored: "connection:luna" } },
});

function registry(
  judge: Record<string, JudgeProvider> | null,
  next: Record<string, JudgeProvider> | null = judge,
) {
  const refreshes: Array<number | undefined> = [];
  const read = {
    refreshes,
    settings: judge === null ? null : { judge_connections: judge },
    async refresh(maxAgeMs?: number) {
      refreshes.push(maxAgeMs);
      read.settings = next === null ? null : { judge_connections: next };
    },
  };
  return read;
}

describe("the judge's connections from the installation settings", () => {
  test("a judgment reaches the connection's address with its key, from the last read", async () => {
    const read = registry({ luna: luna("luna-key") });
    const connections = settingsJudgeConnections(read);
    expect(await connections.upstream("luna")).toEqual({
      url: "https://api.openai.com",
      headers: [["authorization", "Bearer luna-key"]],
    });
    expect(read.refreshes).toEqual([]);
  });

  test("an id no openai_decisions connection has resolves to nothing", async () => {
    const connections = settingsJudgeConnections(registry({ luna: luna("k") }));
    for (const id of ["anthropic-main", "constructor", "__proto__"]) {
      expect(await connections.upstream(id), id).toBeNull();
    }
    const unread = settingsJudgeConnections(registry(null));
    expect(await unread.upstream("luna")).toBeNull();
    expect(await unread.ids()).toEqual([]);
  });

  test("the ids a person may name are read again first, sorted, and later judgments use that read", async () => {
    const read = registry(
      { old: luna("o") },
      { zeta: luna("z"), luna: luna("l") },
    );
    const connections = settingsJudgeConnections(read);
    expect(await connections.ids()).toEqual(["luna", "zeta"]);
    expect(read.refreshes).toEqual([0]);
    expect(await connections.upstream("old")).toBeNull();
    expect((await connections.upstream("zeta"))?.headers).toEqual([
      ["authorization", "Bearer z"],
    ]);
  });
});
