import { WERFT_MCP_SERVER } from "@werft-ai/contracts";
import type { PlatformMcpServer } from "./agent-runtime.ts";

function own(server: PlatformMcpServer, names: readonly string[]): string[] {
  const prefix = `mcp__${server.name}__`;
  return names.filter((name) => name.startsWith(prefix));
}

/**
 * The tools of the built-in `werft` server, as `mcp__werft__<tool>`: the
 * ones its claim entry trusts. The server decides what it serves, so no
 * release pins these names, they are in no allowlist and no checkpoint
 * fingerprint holds them. They read only, and a run calls them unasked.
 * Empty for any other server, whose trusted tools stay inside its allowlist.
 */
export function servedMcpTools(server: PlatformMcpServer): string[] {
  return builtinWerft(server) ? own(server, server.trusted ?? []) : [];
}

/** Whether `server` is the built-in `werft` server, as the platform marked it. */
function builtinWerft(server: PlatformMcpServer): boolean {
  return server.platform === true && server.name === WERFT_MCP_SERVER;
}

/**
 * The servers a checkpoint fingerprint holds: all but the built-in `werft`.
 * Every session has that one, whatever its release, and what it serves is
 * the platform's to change, so it says nothing of whether a checkpoint
 * replays; a checkpoint made before it existed restores into a run with it.
 */
export function fingerprintedMcpServers<T extends PlatformMcpServer>(
  servers: readonly T[],
): T[] {
  return servers.filter((server) => !builtinWerft(server));
}

/**
 * The tools of `server` a run shows its engine, as `mcp__<server>__<tool>`:
 * its share of the allowlist, and for the built-in `werft` server the tools
 * it serves.
 */
export function exposedMcpTools(server: PlatformMcpServer): string[] {
  return [
    ...new Set([...own(server, server.tools), ...servedMcpTools(server)]),
  ];
}

/**
 * How long an engine's handshake waits for a platform server's own. What the
 * server says of itself comes only with the handshake, so an answer given
 * without it leaves the engine without it for as long as it runs. The wait
 * ends inside each engine's own patience with a server (both pinned engines
 * were measured waiting 25 s and more): past it the engine is shown the
 * server's tools alone, which is more than a server it gave up on.
 */
export const PLATFORM_MCP_HANDSHAKE_WAIT_MS = 20_000;
const HANDSHAKE_RETRY_MS = 500;

/**
 * What `connect` resolves to, trying again after each attempt that failed,
 * or undefined once `waitMs` has passed.
 */
export async function withinHandshakeWait<T>(
  connect: () => Promise<T>,
  waitMs: number = PLATFORM_MCP_HANDSHAKE_WAIT_MS,
): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(resolve, left, "late");
    });
    const outcome = await Promise.race([
      connect().then(
        (value) => ({ value }),
        () => "failed" as const,
      ),
      late,
    ]);
    clearTimeout(timer);
    if (outcome === "late") return undefined;
    if (outcome !== "failed") return outcome.value;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(HANDSHAKE_RETRY_MS, deadline - Date.now())),
    );
  }
}
