import { describe, expect, test } from "bun:test";
import {
  type AddressClass,
  classifyAddress,
  isMetadataName,
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
    ["169.254.169.254", "metadata"],
    ["169.254.169.253", "link_local"],
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
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:a9fe:a9fe", "metadata"],
    ["::ffff:a9fe:1", "link_local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["64:ff9b::a9fe:1", "link_local"],
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

  // Each was private or link-local before; metadata is its own class so the
  // private lists cannot reach it.
  test.each<[string, AddressClass]>([
    ["169.254.169.254", "metadata"],
    ["169.254.170.2", "metadata"],
    ["169.254.170.23", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["fd00:ec2::23", "metadata"],
    ["fe80::a9fe:a9fe%eth0", "metadata"],
    ["FD00:EC2::254", "metadata"],
    ["fd00:0ec2:0:0:0:0:0:254", "metadata"],
    ["fd00:ec2::254%eth0", "metadata"],
    ["fd00:ec2::254%25en0", "metadata"],
    ["::ffff:100.100.100.200", "metadata"],
    ["::ffff:6464:64c8", "metadata"],
    ["64:ff9b::100.100.100.200", "metadata"],
    ["64:ff9b::6464:64c8", "metadata"],
    ["::ffff:169.254.170.2", "metadata"],
    ["64:ff9b::a9fe:aa17", "metadata"],
    // Their neighbours keep the class they had.
    ["100.100.100.201", "private"],
    ["169.254.170.3", "link_local"],
    ["fd00:ec3::254", "private"],
    ["fd01:ec2::254", "private"],
    // AWS's DNS and time servers hand out no credentials.
    ["fd00:ec2::253", "private"],
    ["fd00:ec2::123", "private"],
    ["fd20:ce::253", "private"],
    ["fd00:42::43", "private"],
    ["169.254.42.43", "link_local"],
    ["fe80::a9fe:a9ff", "link_local"],
    ["192.0.0.193", "reserved"],
    ["::ffff:100.100.100.201", "private"],
  ])("%s is %s", (address, expected) => {
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
      // A trailing dot is a name, never the address it looks like.
      "100.100.100.200.",
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
    // Metadata sits inside private ranges and is never taken as private.
    ["100.100.100.200", false],
    ["fd00:ec2::254", false],
    ["fd00:ec2::254%eth0", false],
    ["fd00:ec3::254", true],
  ])("%s is %p", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

// Each cloud's documented metadata address (sources in ip-address.ts).
const CLOUD_METADATA: readonly [cloud: string, address: string][] = [
  ["AWS EC2", "169.254.169.254"],
  ["AWS EC2 IPv6", "fd00:ec2::254"],
  ["AWS ECS", "169.254.170.2"],
  ["AWS EKS Pod Identity", "169.254.170.23"],
  ["AWS EKS Pod Identity IPv6", "fd00:ec2::23"],
  ["GCP", "169.254.169.254"],
  ["GCP IPv6", "fd20:ce::254"],
  ["Azure", "169.254.169.254"],
  ["Alibaba", "100.100.100.200"],
  ["Oracle", "169.254.169.254"],
  ["Oracle Compute Classic", "192.0.0.192"],
  ["Scaleway", "169.254.42.42"],
  ["Scaleway IPv6", "fd00:42::42"],
  ["DigitalOcean", "169.254.169.254"],
  ["Hetzner", "169.254.169.254"],
  ["Hetzner IPv6", "fe80::a9fe:a9fe"],
  ["OpenStack", "169.254.169.254"],
  ["OpenStack IPv6", "fe80::a9fe:a9fe"],
];

describe("each cloud's metadata address", () => {
  test.each(CLOUD_METADATA)(
    "%s: %s is metadata, never private",
    (_, address) => {
      expect(classifyAddress(address)).toBe("metadata");
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("isMetadataName", () => {
  test.each<[string, boolean]>([
    ["metadata", true],
    ["metadata.google.internal", true],
    ["metadata.goog", true],
    ["instance-data.ec2.internal", true],
    ["METADATA.Google.Internal", true],
    ["metadata.google.internal.", true],
    ["metadata.", true],
    ["metadata.google.internal.evil.test", false],
    ["my-metadata", false],
    ["metadata.example.com", false],
    ["api.example.com", false],
  ])("%s is %p", (host, expected) => {
    expect(isMetadataName(host)).toBe(expected);
  });
});
