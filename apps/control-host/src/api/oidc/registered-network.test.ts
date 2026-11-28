import { describe, expect, test } from "bun:test";
import {
  addressKey,
  hostKey,
  registeredNetwork,
} from "./registered-network.ts";

describe("hostKey", () => {
  // The egress proxy's own table (credential.test.ts): a deny entry made
  // here is compared there, so the two read a host the same way.
  test("reads a host as an upstream URL naming it is read", () => {
    const keys: Array<[string, string | null]> = [
      ["DB.", "db"],
      ["db..", "db"],
      ["Model.Internal...", "model.internal"],
      ["10.0.0.5.", "10.0.0.5"],
      ["127.1..", "127.0.0.1"],
      ["api_internal", "api_internal"],
      ["10.0.0.5", "10.0.0.5"],
      ["2130706433", "127.0.0.1"],
      ["0x7f.1", "127.0.0.1"],
      ["010.0.0.5", "8.0.0.5"],
      ["[FD00::1]", "fd00::1"],
      ["fd00:0:0:0:0:0:0:1", "fd00::1"],
      ["::ffff:10.0.0.5", "10.0.0.5"],
      ["[::FFFF:A00:5]", "10.0.0.5"],
      ["", null],
      [".", null],
      ["..", null],
      ["db:5432", null],
      ["[fd00::1]:80", null],
      ["db/path", null],
      ["user@db", null],
      ["a b", null],
      ["fe80::1%eth0", null],
      ["1.2.3.4.5", null],
    ];
    for (const [host, key] of keys) {
      expect([host, hostKey(host)]).toEqual([host, key]);
      if (key !== null) expect([host, hostKey(key)]).toEqual([host, key]);
    }
  });

  test("an address is compared without its zone", () => {
    expect(addressKey("fe80::1%eth0")).toBe("fe80::1");
    expect(addressKey("FD00:0:0:0:0:0:0:7")).toBe("fd00::7");
  });
});

describe("registeredNetwork", () => {
  const none = new Set<string>();

  test("public when every answer is, private when every answer is private as written", () => {
    expect(registeredNetwork("api.example.com", ["93.184.216.34"], none)).toBe(
      "public",
    );
    expect(
      registeredNetwork(
        "api.example.com",
        ["93.184.216.34", "2606:4700::1"],
        none,
      ),
    ).toBe("public");
    expect(registeredNetwork("llm.corp", ["10.0.0.5"], none)).toBe("private");
    expect(
      registeredNetwork(
        "llm.corp",
        ["10.0.0.5", "192.168.1.9", "fd12::9"],
        none,
      ),
    ).toBe("private");
    expect(registeredNetwork("10.0.0.5", ["10.0.0.5"], none)).toBe("private");
  });

  test("public and private answers mixed are neither", () => {
    expect(
      registeredNetwork("llm.corp", ["10.0.0.5", "93.184.216.34"], none),
    ).toBeNull();
    expect(
      registeredNetwork("llm.corp", ["93.184.216.34", "10.0.0.5"], none),
    ).toBeNull();
  });

  test("what is never reached is refused, alone or beside an address that would pass", () => {
    const never = [
      // Cloud metadata, in every spelling the classifier knows.
      "169.254.169.254",
      "169.254.170.2",
      "100.100.100.200",
      "fd00:ec2::254",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      // Loopback.
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "::ffff:127.0.0.1",
      // Link-local, unspecified, multicast, reserved.
      "169.254.10.10",
      "fe80::1",
      "0.0.0.0",
      "::",
      "224.0.0.251",
      "ff02::1",
      "240.0.0.1",
      // A private IPv4 address carried inside IPv6.
      "::ffff:10.0.0.5",
      "64:ff9b::a00:5",
      // Not an address at all.
      "not-an-address",
    ];
    for (const address of never) {
      expect([address, registeredNetwork("llm.corp", [address], none)]).toEqual(
        [address, null],
      );
      expect([
        address,
        registeredNetwork("llm.corp", ["10.0.0.5", address], none),
      ]).toEqual([address, null]);
    }
    expect(registeredNetwork("llm.corp", [], none)).toBeNull();
  });

  test("a metadata name is refused whatever it resolves to", () => {
    for (const name of [
      "metadata.google.internal",
      "Metadata.",
      "metadata..",
      "instance-data.ec2.internal",
    ]) {
      expect([name, registeredNetwork(name, ["10.0.0.5"], none)]).toEqual([
        name,
        null,
      ]);
    }
  });

  test("the installation's own hosts are refused by name and by address, in any spelling", () => {
    const own = new Set(["postgres", "10.0.0.7", "fd00::7", "172.20.0.3"]);
    expect(registeredNetwork("postgres", ["10.0.0.9"], own)).toBeNull();
    expect(registeredNetwork("POSTGRES..", ["10.0.0.9"], own)).toBeNull();
    expect(registeredNetwork("llm.corp", ["10.0.0.7"], own)).toBeNull();
    expect(
      registeredNetwork("llm.corp", ["10.0.0.5", "10.0.0.7"], own),
    ).toBeNull();
    expect(
      registeredNetwork("llm.corp", ["fd00:0:0:0:0:0:0:7"], own),
    ).toBeNull();
    expect(registeredNetwork("167772167", ["10.0.0.7"], own)).toBeNull();
    expect(registeredNetwork("llm.corp", ["10.0.0.5"], own)).toBe("private");
  });
});
