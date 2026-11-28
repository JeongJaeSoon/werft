import { describe, expect, test } from "bun:test";
import {
  createInstallationHosts,
  installationHostNames,
  MAX_DENIED_HOSTS,
} from "./installation-hosts.ts";

describe("installationHostNames", () => {
  test("reads the hosts the API is wired to, as configured and each once", () => {
    expect(
      installationHostNames({
        DATABASE_URL: "postgresql://user:pw@Postgres.:5432/sessions",
        WORKER_GATEWAY_URL: "http://api:3200",
        AWS_ENDPOINT_URL: "http://[FD00::9]:8333",
        EGRESS_AUTHORIZER_HOST: "0.0.0.0",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        // The gateway's name again, in two more spellings.
        EGRESS_PRIVATE_DENY_HOSTS: " vip.internal , 172.30.64.1,,API,api.",
      }).sort(),
    ).toEqual(
      [
        "0.0.0.0",
        "10.96.0.1",
        "172.30.64.1",
        "api",
        // As written: the resolver is asked the absolute name too.
        "api.",
        "[fd00::9]",
        "postgres.",
        "vip.internal",
      ].sort(),
    );
    expect(installationHostNames({})).toEqual([]);
    // A database on a socket path names no host.
    expect(
      installationHostNames({ DATABASE_URL: "postgresql:///sessions" }),
    ).toEqual([]);
  });

  test("a value that names no host stops the start rather than leave a hole", () => {
    expect(() =>
      installationHostNames({ EGRESS_PRIVATE_DENY_HOSTS: "vip.internal:443" }),
    ).toThrow("EGRESS_PRIVATE_DENY_HOSTS");
    expect(() =>
      installationHostNames({ WORKER_GATEWAY_URL: "not a url" }),
    ).toThrow("WORKER_GATEWAY_URL");
  });
});

describe("createInstallationHosts", () => {
  const answering =
    (answers: Record<string, string[] | Error>, asked: string[] = []) =>
    async (host: string) => {
      asked.push(host);
      const answer = answers[host];
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error("ENOTFOUND");
      }
      return answer.map((address) => ({ address, family: 4 }));
    };

  test("every interface address of this process, each name, and what each name resolves to", async () => {
    const asked: string[] = [];
    const hosts = createInstallationHosts({
      names: ["postgres", "api", "10.96.0.1"],
      interfaces: () => ["127.0.0.1", "::1", "172.20.0.3", "fe80::1%eth0"],
      lookup: answering(
        { postgres: ["172.20.0.2"], api: ["172.20.0.3", "FD00:0:0:0:0:0:0:3"] },
        asked,
      ),
    });
    expect([...((await hosts()) ?? [])].sort()).toEqual(
      [
        "postgres",
        "api",
        "10.96.0.1",
        "127.0.0.1",
        "::1",
        "172.20.0.3",
        "fe80::1",
        "172.20.0.2",
        "fd00::3",
      ].sort(),
    );
    // An address names itself: nothing is asked for it.
    expect(asked.sort()).toEqual(["api", "postgres"]);
  });

  test("the interfaces are read on every call", async () => {
    let addresses = ["172.20.0.3"];
    const hosts = createInstallationHosts({
      names: [],
      interfaces: () => addresses,
    });
    expect(await hosts()).toEqual(["172.20.0.3"]);
    addresses = ["172.20.0.9"];
    expect(await hosts()).toEqual(["172.20.0.9"]);
  });

  test("a name that does not resolve leaves no list at all", async () => {
    for (const answers of [
      { postgres: ["172.20.0.2"] },
      { postgres: ["172.20.0.2"], api: [] as string[] },
      { postgres: ["172.20.0.2"], api: ["not-an-address"] },
    ]) {
      const hosts = createInstallationHosts({
        names: ["postgres", "api"],
        interfaces: () => [],
        lookup: answering(answers),
      });
      expect(await hosts()).toBeNull();
    }
  });

  test("more hosts than the proxy reads leaves no list, never a shorter one", async () => {
    const many = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `10.1.${index >> 8}.${index & 255}`,
      );
    const at = createInstallationHosts({
      names: [],
      interfaces: () => many(MAX_DENIED_HOSTS),
    });
    expect(await at()).toHaveLength(MAX_DENIED_HOSTS);
    const over = createInstallationHosts({
      names: [],
      interfaces: () => many(MAX_DENIED_HOSTS + 1),
    });
    expect(await over()).toBeNull();
  });

  test("a name is asked on every call, and an address it moved off stays denied for five minutes", async () => {
    let clock = 1_000_000;
    let answer = ["172.20.0.3"];
    const asked: string[] = [];
    const hosts = createInstallationHosts({
      names: ["api"],
      interfaces: () => [],
      lookup: async (host) => {
        asked.push(host);
        return answer.map((address) => ({ address, family: 4 }));
      },
      now: () => clock,
    });
    expect(await hosts()).toEqual(["api", "172.20.0.3"]);
    answer = ["172.20.0.8"];
    clock += 1;
    // The replica that answered before is gone from the name's answer, and
    // is still held off.
    expect(await hosts()).toEqual(["api", "172.20.0.3", "172.20.0.8"]);
    expect(asked).toHaveLength(2);
    clock += 5 * 60_000 - 1;
    expect(await hosts()).toEqual(["api", "172.20.0.8"]);
    expect(asked).toHaveLength(3);
  });

  test("calls that overlap share one question, so a late answer never replaces a newer one", async () => {
    const answers: Array<(addresses: string[]) => void> = [];
    const hosts = createInstallationHosts({
      names: ["api"],
      interfaces: () => [],
      lookup: () =>
        new Promise((resolve) => {
          answers.push((addresses) =>
            resolve(addresses.map((address) => ({ address, family: 4 }))),
          );
        }),
    });
    const first = hosts();
    const second = hosts();
    await Promise.resolve();
    expect(answers).toHaveLength(1);
    answers[0]?.(["172.20.0.8"]);
    expect(await first).toEqual(["api", "172.20.0.8"]);
    expect(await second).toEqual(["api", "172.20.0.8"]);
    // The question is over: the next call asks again.
    const third = hosts();
    await Promise.resolve();
    expect(answers).toHaveLength(2);
    answers[1]?.(["172.20.0.9"]);
    expect(await third).toEqual(["api", "172.20.0.8", "172.20.0.9"]);
  });

  test("a call waiting on a slow name gives what an overlapping call learnt of a fast one", async () => {
    let fast = ["172.20.0.3"];
    let slow: ((addresses: string[]) => void) | undefined;
    const hosts = createInstallationHosts({
      names: ["api", "db"],
      interfaces: () => [],
      lookup: (host) =>
        host === "api"
          ? Promise.resolve(fast.map((address) => ({ address, family: 4 })))
          : new Promise((resolve) => {
              slow = (addresses) =>
                resolve(addresses.map((address) => ({ address, family: 4 })));
            }),
    });
    const first = hosts();
    await Bun.sleep(1);
    fast = ["172.20.0.8"];
    const second = hosts();
    await Bun.sleep(1);
    slow?.(["172.20.0.2"]);
    const both = ["api", "db", "172.20.0.3", "172.20.0.8", "172.20.0.2"];
    expect(await first).toEqual(both);
    expect(await second).toEqual(both);
  });

  test("a name configured relative and absolute is asked both ways, and both answers are held off", async () => {
    const hosts = createInstallationHosts({
      names: installationHostNames({
        DATABASE_URL: "postgresql://user:pw@db.corp:5432/sessions",
        EGRESS_PRIVATE_DENY_HOSTS: "db.corp.",
      }),
      interfaces: () => [],
      lookup: answering({
        "db.corp": ["10.20.0.11"],
        "db.corp.": ["10.20.0.12"],
      }),
    });
    expect(await hosts()).toEqual(["db.corp", "10.20.0.11", "10.20.0.12"]);
  });

  test("a name is asked as it is configured and compared without its trailing dot", async () => {
    const asked: string[] = [];
    const hosts = createInstallationHosts({
      names: ["Postgres.", "[fd00::9]"],
      interfaces: () => [],
      lookup: answering({ "Postgres.": ["172.20.0.2"] }, asked),
    });
    expect(await hosts()).toEqual(["postgres", "fd00::9", "172.20.0.2"]);
    expect(asked).toEqual(["Postgres."]);
  });

  test("a name that stops resolving leaves no list, whatever it answered before", async () => {
    let clock = 0;
    let fail = false;
    const hosts = createInstallationHosts({
      names: ["api"],
      interfaces: () => [],
      lookup: async () => {
        if (fail) throw new Error("EAI_AGAIN");
        return [{ address: "172.20.0.3", family: 4 }];
      },
      now: () => clock,
    });
    expect(await hosts()).toEqual(["api", "172.20.0.3"]);
    fail = true;
    clock += 1;
    expect(await hosts()).toBeNull();
    fail = false;
    expect(await hosts()).toEqual(["api", "172.20.0.3"]);
  });
});

