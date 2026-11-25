import { describe, expect, test } from "bun:test";
import type { PlatformMcpServer } from "./agent-runtime.ts";
import {
  exposedMcpTools,
  fingerprintedMcpServers,
  servedMcpTools,
  withinHandshakeWait,
} from "./platform-mcp.ts";

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

describe("the servers a checkpoint fingerprint holds", () => {
  test("are all but the built-in werft server, and a server of its name the platform did not mark stays", () => {
    const github = server({ name: "github", platform: true });
    const werft = server({ platform: true });
    const unmarked = server({});
    expect(fingerprintedMcpServers([github, werft])).toEqual([github]);
    expect(fingerprintedMcpServers([github, unmarked])).toEqual([
      github,
      unmarked,
    ]);
  });
});

describe("the wait for a platform server's handshake", () => {
  test("gives what the server answered, trying again after each attempt that failed", async () => {
    let attempts = 0;
    const connect = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not up yet");
      return "client";
    };
    expect(await withinHandshakeWait(connect, 5_000)).toBe("client");
    expect(attempts).toBe(3);
  });

  test("ends with nothing once the wait has passed, whether the server is silent or keeps failing", async () => {
    const silent = () => new Promise<string>(() => {});
    expect(await withinHandshakeWait(silent, 50)).toBeUndefined();
    let attempts = 0;
    const failing = async (): Promise<string> => {
      attempts += 1;
      throw new Error("down");
    };
    expect(await withinHandshakeWait(failing, 50)).toBeUndefined();
    expect(attempts).toBe(1);
  });
});
