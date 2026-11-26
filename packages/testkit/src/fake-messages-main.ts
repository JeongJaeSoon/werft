import { startFakeAnthropicServer } from "./fake-anthropic.ts";
import { createRequestLog } from "./request-log.ts";

// The local stack's Messages API: the `fake-messages` connection in
// tests/fixtures/settings/fake-model.json points here, so a session runs end to end without an
// Anthropic account. A message carrying a GATE-SPEC plays that script
// (docs/quickstart.md, tests/e2e); any other gets the same short answer.
const FALLBACK = "Hello from the local fake Messages API.";
// Bounded, since the stack may run for days and under load.
const KEEP_RECORDED = 1000;

const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
const controlPort = Number(process.env.FAKE_MESSAGES_CONTROL_PORT ?? "4011");
const log = createRequestLog(KEEP_RECORDED);
const server = startFakeAnthropicServer(
  (request) => log.reply(request, FALLBACK),
  // The log above is the record; the server keeps no request bodies.
  { listen: { hostname: "0.0.0.0", port }, keepRequests: 0 },
);

// Which scripted step a model call has reached, so tests/e2e can act while a
// slow call is in flight rather than guess, and which earlier prompts the
// call carried as history, so a resume can be told from a fresh start
// (tests/e2e/restore-resume.sh). A port of its own: workers reach
// `port` through the egress proxy, and this one is on no allowlist, so no
// session reads what another one was asked. Only the e2e overlay publishes it.
Bun.serve({
  hostname: "0.0.0.0",
  port: controlPort,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/requests") {
      return new Response("not found", { status: 404 });
    }
    return Response.json(log.entries(url.searchParams.get("spec")));
  },
});

console.log(
  JSON.stringify({
    msg: "Fake Messages API listening",
    url: server.url,
    controlPort,
  }),
);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
