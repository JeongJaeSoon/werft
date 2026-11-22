import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideEgress,
  type EgressPolicy,
  parseDestination,
  parseDestinations,
} from "./policy.ts";

describe("classifyAddress", () => {
  test("runs the platform's address classes, copied byte for byte", () => {
    const copy = readFileSync(join(import.meta.dir, "ip-address.ts"), "utf8");
    const platform = readFileSync(
      join(import.meta.dir, "../../../packages/system/src/ip-address.ts"),
      "utf8",
    );
    expect(copy).toBe(platform);
  });
});

describe("parseDestination", () => {
  test("host:port and bracketed IPv6", () => {
    expect(parseDestination("api.example.com:443", "list")).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(parseDestination("[::1]:3000", "list")).toEqual({
      host: "::1",
      port: 3000,
    });
    expect(parseDestination(" Gateway.Test.:3000 ", "list")).toEqual({
      host: "gateway.test",
      port: 3000,
    });
  });

  test("an entry without a usable port is rejected", () => {
    expect(() => parseDestination("api.example.com", "list")).toThrow("list");
    expect(() => parseDestination("api.example.com:0", "list")).toThrow("list");
    expect(() => parseDestination("api.example.com:https", "list")).toThrow(
      "list",
    );
    expect(() => parseDestination(":443", "list")).toThrow("list");
  });

  test("a list splits on commas and ignores blanks", () => {
    expect(parseDestinations("a.test:80, b.test:443 ,", "list")).toEqual([
      { host: "a.test", port: 80 },
      { host: "b.test", port: 443 },
    ]);
    expect(parseDestinations("", "list")).toEqual([]);
  });
});

describe("decideEgress", () => {
  const policy: EgressPolicy = {
    allow: [{ host: "api.example.com", port: 443 }],
    allowPrivate: [
      { host: "host.docker.internal", port: 3000 },
      { host: "metadata.test", port: 80 },
    ],
  };
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const addresses = map[host];
    if (addresses === undefined) throw new Error(`no such host ${host}`);
    return addresses;
  };

  test("a public destination that resolves publicly is allowed", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toEqual({ addresses: ["93.184.216.34"], allowed: true, scope: "public" });
  });

  test("the same host on another port is not allowlisted", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 8443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "destination is not allowlisted",
    });
  });

  test("a host outside both lists is denied before it is resolved", async () => {
    let resolved = false;
    expect(
      await decideEgress(policy, { host: "evil.test", port: 443 }, async () => {
        resolved = true;
        return ["93.184.216.34"];
      }),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "destination is not allowlisted",
    });
    expect(resolved).toBe(false);
  });

  test("a public entry that resolves into the private plane is denied", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["10.0.0.5"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "10.0.0.5 is private, not public",
    });
  });

  test("one bad address among good ones denies the whole destination", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34", "127.0.0.1"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "127.0.0.1 is loopback, not public",
    });
  });

  // 6to4 tunnels through a relay we do not choose; it was judged as the
  // IPv4 address it carried, so a public one passed.
  test("a public entry that resolves to 6to4 is denied", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["2002:0808:0808::1"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "2002:0808:0808::1 is reserved",
    });
  });

  test("a private entry that resolves to site-local fec0::/10 is denied", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "host.docker.internal", port: 3000 },
        resolver({ "host.docker.internal": ["fec0::1"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "fec0::1 is reserved",
    });
  });

  test("a private entry may resolve to a private address", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "host.docker.internal", port: 3000 },
        resolver({ "host.docker.internal": ["192.168.65.254"] }),
      ),
    ).toEqual({
      addresses: ["192.168.65.254"],
      allowed: true,
      scope: "private",
    });
  });

  test("link-local is refused even from the private list", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "metadata.test", port: 80 },
        resolver({ "metadata.test": ["169.254.169.254"] }),
      ),
    ).toEqual({
      allowed: false,
      failure: "denied",
      reason: "169.254.169.254 is link_local",
    });
  });

  test("a host that does not resolve is denied, not allowed by default", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({}),
      ),
    ).toEqual({
      allowed: false,
      failure: "unresolved",
      reason: "host does not resolve: no such host api.example.com",
    });
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        async () => [],
      ),
    ).toEqual({
      allowed: false,
      failure: "unresolved",
      reason: "host does not resolve",
    });
  });

  test("the trailing dot spelling of an allowlisted host still matches", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "API.example.com.", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toMatchObject({ allowed: true });
  });
});
