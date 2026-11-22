import { describe, expect, test } from "bun:test";
import {
  type AddressClass,
  classifyAddress,
  isPrivateAddress,
} from "./ip-address.ts";

describe("classifyAddress", () => {
  test.each<[string, AddressClass]>([
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["ff02::1", "multicast"],
    ["fd00::1", "private"],
    ["2001:db8::1", "reserved"],
    ["100::1", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["2a00:1450:4001::1", "public"],
    ["2001:200::1", "public"],
    ["3fff:1000::1", "public"],
    // IPv4 inside IPv6 is judged as the IPv4 address.
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:a9fe:a9fe", "link_local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::a9fe:a9fe", "link_local"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::808:808", "public"],
    ["64:ff9b:1::a9fe:a9fe", "reserved"],
    ["64:ff9b:1:a00:0:100::", "reserved"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  // Where the egress proxy and the control plane's provider requests used to
  // disagree, each address now takes the answer that refuses more. The
  // columns are the new class, then the egress proxy's and the control
  // plane's before.
  test.each<
    [string, AddressClass | null, AddressClass | null, AddressClass | null]
  >([
    ["fec0::1", "reserved", "private", "reserved"],
    ["fecf::1", "reserved", "private", "reserved"],
    ["::ffff:0:10.0.0.1", "reserved", "private", "reserved"],
    ["::ffff:0:169.254.169.254", "reserved", "link_local", "reserved"],
    ["::169.254.169.254", "reserved", "link_local", "reserved"],
    ["::8.8.8.8", "reserved", "public", "reserved"],
    ["2002:a00:1::1", "reserved", "private", "reserved"],
    ["2002:a9fe:a9fe::1", "reserved", "link_local", "reserved"],
    ["2002:0808:0808::1", "reserved", "public", "reserved"],
    ["4000::1", "reserved", "public", "reserved"],
    ["2001::1", "reserved", "public", "reserved"],
    ["2001:2::1", "reserved", "public", "reserved"],
    ["2001:1ff:ffff::1", "reserved", "public", "reserved"],
    ["3fff::1", "reserved", "public", "reserved"],
    ["010.0.0.1", null, null, "private"],
  ])("%s is %s (egress was %s, control plane was %s)", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test("text that is not an address at all is null", () => {
    for (const text of [
      "example.com",
      "not-an-address",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "1.2.3.256",
      "1::2::3",
      "1:2:3:4:5:6:7",
      "12345::1",
    ]) {
      expect(classifyAddress(text), text).toBeNull();
    }
  });
});

describe("isPrivateAddress", () => {
  test.each<[string, boolean]>([
    ["10.0.0.5", true],
    ["172.20.1.2", true],
    ["192.168.1.10", true],
    ["100.100.1.1", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["fd12:3456::1", true],
    ["fc00::1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2001:db8::1", false],
    ["fc::1", false],
    ["fec0::1", false],
    ["010.0.0.1", false],
    ["example.com", false],
    // Link-local was private here before; it is not reachable through the
    // egress proxy at all.
    ["169.254.1.1", false],
    ["fe80::1", false],
    // IPv4 carried inside IPv6 is never taken as private, whatever it carries.
    ["::ffff:10.0.0.1", false],
    ["::ffff:a00:1", false],
    ["::ffff:127.0.0.1", false],
    ["64:ff9b::a00:1", false],
    ["2002:a00:1::1", false],
    ["::10.0.0.1", false],
  ])("%s is %p", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});
