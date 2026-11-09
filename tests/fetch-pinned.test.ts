import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const good = new TextEncoder().encode("the pinned bytes");
const bad = new TextEncoder().encode("bytes of another hash");
const pin = createHash("sha256").update(good).digest("hex");

// Each route answers from a queue, then repeats its last entry.
type Answer = Uint8Array | number | "stall" | { location: string };
const queues = new Map<string, Answer[]>();
const hits = new Map<string, number>();
const accepts = new Map<string, string | null>();
let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fetch-pinned-"));
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      accepts.set(path, request.headers.get("accept"));
      const queue = queues.get(path) ?? [];
      const n = hits.get(path) ?? 0;
      hits.set(path, n + 1);
      const answer = queue[Math.min(n, queue.length - 1)];
      if (answer === "stall") {
        // Headers and a first chunk, then the body never ends.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(good.slice(0, 4));
            },
          }),
        );
      }
      if (typeof answer === "object" && "location" in answer) {
        return Response.redirect(
          new URL(answer.location, request.url).href,
          302,
        );
      }
      return typeof answer === "number"
        ? new Response("unavailable", { status: answer })
        : new Response(answer);
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function run(
  path: string,
  answers: Answer[],
  env: Record<string, string> = {},
  fallback?: string,
) {
  queues.set(path, answers);
  const dest = join(dir, path.slice(1));
  const proc = Bun.spawn(
    [
      process.execPath,
      "scripts/fetch-pinned.ts",
      `http://127.0.0.1:${server.port}${path}`,
      pin,
      dest,
      ...(fallback ? [`http://127.0.0.1:${server.port}${fallback}`] : []),
    ],
    {
      env: {
        ...process.env,
        FETCH_PINNED_ATTEMPTS: "3",
        FETCH_PINNED_DELAY_MS: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, dest, hits: hits.get(path) ?? 0 };
}

describe("scripts/fetch-pinned.ts", () => {
  test("writes the pinned bytes on the first good answer", async () => {
    const r = await run("/first", [good]);
    expect(r.code).toBe(0);
    expect(r.hits).toBe(1);
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("retries a body of another hash and keeps the pinned bytes", async () => {
    const r = await run("/retry-bad", [bad, good]);
    expect(r.code).toBe(0);
    expect(r.hits).toBe(2);
    expect(r.stderr).toContain("attempt 1/3");
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("retries an HTTP error", async () => {
    const r = await run("/retry-503", [503, good]);
    expect(r.code).toBe(0);
    expect(r.hits).toBe(2);
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("fails and writes nothing when every answer has the wrong bytes", async () => {
    const r = await run("/always-bad", [bad]);
    expect(r.code).toBe(1);
    expect(r.hits).toBe(3);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("never accepts a wrong body served with status 200 as the last answer", async () => {
    const r = await run("/bad-then-503", [bad, 503, bad]);
    expect(r.code).toBe(1);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("retries a body that stops after the headers", async () => {
    const r = await run("/stall", ["stall", good], {
      FETCH_PINNED_TIMEOUT_MS: "300",
    });
    expect(r.code).toBe(0);
    expect(r.hits).toBe(2);
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("gives up on a body over the size limit instead of buffering it", async () => {
    const r = await run("/big", [good, good], { FETCH_PINNED_MAX_BYTES: "4" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("body over 4 bytes");
    expect(existsSync(r.dest)).toBe(false);
  });

  test("a persistent 504 uses the independent asset API route and follows its redirect", async () => {
    queues.set("/asset-api", [{ location: "/asset-content" }]);
    queues.set("/asset-content", [good]);
    const r = await run("/persistent-504", [504], {}, "/asset-api");
    expect(r.code).toBe(0);
    expect(r.hits).toBe(1);
    expect(hits.get("/asset-api")).toBe(1);
    expect(accepts.get("/asset-api")).toBe("application/octet-stream");
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("a wrong 200 response also switches routes and still verifies the pin", async () => {
    queues.set("/good-alternate", [good]);
    const r = await run("/wrong-primary", [bad], {}, "/good-alternate");
    expect(r.code).toBe(0);
    expect(r.hits).toBe(1);
    expect(readFileSync(r.dest)).toEqual(Buffer.from(good));
  });

  test("neither route can install a body of another hash", async () => {
    queues.set("/bad-alternate", [bad]);
    const r = await run("/both-wrong", [bad], {}, "/bad-alternate");
    expect(r.code).toBe(1);
    expect(r.hits).toBe(1);
    expect(hits.get("/bad-alternate")).toBe(2);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("a valid primary never requests the fallback", async () => {
    queues.set("/unused-alternate", [504]);
    const r = await run("/primary-valid", [good], {}, "/unused-alternate");
    expect(r.code).toBe(0);
    expect(hits.get("/unused-alternate")).toBeUndefined();
  });

  test("rejects a malformed pin before any request", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "scripts/fetch-pinned.ts",
        `http://127.0.0.1:${server.port}/none`,
        "abc",
        join(dir, "none"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(hits.get("/none")).toBeUndefined();
  });
});
