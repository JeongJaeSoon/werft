import { describe, expect, test } from "bun:test";
import { clientNetworkOf, requestClientNetwork } from "./client-address.ts";

describe("clientNetworkOf", () => {
  test("counts IPv4 per address and marks private ranges", () => {
    expect(clientNetworkOf("203.0.113.9")).toEqual({
      network: "203.0.113.9",
      private: false,
    });
    for (const address of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(clientNetworkOf(address)?.private).toBe(true);
    }
    expect(clientNetworkOf("172.32.0.1")?.private).toBe(false);
    expect(clientNetworkOf("::ffff:198.51.100.1")).toEqual({
      network: "198.51.100.1",
      private: false,
    });
    // The same mapped addresses in hex are the same clients, not one /64.
    expect(clientNetworkOf("::ffff:cb00:7109")).toEqual({
      network: "203.0.113.9",
      private: false,
    });
    expect(clientNetworkOf("0:0:0:0:0:FFFF:CB00:710A")?.network).toBe(
      "203.0.113.10",
    );
    expect(clientNetworkOf("::ffff:a00:1")).toEqual({
      network: "10.0.0.1",
      private: true,
    });
  });

  test("counts IPv6 per /64", () => {
    const one = clientNetworkOf("2001:db8:1:2::a");
    expect(one).toEqual({ network: "2001:db8:1:2::/64", private: false });
    expect(clientNetworkOf("[2001:0db8:0001:0002:ffff:1:2:3]")).toEqual(one);
    expect(clientNetworkOf("2001:db8:1:3::a")?.network).toBe(
      "2001:db8:1:3::/64",
    );
    for (const address of ["::1", "::", "fd00::1", "fe80::1%en0"]) {
      expect(clientNetworkOf(address)?.private).toBe(true);
    }
  });

  test("refuses what is not one address", () => {
    for (const raw of ["", "unknown", "1.2.3", "1::2::3", "203.0.113.9:443"]) {
      expect(clientNetworkOf(raw)).toBeNull();
    }
  });
});

describe("requestClientNetwork", () => {
  const headers = (entries: Record<string, string> = {}) =>
    new Headers(entries);

  test("uses the socket peer without a header", () => {
    expect(
      requestClientNetwork(
        { header: undefined, socket: "203.0.113.9" },
        headers({ "cf-connecting-ip": "198.51.100.1" }),
      ),
    ).toEqual({
      client: { network: "203.0.113.9", private: false },
      skippedPrivate: false,
    });
  });

  test("skips a private peer: behind a tunnel it is everyone", () => {
    expect(
      requestClientNetwork(
        { header: undefined, socket: "127.0.0.1" },
        headers(),
      ),
    ).toEqual({ client: null, skippedPrivate: true });
    expect(
      requestClientNetwork({ header: undefined, socket: undefined }, headers()),
    ).toEqual({ client: null, skippedPrivate: false });
  });

  test("takes the last entry of the configured header", () => {
    expect(
      requestClientNetwork(
        { header: "x-forwarded-for", socket: "10.0.0.2" },
        headers({ "x-forwarded-for": "192.0.2.1, 198.51.100.7" }),
      ).client,
    ).toEqual({ network: "198.51.100.7", private: false });
    // A header without a usable address falls back to the peer.
    expect(
      requestClientNetwork(
        { header: "cf-connecting-ip", socket: "10.0.0.2" },
        headers({ "cf-connecting-ip": "garbage" }),
      ),
    ).toEqual({ client: null, skippedPrivate: true });
  });
});
