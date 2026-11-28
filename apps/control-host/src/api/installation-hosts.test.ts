import { describe, expect, test } from "bun:test";
import {
  createInstallationHosts,
  installationHostNames,
  MAX_DENIED_HOSTS,
} from "./installation-hosts.ts";

describe("installationHostNames", () => {
  test("reads the hosts the API is wired to, each in one spelling", () => {
    expect(
      installationHostNames({
        DATABASE_URL: "postgresql://user:pw@Postgres.:5432/sessions",
        WORKER_GATEWAY_URL: "http://api:3200",
        AWS_ENDPOINT_URL: "http://[FD00::9]:8333",
        EGRESS_AUTHORIZER_HOST: "0.0.0.0",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        EGRESS_PRIVATE_DENY_HOSTS: " vip.internal , 172.30.64.1,,",
      }).sort(),
    ).toEqual(
      [
        "0.0.0.0",
        "10.96.0.1",
        "172.30.64.1",
        "api",
        "fd00::9",
        "postgres",
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

  test("an address a name moved off stays denied for five minutes, and the name is asked again after thirty seconds", async () => {
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
    clock += 29_999;
    expect(await hosts()).toEqual(["api", "172.20.0.3"]);
    expect(asked).toHaveLength(1);
    clock += 1;
    // The replica that answered before is gone from the name's answer, and
    // is still held off.
    expect(await hosts()).toEqual(["api", "172.20.0.3", "172.20.0.8"]);
    expect(asked).toHaveLength(2);
    clock += 5 * 60_000 - 30_000;
    expect(await hosts()).toEqual(["api", "172.20.0.8"]);
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
    clock += 30_000;
    expect(await hosts()).toBeNull();
    fail = false;
    expect(await hosts()).toEqual(["api", "172.20.0.3"]);
  });
});