describe("what every private grant denies, from the API's own wiring", () => {
  test("the database, the gateway, the object store and the Kubernetes API by name and by address, this process's listeners, and what the operator adds", async () => {
    const names = installationHostNames({
      DATABASE_URL: "postgresql://user:pw@postgres:5432/sessions",
      WORKER_GATEWAY_URL: "http://api:3200",
      AWS_ENDPOINT_URL: "http://seaweedfs:8333",
      EGRESS_AUTHORIZER_HOST: "0.0.0.0",
      KUBERNETES_SERVICE_HOST: "10.96.0.1",
      EGRESS_PRIVATE_DENY_HOSTS: "172.30.64.1,vip.internal",
    });
    const hosts = createInstallationHosts({
      names,
      // Every listener of the API (public, /internal, authorizer, metrics,
      // trace ingest) answers on these, whatever its port.
      interfaces: () => ["127.0.0.1", "172.20.0.3"],
      lookup: async (host) =>
        (
          ({
            postgres: ["172.20.0.2"],
            api: ["172.20.0.3", "172.20.0.4"],
            seaweedfs: ["172.20.0.5"],
            "vip.internal": ["10.9.9.9"],
          }) as Record<string, string[]>
        )[host]?.map((address) => ({ address, family: 4 })) ?? [],
    });
    const denied = new Set(await hosts());
    for (const host of [
      // The database: its name, and the address the name resolves to.
      "postgres",
      "172.20.0.2",
      // The worker gateway and every replica behind its name.
      "api",
      "172.20.0.3",
      "172.20.0.4",
      // The object store.
      "seaweedfs",
      "172.20.0.5",
      // This process, on every port it listens on.
      "127.0.0.1",
      "0.0.0.0",
      "10.96.0.1",
      // The operator's own: a bridge gateway, a front VIP and its address.
      "172.30.64.1",
      "vip.internal",
      "10.9.9.9",
    ]) {
      expect([host, denied.has(host)]).toEqual([host, true]);
    }
  });
});
