import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createFakeOAuth, type FakeOAuthStats } from "./fake-oauth.ts";

export type FakeMcpCalls = {
  /** tools/call requests that reached a tool. */
  calls: number;
  /** sha256 hex of each distinct bearer value the server accepted. */
  authorization_sha256: string[];
};

export type FakeWorkspaceMcpCalls = {
  /** `/oauth/mcp`, behind the OAuth server. */
  oauth: FakeMcpCalls & FakeOAuthStats;
  /** `/static/mcp`, behind any `fms_` token a workspace admin puts in. */
  static: FakeMcpCalls;
};

export type FakeMcp = {
  readonly port: number;
  /** `/mcp`, the catalog server. */
  calls(): FakeMcpCalls;
  workspaceCalls(): FakeWorkspaceMcpCalls;
  /** The authorization step, for a port the browser (a test) can reach. */
  authorize(request: Request): Promise<Response>;
  stop(): Promise<void>;
};

/** The account the authorization step consents as. */
export const FAKE_OAUTH_ACCOUNT = "fake-account";
const STATIC_TOKEN = /^fms_[A-Za-z0-9_-]{16,}$/;

function surface() {
  let calls = 0;
  const seen = new Set<string>();
  return {
    called: () => {
      calls += 1;
    },
    accepted: (bearer: string) => seen.add(sha256Hex(bearer)),
    read: (): FakeMcpCalls => ({
      calls,
      authorization_sha256: [...seen].sort(),
    }),
  };
}

async function serveTools(
  request: Request,
  whoami: string,
  called: () => void,
): Promise<Response> {
  const mcp = new McpServer({ name: "fake", version: "1" });
  mcp.tool("whoami", "Says who the server thinks is calling", async () => {
    called();
    return { content: [{ type: "text", text: whoami }] };
  });
  mcp.tool("other", "A tool no release pins", async () => {
    called();
    return { content: [{ type: "text", text: "other" }] };
  });
  // No session id generator: stateless, a server per request.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await mcp.connect(transport as Transport);
  return transport.handleRequest(request);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Remote MCP servers on one port, stateless streamable HTTP. `whoami` says
 * which credential reached it; `other` exists so a tool the release does
 * not pin has something to be refused for. A missing or wrong bearer is 401.
 * Only hashes of what it was sent are kept.
 *
 * - `/mcp`: a service-account bearer (`bearer`), the catalog's `fake`
 *   server. `whoami` answers `ok:<marker>`.
 * - `/oauth/mcp`: access tokens from the OAuth server beside it
 *   (fake-oauth.ts), a workspace server an admin connects. `whoami`
 *   answers `ok:oauth:fake-account`.
 * - `/static/mcp`: any `fms_` token, a workspace server an admin registers
 *   with a static token. `whoami` answers `ok:static`.
 */
export async function startFakeMcp(options: {
  bearer: string;
  marker: string;
  hostname?: string;
  port?: number;
  /** The origin the API reaches it at; the OAuth issuer. Defaults to the listening address. */
  origin?: string;
  /** Short by default, so an agent's first call already refreshes. */
  accessTtlSec?: number;
}): Promise<FakeMcp> {
  const catalog = surface();
  const oauthSurface = surface();
  const staticSurface = surface();
  let origin = options.origin ?? "";
  const oauth = createFakeOAuth({
    origin: () => origin,
    resourcePath: "/oauth/mcp",
    scope: "read",
    accessTtlSec: options.accessTtlSec ?? 30,
  });
  const bearerOf = (request: Request) =>
    /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      const presented = bearerOf(request);
      switch (url.pathname) {
        case "/mcp":
          if (presented !== options.bearer) {
            return new Response("unauthorized", { status: 401 });
          }
          catalog.accepted(presented);
          return serveTools(request, `ok:${options.marker}`, catalog.called);
        case "/oauth/mcp":
          if (presented === undefined || !oauth.accepts(presented)) {
            return new Response("unauthorized", {
              status: 401,
              headers: { "WWW-Authenticate": oauth.challenge() },
            });
          }
          oauthSurface.accepted(presented);
          return serveTools(
            request,
            `ok:oauth:${FAKE_OAUTH_ACCOUNT}`,
            oauthSurface.called,
          );
        case "/static/mcp":
          if (presented === undefined || !STATIC_TOKEN.test(presented)) {
            return new Response("unauthorized", { status: 401 });
          }
          staticSurface.accepted(presented);
          return serveTools(request, "ok:static", staticSurface.called);
      }
      return (
        (await oauth.handle(request)) ??
        new Response("not found", { status: 404 })
      );
    },
  });
  if (origin === "") origin = `http://${server.hostname}:${server.port}`;
  return {
    port: server.port ?? 0,
    calls: catalog.read,
    workspaceCalls: () => ({
      oauth: { ...oauthSurface.read(), ...oauth.stats() },
      static: staticSurface.read(),
    }),
    authorize: async (request) =>
      new URL(request.url).pathname === "/authorize"
        ? ((await oauth.handle(request)) ??
          new Response("not found", { status: 404 }))
        : new Response("not found", { status: 404 }),
    stop: async () => {
      await server.stop(true);
    },
  };
}
