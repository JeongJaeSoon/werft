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
    expect(builtinToolsDenyOf(pinned([]))).toEqual([]);
  });

  test("built-in names pass and mcp__ names are left to the MCP paths", () => {
    expect(
      builtinToolsDenyOf(pinned(["Bash", "mcp__github__push", "WebFetch"])),
    ).toEqual(["Bash", "WebFetch"]);
  });

  test("a limit this image cannot read fails instead of lifting the denial", () => {
    for (const unreadable of [
      pinned(["Bash", 7]),
      pinned("Bash"),
      { ...pinned(["Bash"]), v: 2 },
      {},
      "Bash",
    ]) {
      expect(() => builtinToolsDenyOf(unreadable)).toThrow();
    }
    // Damage elsewhere in the row does not hide the tools it denies.
    expect(
      builtinToolsDenyOf({ ...pinned(["Bash"]), credentials_deny: null }),
    ).toEqual(["Bash"]);
  });
});
