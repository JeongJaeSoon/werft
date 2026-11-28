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
        // Not read beside an endpoint the storage client is given.
        AWS_ENDPOINT_URL_S3: "https://retired-store.internal",
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
    // The object store the AWS SDK falls back to, while the store is on.
    const sdk = { AWS_ENDPOINT_URL_S3: "https://s3.corp.internal" };
    expect(installationHostNames(sdk)).toEqual(["s3.corp.internal"]);
    expect(
      installationHostNames({ ...sdk, CHECKPOINT_OBJECT_STORE: "disabled" }),
    ).toEqual([]);
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

  test("each call asks every name itself, and its list holds what any call has learnt", async () => {
    const answers: Array<(addresses: string[] | Error) => void> = [];
    const hosts = createInstallationHosts({
      names: ["api"],
      interfaces: () => [],
      lookup: () =>
        new Promise((resolve, reject) => {
          answers.push((addresses) =>
            addresses instanceof Error
              ? reject(addresses)
              : resolve(addresses.map((address) => ({ address, family: 4 }))),
          );
        }),
    });
    const first = hosts();
    const second = hosts();
    await Bun.sleep(1);
    // Not one question shared: the second call's is asked after it was made.
    expect(answers).toHaveLength(2);
    // The later question answers first, with the address the name moved to.
    answers[1]?.(["172.20.0.9"]);
    expect(await second).toEqual(["api", "172.20.0.9"]);
    // The earlier one answers late with the older address: it is added, and
    // nothing the later one learnt is lost.
    answers[0]?.(["172.20.0.8"]);
    expect(await first).toEqual(["api", "172.20.0.9", "172.20.0.8"]);
  });

  test("a call waiting on a slow name is closed when a later question of another name fails", async () => {
    let store: string[] | Error = ["172.20.0.5"];
    const slow: Array<(addresses: string[]) => void> = [];
    const hosts = createInstallationHosts({
      names: ["store", "db"],
      interfaces: () => [],
      // A clock that reads the same all along: the order of the questions
      // does not come from it.
      now: () => 7,
      lookup: (host) => {
        if (host === "db") {
          return new Promise((resolve) => {
            slow.push((addresses) =>
              resolve(addresses.map((address) => ({ address, family: 4 }))),
            );
          });
        }
        return store instanceof Error
          ? Promise.reject(store)
          : Promise.resolve(store.map((address) => ({ address, family: 4 })));
      },
    });
    const first = hosts();
    await Bun.sleep(1);
    // The store moves and its name cannot be asked for a moment: the call
    // that asked before does not go out on the address it left.
    store = new Error("EAI_AGAIN");
    const second = hosts();
    await Bun.sleep(1);
    for (const answer of slow) answer(["172.20.0.2"]);
    expect(await second).toBeNull();
    expect(await first).toBeNull();
    // Asked again and answered, the list is whole, with both addresses.
    store = ["172.20.0.6"];
    const third = hosts();
    await Bun.sleep(1);
    slow.at(-1)?.(["172.20.0.2"]);
    expect(await third).toEqual([
      "store",
      "db",
      "172.20.0.5",
      "172.20.0.6",
      "172.20.0.2",
    ]);
  });

  test("an address this process took while the names were asked is in the list", async () => {
    let addresses = ["172.20.0.3"];
    let answer: (() => void) | undefined;
    const hosts = createInstallationHosts({
      names: ["db"],
      interfaces: () => addresses,
      lookup: () =>
        new Promise((resolve) => {
          answer = () => resolve([{ address: "172.20.0.2", family: 4 }]);
        }),
    });
    const list = hosts();
    await Bun.sleep(1);
    addresses = ["172.20.0.3", "10.9.0.3"];
    answer?.();
    expect(await list).toEqual(["db", "172.20.0.3", "10.9.0.3", "172.20.0.2"]);
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
