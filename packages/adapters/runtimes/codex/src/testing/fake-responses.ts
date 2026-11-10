import type { RuntimeStart } from "@werft-ai/runtime-core";

/** One request the fake upstream received. */
export type Seen = {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
};

function sse(events: unknown[]): string {
  return events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join("");
}

/**
 * A stand-in for the Responses API behind the egress route: records every
 * request and answers each `/responses` call with the items `answer` returns.
 */
export function fakeResponses(
  seen: Seen[],
  answer: (call: number) => unknown[],
) {
  let call = 0;
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body: await req.text(),
      });
      if (!url.pathname.endsWith("/responses")) {
        return new Response("{}", { status: 404 });
      }
      call += 1;
      const id = `resp_${call}`;
      const items = answer(call);
      return new Response(
        sse([
          { type: "response.created", response: { id } },
          ...items.flatMap((item, i) => [
            { type: "response.output_item.added", output_index: i, item },
            { type: "response.output_item.done", output_index: i, item },
          ]),
          {
            type: "response.completed",
            response: {
              id,
              usage: {
                input_tokens: 10,
                input_tokens_details: null,
                output_tokens: 5,
                output_tokens_details: null,
                total_tokens: 15,
              },
            },
          },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

export const assistantMessage = (text: string) => ({
  type: "message",
  id: "msg",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

/** A `RuntimeStart` for the engine talking to the fake upstream on `port`. */
export function startOf(options: {
  port: number;
  work: string;
  egressToken: string;
  mode?: "new" | "resume";
  resume?: string;
  permissionMode?: string;
}): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: options.egressToken,
          transport: `http://127.0.0.1:${options.port}/provider`,
        },
      },
      principal: { ownerScope: "owner-1" },
    },
    bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
    config: {
      mode: options.mode ?? "new",
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      correlationId: "c-1",
      cwd: options.work,
      home: options.work,
      model: "gpt-test",
      permissionMode: options.permissionMode ?? "default",
      tools: ["exec_command"],
    },
  } as unknown as RuntimeStart;
}
