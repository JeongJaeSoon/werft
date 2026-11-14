import { afterEach, expect, test } from "bun:test";
import { main } from "./main.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-the-main-test-000000";
const WORKER_TOKEN = "worker-attempt-token";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

// An upstream on the credential lists alone, as compose's defaults put the
// provider, the git host and LocalStack: the credential route reaches it
// the forward proxy refuses it.
test("an upstream on the credential lists alone is reached by its route and refused by the forward proxy", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ id: "msg_1" }),
  });
  cleanups.push(() => upstream.stop(true));
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  const authorizer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${AUTHORIZER_TOKEN}`)
        return new Response("no", { status: 401 });
      // A billed call waits for the exchange ledger to open it.
      if (new URL(request.url).pathname === "/exchanges")
        return Response.json({ state: "open" }, { status: 201 });
      const body = (await request.json()) as { token: string };
      if (body.token !== WORKER_TOKEN)
        return new Response("unknown", { status: 401 });
      return Response.json({
        session_id: "sess-1",
        attempt_id: "att-1",
        upstream: { url: upstreamUrl, headers: [["x-api-key", "sk-kept"]] },
      });
    },
  });
  cleanups.push(() => authorizer.stop(true));

  const forwardPort = freePort();
  const credentialPort = freePort();
  const server = await main({
    // The gateway's place on the forward list; nothing listens there.
    EGRESS_PRIVATE_ALLOWLIST: `127.0.0.1:${freePort()}`,
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: `127.0.0.1:${upstream.port}`,
    EGRESS_AUTHORIZER_URL: `http://127.0.0.1:${authorizer.port}`,
    EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
    EGRESS_CREDENTIAL_PORT: String(credentialPort),
    EGRESS_PROXY_HOST: "127.0.0.1",
    EGRESS_PROXY_PORT: String(forwardPort),
    LOG_LEVEL: "error",
  });
  cleanups.push(() => server.stop());

  const forwarded = await fetch(`${upstreamUrl}/v1/messages`, {
    method: "POST",
    body: "{}",
    proxy: `http://127.0.0.1:${forwardPort}`,
  });
  expect(forwarded.status).toBe(403);
  expect(await forwarded.text()).toContain("not allowlisted");

  const routed = await fetch(
    `http://127.0.0.1:${credentialPort}/provider/v1/messages`,
    {
      method: "POST",
      headers: { "x-api-key": WORKER_TOKEN },
      body: "{}",
    },
  );
  expect(routed.status).toBe(200);
  expect(await routed.json()).toEqual({ id: "msg_1" });
});
