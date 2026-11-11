import { describe, expect, test } from "bun:test";
import { builtinToolsDenyOf } from "./agent-caller-limits.ts";

const pinned = (tools_deny: unknown) => ({
  v: 1,
  tools_deny,
  repositories: null,
  mcp_servers: null,
  credentials_deny: [],
  revision: 1,
});

describe("builtinToolsDenyOf", () => {
  test("a session with no pinned limit denies nothing", () => {
    expect(builtinToolsDenyOf(null)).toEqual([]);
    expect(builtinToolsDenyOf(undefined)).toEqual([]);
    expect(builtinToolsDenyOf({})).toEqual([]);
    expect(builtinToolsDenyOf(pinned([]))).toEqual([]);
  });

  test("built-in names pass and mcp__ names are left to the MCP paths", () => {
    expect(
      builtinToolsDenyOf(pinned(["Bash", "mcp__github__push", "WebFetch"])),
    ).toEqual(["Bash", "WebFetch"]);
  });

  test("an entry that is not a string is ignored rather than thrown on", () => {
    expect(builtinToolsDenyOf(pinned(["Bash", 7, null]))).toEqual(["Bash"]);
  });
});
