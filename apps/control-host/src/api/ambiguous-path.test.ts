import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { ambiguousPathGuard } from "./ambiguous-path.ts";

type Warned = { message: string; fields: Record<string, unknown> | undefined };

function guarded() {
  const warned: Warned[] = [];
  const reached: string[] = [];
  const guard = ambiguousPathGuard({
    warn: (message, fields) => void warned.push({ message, fields }),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: guard.front("api", (request) => {
      reached.push(new URL(request.url).pathname);
      return new Response("reached");
    }),
  });
  servers.push(server);
  return { guard, server, warned, reached };
}

const servers: { stop(close?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

// fetch() would normalize the path itself; the request line goes out as written.
async function sendRaw(port: number, target: string) {
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n`,
      ),
    );
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  const [head = "", body = ""] = answer.split("\r\n\r\n");
  return { status: Number(head.split(" ")[1]), body };
}

describe("ambiguousPathGuard on a real listener", () => {
  test.each([
    "/internal%5Cx",
    "/internal%5cx",
    "/x/..%5cinternal/x",
    "/x/..%5Cinternal/x",
  ])("%s is refused with 400 and no body before the handler", async (path) => {
    const { server, reached } = guarded();
    const answer = await sendRaw(server.port ?? 0, path);
    expect(answer).toEqual({ status: 400, body: "" });
    expect(reached).toEqual([]);
  });

  test.each([
    "/v1/sessions",
    "/internal/worker/heartbeat",
    "/v1/search?q=a%5Cb",
  ])("%s reaches the handler", async (path) => {
    const { server, reached } = guarded();
    const answer = await sendRaw(server.port ?? 0, path);
    expect(answer.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  // Why the raw form is the proxy's job: if Bun ever hands the backslash
  // through, this fails and the guard can refuse it here too.
  test.each(["/internal\\x", "/x/..\\internal/x"])(
    "Bun hands %s to the handler already as /internal/x",
    async (path) => {
      const { server, reached } = guarded();
      await sendRaw(server.port ?? 0, path);
      expect(reached).toEqual(["/internal/x"]);
    },
  );

  test("each refusal logs a warning with the path cut to 200 characters and the running total", async () => {
    const { guard, server, warned } = guarded();
    const long = `/internal%5C${"a".repeat(300)}`;
    await sendRaw(server.port ?? 0, long);
    await sendRaw(server.port ?? 0, "/internal%5cx");
    expect(guard.total()).toBe(2);
    expect(warned.map((entry) => entry.fields)).toEqual([
      {
        event: "api.request.rejected_ambiguous_path",
        listener: "api",
        path: long.slice(0, 200),
        rejected_ambiguous_path_total: 1,
      },
      {
        event: "api.request.rejected_ambiguous_path",
        listener: "api",
        path: "/internal%5cx",
        rejected_ambiguous_path_total: 2,
      },
    ]);
  });

  test("one guard counts over every listener it fronts", async () => {
    const first = guarded();
    const second = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: first.guard.front("egress-authorizer", () => new Response("ok")),
    });
    servers.push(second);
    await sendRaw(first.server.port ?? 0, "/a%5Cb");
    await sendRaw(second.port ?? 0, "/a%5Cb");
    expect(first.guard.total()).toBe(2);
    expect(first.warned.map((entry) => entry.fields?.listener)).toEqual([
      "api",
      "egress-authorizer",
    ]);
  });
});
