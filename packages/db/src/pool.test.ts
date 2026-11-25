import { describe, expect, spyOn, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  createEnforcedPool,
  EvictOnReadTimeoutClient,
  enforcedConfig,
  IDLE_IN_TRANSACTION_MS,
  isConnectionFailure,
  JOB_POOL_TIMEOUTS,
  LookupEveryTimeSocket,
  RequestDeadline,
  RequestDeadlineExceededError,
  runWithDeadline,
} from "./pool.ts";

const url =
  "postgresql://user:secret@db.internal:5433/sessions?statement_timeout=0&query_timeout=0&application_name=api";

describe("pool configuration", () => {
  test("keeps the URL's connection details but not its timeout overrides", () => {
    const config = enforcedConfig(
      url,
      {
        connectMs: 1_000,
        statementMs: 2_000,
        queryMs: 4_000,
      },
      "scheduler",
    );
    expect(config).toMatchObject({
      host: "db.internal",
      port: 5433,
      database: "sessions",
      user: "user",
      password: "secret",
      application_name: "api",
      connectionTimeoutMillis: 1_000,
      statement_timeout: 2_000,
      query_timeout: 4_000,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  test("names the connection after its role unless the URL names it", () => {
    expect(
      enforcedConfig(
        "postgresql://user@db.internal/sessions",
        JOB_POOL_TIMEOUTS,
        "scheduler",
      ).application_name,
    ).toBe("werft:scheduler");
  });

  test("a job pool keeps the job limits whatever the URL asks for", () => {
    const pool = createEnforcedPool(
      url,
      createLogger(),
      "scheduler",
      JOB_POOL_TIMEOUTS,
    );
    try {
      expect(pool.options).toMatchObject({
        connectionTimeoutMillis: JOB_POOL_TIMEOUTS.connectMs,
        statement_timeout: JOB_POOL_TIMEOUTS.statementMs,
        query_timeout: JOB_POOL_TIMEOUTS.queryMs,
        max: 10,
      });
      expect(pool.listenerCount("error")).toBe(1);
    } finally {
      void pool.end();
    }
  });

  test("a release handle from an earlier checkout cannot release the next one", () => {
    const client = new EvictOnReadTimeoutClient();
    const released: string[] = [];
    // What pg-pool does on each checkout.
    client.release = () => released.push("a");
    const releaseA = client.release;
    releaseA();
    client.release = () => released.push("b");
    const deadline = new RequestDeadline(performance.now() + 60_000);
    let evicted = 0;
    (client as unknown as { evict: () => void }).evict = () => {
      evicted += 1;
    };
    client.holdFor(deadline);
    // A late cleanup from the first holder.
    releaseA();
    releaseA();
    expect(released).toEqual(["a"]);
    // B is still checked out and still held by its deadline.
    deadline.expire();
    expect(evicted).toBe(1);
    client.release();
    client.release();
    expect(released).toEqual(["a", "b"]);
  });
});

describe("a client whose connection is gone", () => {
  // AuthenticationOk and ReadyForQuery: all pg needs to call itself connected.
  const STARTUP_DONE = Buffer.from([
    0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49,
  ]);

  // Finishes the startup, then drops the connection on the first statement,
  // as a backend terminated with a BEGIN in flight does.
  const fakePostgres = async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      let started = false;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {
        if (started) {
          socket.destroy();
          return;
        }
        started = true;
        socket.write(STARTUP_DONE);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const pool = createEnforcedPool(
      `postgresql://user@127.0.0.1:${port}/sessions`,
      createLogger(),
      "api",
      { connectMs: 500, statementMs: 2_000, queryMs: 4_000 },
      { max: 2 },
    );
    // What pg-pool counts: one "release" per client handed back.
    const seen = { releases: 0, drops: 0 };
    pool.on("release", () => {
      seen.releases += 1;
    });
    pool.on("error", () => {
      seen.drops += 1;
    });
    return {
      pool,
      seen,
      dropConnections: () => {
        for (const socket of sockets) {
          socket.destroy();
        }
      },
      // Not awaited: a pool still counting a dead client never finishes end().
      close: () => {
        void pool.end();
        server.close();
      },
    };
  };
  const ended = (client: { once: (event: "end", done: () => void) => void }) =>
    new Promise<void>((resolve) => client.once("end", resolve));

  test("a transaction whose BEGIN loses its connection gives its pool slot back", async () => {
    const { pool, close } = await fakePostgres();
    try {
      const db = drizzle(pool);
      // drizzle awaits BEGIN before the try/finally that releases the client,
      // so nothing in it hands back a client whose BEGIN failed.
      for (let attempt = 0; attempt < 2; attempt++) {
        const failure = await db
          .transaction(async () => {})
          .catch((error: unknown) => error);
        expect(isConnectionFailure((failure as Error).cause)).toBe(true);
      }
      // Both slots went to dead clients; a pool that still counts them is
      // full, and this checkout would wait out connectMs and fail.
      const client = await pool.connect();
      client.release();
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    } finally {
      close();
    }
  });

  test("an idle client whose connection ends is removed by the pool, as before", async () => {
    const { pool, seen, dropConnections, close } = await fakePostgres();
    try {
      const client = await pool.connect();
      client.release();
      expect(pool.idleCount).toBe(1);
      const gone = ended(client);
      dropConnections();
      await gone;
      expect(pool.totalCount).toBe(0);
      // pg-pool's idle listener reported the drop; the client released no
      // checkout a second time.
      expect(seen).toEqual({ releases: 1, drops: 1 });
    } finally {
      close();
    }
  });

  test("a connection that ends and then times out under one holder is handed back once", async () => {
    const { pool, seen, dropConnections, close } = await fakePostgres();
    try {
      const client = await pool.connect();
      const gone = ended(client);
      dropConnections();
      await gone;
      expect(seen.releases).toBe(1);
      expect(pool.totalCount).toBe(0);
      // What the holder's next statement meets: a failure the API answers
      // with a retryable 503, and no client (it carries the password).
      const failure = await client
        .query("SELECT 1")
        .catch((error: unknown) => error);
      expect(isConnectionFailure(failure)).toBe(true);
      expect(Object.keys(failure as object)).not.toContain("client");
      // The holder carries on: a later statement meets an expired deadline,
      // which evicts, and then it releases. pg-pool throws on a second
      // release of one checkout.
      const deadline = new RequestDeadline(performance.now() + 60_000);
      deadline.expire();
      await expect(
        runWithDeadline(deadline, () => client.query("SELECT 1")),
      ).rejects.toBeInstanceOf(RequestDeadlineExceededError);
      client.release();
      expect(seen.releases).toBe(1);
      expect(pool.totalCount).toBe(0);
    } finally {
      close();
    }
  });
});

describe("request deadline", () => {
  test("an expiry that fires before the deadline's instant leaves no budget", async () => {
    // As if the expiry timer fired early against performance.now().
    const deadline = new RequestDeadline(performance.now() + 60_000);
    expect(deadline.remainingMs()).toBeGreaterThan(0);
    deadline.expire();
    expect(deadline.remainingMs()).toBeLessThanOrEqual(0);

    const client = new EvictOnReadTimeoutClient();
    let evicted = 0;
    (client as unknown as { evict: () => void }).evict = () => {
      evicted += 1;
    };
    // The abandoned handler's next statement fails instead of running.
    await expect(
      runWithDeadline(deadline, () => client.query("SELECT 1")),
    ).rejects.toBeInstanceOf(RequestDeadlineExceededError);
    expect(evicted).toBe(1);
  });
});

describe("database host resolution", () => {
  const dial = (socket: Socket, port: number, host: string) =>
    new Promise<string>((resolve, reject) => {
      socket.once("connect", () => {
        resolve(socket.remoteAddress ?? "");
        socket.destroy();
      });
      socket.once("error", reject);
      // The call pg's Connection makes.
      socket.connect(port, host);
    });

  test("every connect asks the resolver again, so a moved database is found", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const answers: Array<() => ReturnType<typeof Bun.dns.lookup>> = [
      async () => [{ address: "127.0.0.1", family: 4, ttl: 600 }],
      // Stopped: the name is gone for a while.
      async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "DNS_ENOTFOUND",
        });
      },
      async () => [{ address: "127.0.0.1", family: 4, ttl: 600 }],
    ];
    const lookup = spyOn(Bun.dns, "lookup").mockImplementation(
      () => (answers.shift() ?? (async () => []))() as never,
    );
    try {
      const config = enforcedConfig(url, JOB_POOL_TIMEOUTS, "job");
      const connect = () => dial(config.stream?.() as Socket, port, "postgres");

      expect(await connect()).toBe("127.0.0.1");
      const down = await connect().catch((error: unknown) => error);
      expect(down).toMatchObject({ code: "ENOTFOUND" });
      expect(isConnectionFailure(down)).toBe(true);
      expect(await connect()).toBe("127.0.0.1");

      // A TTL of 600s did not keep the first answer: the libc resolver was
      // asked on each of the three connects.
      expect(lookup.mock.calls).toHaveLength(3);
      for (const [hostname, options] of lookup.mock.calls) {
        expect(hostname).toBe("postgres");
        expect(options).toMatchObject({ backend: "libc" });
      }
    } finally {
      lookup.mockRestore();
      server.close();
    }
  });

  test.each(["ENOTFOUND", "EAI_AGAIN", "ETIMEOUT", "ESERVFAIL"])(
    "a %s lookup failure is a lost connection",
    (code) => {
      expect(
        isConnectionFailure(Object.assign(new Error("lookup"), { code })),
      ).toBe(true);
    },
  );

  test("a failed lookup is a lost connection whatever code the resolver gives it", () => {
    // Bun's getaddrinfo on a node whose DNS is not up yet.
    const lookup = Object.assign(new Error("getaddrinfo ENOTIMP"), {
      code: "ENOTIMP",
      syscall: "getaddrinfo",
    });
    expect(isConnectionFailure(lookup)).toBe(true);
    expect(isConnectionFailure(new Error("some other failure"))).toBe(false);
    expect(isConnectionFailure(null)).toBe(false);
  });

  test("pg dials through that socket", () => {
    const client = new Client(enforcedConfig(url, JOB_POOL_TIMEOUTS, "job"));
    const { stream } = (
      client as unknown as { connection: { stream: unknown } }
    ).connection;
    expect(stream).toBeInstanceOf(LookupEveryTimeSocket);
  });
});
