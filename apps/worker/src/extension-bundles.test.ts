import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleDigest,
  packBundleTar,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import {
  ExtensionBundleError,
  publishExtensionBundles,
} from "./extension-bundles.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";

const text = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type Entry = { path: string; mode: number; bytes: Uint8Array };

const GOOD: Entry[] = [
  { path: ".claude-plugin/plugin.json", mode: 0o644, bytes: text("{}") },
  { path: "skills/lint/SKILL.md", mode: 0o644, bytes: text("lint it") },
  { path: "skills/lint/run.sh", mode: 0o755, bytes: text("#!/bin/sh\n") },
];

function digestOf(entries: Entry[]): string {
  return bundleDigest(
    entries.map((e) => ({
      path: e.path,
      mode: (e.mode & 0o111) !== 0 ? 0o755 : 0o644,
      sha256: sha(e.bytes),
    })),
  );
}

function withType(tar: Uint8Array, type: string): Uint8Array {
  const out = tar.slice();
  out[156] = type.charCodeAt(0);
  let sum = 0;
  for (let i = 0; i < 512; i++)
    sum += i >= 148 && i < 156 ? 0x20 : (out[i] ?? 0);
  out.set(text(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return out;
}

const retryable = (status: number) =>
  new WorkerGatewayRequestError(status, null, `HTTP ${status}`, true);
const refused = (status: number) =>
  new WorkerGatewayRequestError(status, "NOT_FOUND", `HTTP ${status}`, false);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ext-home-"));
});
// Published directories are read-only, which also stops rm.
function reopen(path: string) {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) reopen(join(path, entry.name));
  }
}
afterEach(() => {
  reopen(home);
  rmSync(home, { recursive: true, force: true });
});

function options(
  serve: () => Promise<Uint8Array>,
  over: Partial<Parameters<typeof publishExtensionBundles>[0]> = {},
  digest = digestOf(GOOD),
) {
  const calls = { fetch: 0 };
  return {
    calls,
    run: () =>
      publishExtensionBundles({
        home,
        attemptId: "att_1",
        bundles: [{ name: "lint", digest }],
        gateway: {
          extensionBundle: async () => {
            calls.fetch += 1;
            return serve();
          },
        },
        signal: new AbortController().signal,
        sleep: async () => {},
        ...over,
      }),
  };
}

const leftovers = () =>
  readdirSync(join(home, ".ext")).filter((name) => name.startsWith(".tmp-"));

describe("a received bundle is published", () => {
  test("at $HOME/.ext/<digest>/ with every write bit removed", async () => {
    const tar = packBundleTar(GOOD);
    const { run } = options(async () => tar);
    const [placed] = await run();
    expect(placed).toBe(join(home, ".ext", digestOf(GOOD)));
    expect(
      readFileSync(join(placed ?? "", "skills/lint/SKILL.md"), "utf8"),
    ).toBe("lint it");
    for (const path of [
      placed ?? "",
      join(placed ?? "", "skills"),
      join(placed ?? "", "skills/lint"),
      join(placed ?? "", "skills/lint/SKILL.md"),
      join(placed ?? "", "skills/lint/run.sh"),
    ]) {
      expect(statSync(path).mode & 0o222).toBe(0);
    }
    expect(
      statSync(join(placed ?? "", "skills/lint/run.sh")).mode & 0o111,
    ).not.toBe(0);
    expect(
      statSync(join(placed ?? "", "skills/lint/SKILL.md")).mode & 0o111,
    ).toBe(0);
    expect(leftovers()).toEqual([]);
    if (process.getuid?.() !== 0) {
      expect(() => writeFileSync(join(placed ?? "", "new"), "x")).toThrow();
    }
  });

  test("a second start finds it in place and fetches nothing", async () => {
    const tar = packBundleTar(GOOD);
    const first = options(async () => tar);
    await first.run();
    const again = options(async () => tar);
    await again.run();
    expect(again.calls.fetch).toBe(0);
  });
});

