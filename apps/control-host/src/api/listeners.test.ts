import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambiguousPathGuard } from "./ambiguous-path.ts";
import { createApiApp, createInternalApiApp } from "./app.ts";
import {
  DEFAULT_INTERNAL_API_PORT,
  internalApiPortFromEnv,
  serveApiApp,
} from "./listeners.ts";

const servers: { stop(close?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const dist = await mkdtemp(join(tmpdir(), "listeners-dist-"));
await writeFile(join(dist, "index.html"), "<!doctype html><p>console</p>");
afterAll(() => rm(dist, { recursive: true, force: true }));

// The two apps server.ts builds, each on its own listener.
function listeners() {
  const reached: string[] = [];
  const guard = ambiguousPathGuard({ warn: () => undefined });
  const publicServer = serveApiApp(
    createApiApp({ authMode: "api-key", webDistDir: dist }),
    { listener: "api", port: 0, hostname: "127.0.0.1", guard },
  );
  const internalServer = serveApiApp(
    createInternalApiApp({
      registerInternalRoutes: (router) =>
        router.all("/*", (context) => {
          reached.push(context.req.path);
          return context.text("internal");
        }),
    }),
    { listener: "internal", port: 0, hostname: "127.0.0.1", guard },
  );
  servers.push(publicServer, internalServer);
  return {
    reached,
    publicPort: publicServer.port ?? 0,
    internalPort: internalServer.port ?? 0,
  };
}

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
  return { status: Number(head.split(" ")[1]), head, body };
}

describe("the public listener has no /internal route", () => {
  test.each([
    "/internal",
    "/internal/worker/heartbeat",
    "/%69nternal/x",
    "/x/../internal/x",
    // Bun turns the raw backslash into "/" before any handler sees it.
    "/internal\\x",
    "/x/..\\internal/x",
  ])("%s answers the API's 404, not the console", async (path) => {
    const { reached, publicPort } = listeners();
    const answer = await sendRaw(publicPort, path);
    expect(answer.status).toBe(404);
    expect(answer.head.toLowerCase()).toContain(
      "content-type: application/json",
    );
    expect(answer.body).toContain("NOT_FOUND");
    expect(reached).toEqual([]);
  });

  test("the console and /healthz still answer there", async () => {
    const { publicPort } = listeners();
    expect((await sendRaw(publicPort, "/")).body).toContain("console");
    expect((await sendRaw(publicPort, "/healthz")).status).toBe(200);
  });
});

describe("the internal listener serves /internal alone", () => {
  test.each([
    ["/internal/worker/heartbeat", "/internal/worker/heartbeat"],
    // The same rewrite lands here, where /internal is meant to be.
    ["/internal\\x", "/internal/x"],
    ["/x/..\\internal/x", "/internal/x"],
  ])("%s reaches the internal route as %s", async (path, seen) => {
    const { reached, internalPort } = listeners();
    expect((await sendRaw(internalPort, path)).status).toBe(200);
    expect(reached).toEqual([seen]);
  });

  test.each(["/", "/healthz", "/v1", "/v1/sessions", "/%69nternal/x"])(
    "%s is 404 there",
    async (path) => {
      const { reached, internalPort } = listeners();
      const answer = await sendRaw(internalPort, path);
      expect(answer.status).toBe(404);
      expect(answer.body).toContain("NOT_FOUND");
      expect(reached).toEqual([]);
    },
  );
});

describe("internalApiPortFromEnv", () => {
  test("unset or empty is the default", () => {
    expect(internalApiPortFromEnv({})).toBe(DEFAULT_INTERNAL_API_PORT);
    expect(internalApiPortFromEnv({ INTERNAL_API_PORT: "" })).toBe(
      DEFAULT_INTERNAL_API_PORT,
    );
  });

  test("a port is taken as given, 0 included", () => {
    expect(internalApiPortFromEnv({ INTERNAL_API_PORT: "4100" })).toBe(4100);
    expect(internalApiPortFromEnv({ INTERNAL_API_PORT: "0" })).toBe(0);
  });

  test.each(["x", "-1", "1.5", "65536", " 3200"])("%s is refused", (value) => {
    expect(() => internalApiPortFromEnv({ INTERNAL_API_PORT: value })).toThrow(
      `INTERNAL_API_PORT ${value} is not a port`,
    );
  });
});
