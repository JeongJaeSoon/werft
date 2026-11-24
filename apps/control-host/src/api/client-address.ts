import { isIP } from "node:net";

/**
 * The network one client's attempts are counted under: an IPv4 address, or
 * the /64 an IPv6 address sits in (one host usually holds a whole /64).
 */
export type ClientNetwork = { network: string; private: boolean };

const IPV4_PRIVATE: ReadonlyArray<readonly [number, number, number]> = [
  // [first octet, second octet low, second octet high]
  [10, 0, 255],
  [127, 0, 255],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
];

function ipv4Private(address: string): boolean {
  const [a = -1, b = -1] = address.split(".").map(Number);
  return IPV4_PRIVATE.some(
    ([first, low, high]) => a === first && b >= low && b <= high,
  );
}

/** The eight groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  const [head = "", tail, extra] = address.split("::");
  if (extra !== undefined) return null;
  const part = (text: string) => (text === "" ? [] : text.split(":"));
  const left = part(head);
  const right = tail === undefined ? [] : part(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

/** Null for anything that is not one IP address. */
export function clientNetworkOf(raw: string): ClientNetwork | null {
  let address = raw.trim();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  address = address.split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) address = mapped[1];
  const version = isIP(address);
  if (version === 4) {
    return { network: address, private: ipv4Private(address) };
  }
  if (version !== 6) return null;
  const groups = ipv6Groups(address);
  if (!groups) return null;
  // ::ffff:a.b.c.d written in hex is the same IPv4 client.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const [high = 0, low = 0] = groups.slice(6);
    const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    return { network: ipv4, private: ipv4Private(ipv4) };
  }
  const [first = 0] = groups;
  const loopbackOrUnspecified = groups
    .slice(0, 7)
    .every((group) => group === 0);
  return {
    network: `${groups
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(":")}::/64`,
    private:
      loopbackOrUnspecified ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80,
  };
}

/**
 * Whose network a request comes from. With `header` set, the one header the
 * proxy in front writes; its last entry when it holds a list, since earlier
 * ones are what the client sent. Without it, or when the request lacks it,
 * the socket's peer. A private or loopback peer is every user at once behind
 * a tunnel, so it is not counted (null) unless the header named it.
 */
export function requestClientNetwork(
  input: { header: string | undefined; socket: string | undefined },
  headers: { get(name: string): string | null | undefined },
): { client: ClientNetwork | null; skippedPrivate: boolean } {
  if (input.header !== undefined) {
    const value = headers.get(input.header);
    const last = value?.split(",").at(-1);
    const named = last === undefined ? null : clientNetworkOf(last);
    if (named) return { client: named, skippedPrivate: false };
  }
  const peer =
    input.socket === undefined ? null : clientNetworkOf(input.socket);
  if (peer?.private) return { client: null, skippedPrivate: true };
  return { client: peer, skippedPrivate: false };
}