describe("a transient failure is retried, inside the budget", () => {
  test("5xx twice, then the bundle: published after three fetches with doubling waits", async () => {
    const tar = packBundleTar(GOOD);
    const failures = [retryable(503), retryable(500)];
    const waits: number[] = [];
    const { run, calls } = options(
      async () => {
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        return tar;
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    await run();
    expect(calls.fetch).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  test("a budget that runs out while retrying fails the start and leaves nothing", async () => {
    const budget = new AbortController();
    const { run, calls } = options(
      async () => {
        throw retryable(503);
      },
      {
        signal: budget.signal,
        sleep: async () => {
          if (calls.fetch >= 3) budget.abort();
        },
      },
    );
    await expect(run()).rejects.toThrow(/startup budget ran out/);
    expect(calls.fetch).toBe(3);
    expect(readdirSync(join(home, ".ext"))).toEqual([]);
  });
});

describe("a bundle that cannot be right is not retried", () => {
  test("a 404 stops after one fetch", async () => {
    const { run, calls } = options(async () => {
      throw refused(404);
    });
    await expect(run()).rejects.toBeInstanceOf(ExtensionBundleError);
    expect(calls.fetch).toBe(1);
  });

  test("bytes that hash to another digest are discarded, with no staging directory left", async () => {
    const other = packBundleTar([
      { path: "skills/lint/SKILL.md", mode: 0o644, bytes: text("tampered") },
    ]);
    mkdirSync(join(home, ".ext"), { recursive: true });
    const { run, calls } = options(async () => other);
    await expect(run()).rejects.toThrow(/not the claimed digest/);
    expect(calls.fetch).toBe(1);
    expect(leftovers()).toEqual([]);
    expect(readdirSync(join(home, ".ext"))).toEqual([]);
  });

  test("a path that climbs out of the bundle is refused before anything is written", async () => {
    const evil = packBundleTar([
      { path: "../escape", mode: 0o644, bytes: text("x") },
    ]);
    mkdirSync(join(home, ".ext"), { recursive: true });
    const { run, calls } = options(async () => evil);
    await expect(run()).rejects.toThrow(/unsafe or repeated/);
    expect(calls.fetch).toBe(1);
    expect(readdirSync(join(home, ".ext"))).toEqual([]);
    expect(readdirSync(home)).toEqual([".ext"]);
  });

  test("a symlink entry is refused", async () => {
    const link = withType(packBundleTar([GOOD[1] as Entry]), "2");
    mkdirSync(join(home, ".ext"), { recursive: true });
    const { run, calls } = options(async () => link);
    await expect(run()).rejects.toThrow(/symlink/);
    expect(calls.fetch).toBe(1);
    expect(readdirSync(join(home, ".ext"))).toEqual([]);
  });

  test("a tar that is not a tar is refused", async () => {
    mkdirSync(join(home, ".ext"), { recursive: true });
    const { run, calls } = options(async () => text("not a tar"));
    await expect(run()).rejects.toBeInstanceOf(ExtensionBundleError);
    expect(calls.fetch).toBe(1);
  });

  test("over the size limit, announced or streamed, ends the attempt after one request", async () => {
    for (const announced of [true, false]) {
      let requests = 0;
      const client = new HttpWorkerGatewayClient({
        baseUrl: "http://gateway.internal",
        credential: "cred",
        requestTimeoutMs: 1_000,
        fetch: async () => {
          requests += 1;
          const body = new Uint8Array(4_000);
          return new Response(body, {
            status: 200,
            headers: announced ? { "content-length": "4000" } : {},
          });
        },
      });
      await expect(
        publishExtensionBundles({
          home,
          attemptId: "att_1",
          bundles: [{ name: "lint", digest: digestOf(GOOD) }],
          gateway: client,
          signal: new AbortController().signal,
          maxBytes: 1_000,
          sleep: async () => {},
        }),
      ).rejects.toThrow(/byte limit/);
      expect(requests).toBe(1);
    }
  });
});

describe("the workspace is not where bundles go", () => {
  test("publishing leaves a workspace beside the home exactly as it was", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ext-workspace-"));
    try {
      writeFileSync(join(workspace, "README.md"), "mine");
      const before = readdirSync(workspace, { recursive: true });
      const { run } = options(async () => packBundleTar(GOOD));
      await run();
      expect(readdirSync(workspace, { recursive: true })).toEqual(before);
      expect(readdirSync(home)).toEqual([".ext"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("the gateway client's bundle request", () => {
  test("sends the session credential on a GET to the attempt's bundle path", async () => {
    let seen: { url: string; method: string; auth: string } | undefined;
    const client = new HttpWorkerGatewayClient({
      baseUrl: "http://gateway.internal/",
      credential: "cred",
      requestTimeoutMs: 1_000,
      fetch: async (input, init) => {
        seen = {
          url: String(input),
          method: String(init?.method),
          auth: String((init?.headers as Record<string, string>).Authorization),
        };
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const bytes = await client.extensionBundle("att_1", "ab".repeat(32), {
      maxBytes: 100,
    });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual({
      url: `http://gateway.internal/internal/worker/attempts/att_1/extensions/${"ab".repeat(32)}`,
      method: "GET",
      auth: "Bearer cred",
    });
  });

  test("a 5xx and a dropped socket are retryable, a 404 and a 409 are not", async () => {
    const answers = [
      () => new Response("", { status: 503 }),
      () => {
        throw new Error("socket closed");
      },
      () => new Response("", { status: 404 }),
      () => new Response("", { status: 409 }),
    ];
    const client = new HttpWorkerGatewayClient({
      baseUrl: "http://gateway.internal",
      credential: "cred",
      requestTimeoutMs: 1_000,
      fetch: async () => (answers.shift() ?? (() => new Response("")))(),
    });
    const flags: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      try {
        await client.extensionBundle("att_1", "ab".repeat(32), {
          maxBytes: 10,
        });
      } catch (error) {
        flags.push((error as WorkerGatewayRequestError).retryable);
      }
    }
    expect(flags).toEqual([true, true, false, false]);
  });
});

describe("what an earlier start left in HOME is proven again, not trusted", () => {
  const tar = packBundleTar(GOOD);
  const skill = (placed: string) => join(placed, "skills/lint/SKILL.md");

  async function published() {
    const [placed] = await options(async () => tar).run();
    return placed ?? "";
  }

  async function refetched(): Promise<{ fetches: number; placed: string }> {
    const again = options(async () => tar);
    const [placed] = await again.run();
    return { fetches: again.calls.fetch, placed: placed ?? "" };
  }

  test("an intact directory is reused", async () => {
    await published();
    expect((await refetched()).fetches).toBe(0);
  });

  test("a directory bigger than the size cap is fetched again without being hashed", async () => {
    await published();
    // The files are 2, 7 and 10 bytes: one is over a 9 byte cap, and every
    // one is under a 15 byte cap that the three together pass.
    for (const maxBytes of [9, 15]) {
      const again = options(async () => tar, { maxBytes });
      await again.run();
      expect(again.calls.fetch).toBe(1);
    }
  });

  test("a file changed in place with its write bit still off is fetched again", async () => {
    const placed = await published();
    chmodSync(join(placed, "skills/lint"), 0o755);
    chmodSync(skill(placed), 0o644);
    writeFileSync(skill(placed), "tampered");
    chmodSync(skill(placed), 0o444);
    chmodSync(join(placed, "skills/lint"), 0o555);
    const { fetches, placed: again } = await refetched();
    expect(fetches).toBe(1);
    expect(readFileSync(skill(again), "utf8")).toBe("lint it");
  });

  test("a directory that was made writable is fetched again", async () => {
    const placed = await published();
    chmodSync(skill(placed), 0o644);
    expect((await refetched()).fetches).toBe(1);
  });

  test("a file added to it is fetched again", async () => {
    const placed = await published();
    chmodSync(placed, 0o755);
    writeFileSync(join(placed, "extra"), "x", { mode: 0o444 });
    chmodSync(placed, 0o555);
    const { fetches, placed: again } = await refetched();
    expect(fetches).toBe(1);
    expect(readdirSync(again).sort()).toEqual([".claude-plugin", "skills"]);
  });

  test("a symlink or a regular file in its place is replaced, never followed", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "ext-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "keep"), "mine");
      const target = join(home, ".ext", digestOf(GOOD));
      mkdirSync(join(home, ".ext"));
      symlinkSync(elsewhere, target);
      const link = await refetched();
      expect(link.fetches).toBe(1);
      expect(statSync(link.placed).isDirectory()).toBe(true);
      expect(readdirSync(elsewhere)).toEqual(["keep"]);
      reopen(home);
      rmSync(target, { recursive: true, force: true });
      writeFileSync(target, "a file");
      expect((await refetched()).fetches).toBe(1);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("$HOME/.ext is ours or nothing is published", () => {
  test("a symlink to the workspace is refused and the workspace gets nothing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ext-workspace-"));
    try {
      symlinkSync(workspace, join(home, ".ext"));
      const { run, calls } = options(async () => packBundleTar(GOOD));
      await expect(run()).rejects.toThrow(/not a directory of this worker/);
      expect(calls.fetch).toBe(0);
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a regular file called .ext is refused too", async () => {
    writeFileSync(join(home, ".ext"), "x");
    const { run, calls } = options(async () => packBundleTar(GOOD));
    await expect(run()).rejects.toBeInstanceOf(ExtensionBundleError);
    expect(calls.fetch).toBe(0);
  });

  test("staging directories a killed start left behind are removed", async () => {
    const stale = join(home, ".ext", ".tmp-dead-1");
    mkdirSync(join(stale, "skills"), { recursive: true });
    writeFileSync(join(stale, "skills/f"), "x");
    chmodSync(join(stale, "skills"), 0o555);
    chmodSync(stale, 0o555);
    await options(async () => packBundleTar(GOOD)).run();
    expect(readdirSync(join(home, ".ext"))).toEqual([digestOf(GOOD)]);
  });
});

describe("the bundle route's failures are retried by status, not by the body's flag", () => {
  const apiError = (status: number, retryable: boolean) =>
    new Response(
      JSON.stringify({
        error: {
          code: status === 404 ? "NOT_FOUND" : "BACKEND_UNAVAILABLE",
          message: "from the gateway",
          retryable,
          request_id: "req_1",
          details: null,
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );

  function publishVia(answers: (() => Response)[]) {
    const waits: number[] = [];
    let requests = 0;
    const gateway = new HttpWorkerGatewayClient({
      baseUrl: "http://gateway.internal",
      credential: "cred",
      requestTimeoutMs: 1_000,
      fetch: async () => {
        requests += 1;
        return (answers.shift() ?? (() => new Response("", { status: 500 })))();
      },
    });
    return {
      requests: () => requests,
      run: () =>
        publishExtensionBundles({
          home,
          attemptId: "att_1",
          bundles: [{ name: "lint", digest: digestOf(GOOD) }],
          gateway,
          signal: new AbortController().signal,
          sleep: async (ms) => void waits.push(ms),
        }),
    };
  }

  test("a 503 that says retryable:false is retried and the next answer is used", async () => {
    const tar = packBundleTar(GOOD);
    const { run, requests } = publishVia([
      () => apiError(503, false),
      () => new Response(new Uint8Array(tar)),
    ]);
    await run();
    expect(requests()).toBe(2);
  });

  test("a damaged stored bundle (409) ends the start at once, naming the bundle and the failed check", async () => {
    const damaged = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "UNSUPPORTED_CAPABILITY",
            message:
              "The stored bundle failed its integrity check and cannot be served",
            retryable: false,
            request_id: "req_1",
            details: null,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    const { run, requests } = publishVia([damaged]);
    const error = await run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ExtensionBundleError);
    expect(requests()).toBe(1);
    const text = (error as Error).message;
    expect(text).toContain(digestOf(GOOD).slice(0, 12));
    expect(text).toContain("integrity check");
  });

  test("a 404 that says retryable:true is not retried", async () => {
    const { run, requests } = publishVia([() => apiError(404, true)]);
    await expect(run()).rejects.toBeInstanceOf(ExtensionBundleError);
    expect(requests()).toBe(1);
  });
});
