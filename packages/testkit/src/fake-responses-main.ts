import { startFakeResponsesServer } from "./fake-responses.ts";
import { planOf, replyFor, type ScriptedCall } from "./scripted-responses.ts";

// The local stack's Responses API: the Codex example settings
// (tests/fixtures/settings/fake-model-codex.json) point here, so a Codex
// session runs end to end without an OpenAI account. A prompt containing
// "run-command" makes the model call exec_command once; the request that
// carries that call's output gets a closing answer, and any other prompt the
// same short answer.
const FALLBACK = "Hello from the local fake Responses API.";
const KEEP_RECORDED = 1000;

const port = Number(process.env.FAKE_RESPONSES_PORT ?? "4030");
const controlPort = Number(process.env.FAKE_RESPONSES_CONTROL_PORT ?? "4031");
const USAGE = { input_tokens: 1200, output_tokens: 80 };

type Summary = {
  at: string;
  path: string;
  model: unknown;
  bytes: number;
  tools: string[];
  carriesToolOutput: boolean;
};
const summaries: Summary[] = [];
const calls: ScriptedCall[] = [];

function inputItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.input)
    ? (body.input as Record<string, unknown>[])
    : [];
}

const server = startFakeResponsesServer(
  (request) => {
    const items = inputItems(request.body);
    // A GATE-SPEC prompt plays its own script (tests/conformance); anything
    // else falls through to the keyword behaviour below.
    if ((request.body.tools ?? []).length > 0 && planOf(items) !== null) {
      if (calls.length >= KEEP_RECORDED) calls.splice(0, KEEP_RECORDED / 2);
      return replyFor(request.body, calls, FALLBACK);
    }
    const carriesToolOutput = items.some(
      (item) => item.type === "function_call_output",
    );
    if (summaries.length >= KEEP_RECORDED) {
      summaries.splice(0, KEEP_RECORDED / 2);
    }
    summaries.push({
      at: new Date().toISOString(),
      path: request.path,
      model: request.body.model,
      bytes: JSON.stringify(request.body).length,
      tools: (request.body.tools ?? []).map((tool) => {
        const entry = tool as { type?: string; name?: string };
        return entry.name ?? entry.type ?? "?";
      }),
      carriesToolOutput,
    });
    if (carriesToolOutput) {
      return { text: "The command ran: hello-from-codex.", usage: USAGE };
    }
    if (JSON.stringify(request.body).includes("run-command")) {
      return {
        toolCalls: [
          {
            callId: "call_fake_1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "echo hello-from-codex" }),
          },
        ],
        usage: USAGE,
      };
    }
    return { text: FALLBACK, usage: USAGE };
  },
  { listen: { hostname: "0.0.0.0", port } },
);

// What each model call carried, on a port of its own that is on no allowlist:
// workers reach `port` through the egress proxy. Sizes and tool names only.
Bun.serve({
  hostname: "0.0.0.0",
  port: controlPort,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // The scripted calls, as the fake Messages API's /requests lists them:
    // which spec and step each reached and which earlier specs it replayed.
    if (url.pathname === "/calls") {
      const spec = url.searchParams.get("spec");
      return Response.json(
        calls
          .filter((entry) => spec === null || entry.specId === spec)
          .map(({ at, history, outputs, specId, step, tools }) => ({
            at,
            spec_id: specId,
            step,
            history,
            outputs,
            tools,
          })),
      );
    }
    if (url.pathname !== "/requests") {
      return new Response("not found", { status: 404 });
    }
    // Every path the server saw, healthcheck aside: a client that contacts
    // anything but /v1/responses shows up here.
    const paths: Record<string, number> = {};
    for (const seen of server.requests) {
      const path = seen.path.split("?")[0] ?? seen.path;
      if (path === "/healthz") continue;
      const key = `${seen.method} ${path}`;
      paths[key] = (paths[key] ?? 0) + 1;
    }
    return Response.json({ paths, requests: summaries });
  },
});

console.log(`fake responses on ${port}, control on ${controlPort}`);
