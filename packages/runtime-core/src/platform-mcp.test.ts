import { describe, expect, test } from "bun:test";
import type { PlatformMcpServer } from "./agent-runtime.ts";
import { exposedMcpTools, servedMcpTools } from "./platform-mcp.ts";

const server = (overrides: Partial<PlatformMcpServer>): PlatformMcpServer => ({
  name: "werft",
  binding: "b",
  url: "http://egress-proxy:3129/mcp/werft",
  token: "t",
  tools: ["Read", "mcp__docs__search"],
  ...overrides,
});

describe("the built-in werft server's tools", () => {
  test("are the ones its entry trusts, though no allowlist names them", () => {
    const werft = server({
      platform: true,
      trusted: ["mcp__werft__find", "mcp__werft__status", "mcp__other__x"],
    });
    expect(servedMcpTools(werft)).toEqual([
      "mcp__werft__find",
      "mcp__werft__status",
    ]);
    expect(exposedMcpTools(werft)).toEqual([
      "mcp__werft__find",
      "mcp__werft__status",
    ]);
  });

  test("a server of that name the platform did not mark serves nothing this way", () => {
    const remote = server({ trusted: ["mcp__werft__find"] });
    expect(servedMcpTools(remote)).toEqual([]);
    expect(exposedMcpTools(remote)).toEqual([]);
  });
});

describe("any other server", () => {
  test("shows its share of the allowlist, and a trusted name outside it is not shown", () => {
    const github = server({
      name: "github",
      platform: true,
      tools: ["Read", "mcp__github__request_push", "mcp__docs__search"],
      trusted: ["mcp__github__request_push", "mcp__github__not_exposed"],
    });
    expect(servedMcpTools(github)).toEqual([]);
    expect(exposedMcpTools(github)).toEqual(["mcp__github__request_push"]);
  });
});
