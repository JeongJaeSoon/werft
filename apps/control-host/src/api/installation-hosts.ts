import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { defaultLookup, type Lookup } from "./oidc/provider-http.ts";
import { addressKey, hostKey } from "./oidc/registered-network.ts";

/** An answer's key, or null for one that is no address. */
function answerKey(answer: string): string | null {
  const zone = answer.indexOf("%");
  return isIP(zone < 0 ? answer : answer.slice(0, zone)) === 0
    ? null
    : addressKey(answer);
}

/** What the egress proxy reads of a grant's deny list, and no more. */
export const MAX_DENIED_HOSTS = 256;
/** How long a name's answer is used before it is asked again. */
const REFRESH_MS = 30_000;
/**
 * How long an address a name answered with stays denied after the name
 * moved: a connection to it may outlive the answer, as the proxy keeps the
 * authorizer's for the same five minutes.
 */
const MEMORY_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The hosts this installation is wired to, read from the API's own
 * environment: its database, its worker gateway, its object store, its
 * authorizer listener, the Kubernetes API, and what the operator adds in
 * `EGRESS_PRIVATE_DENY_HOSTS` (a front VIP or NAT address no interface of
 * this process shows). Throws on a value that names no host: a deny list
 * with a hole is not one.
 */
export function installationHostNames(
  env: Record<string, string | undefined>,
): string[] {
  const names = new Set<string>();
  const add = (variable: string, host: string) => {
    const key = hostKey(host);
    if (key === null) {
      throw new Error(
        `${variable} names no host a private upstream can be held off`,
      );
    }
    names.add(key);
  };
  for (const variable of [
    "DATABASE_URL",
    "WORKER_GATEWAY_URL",
    "AWS_ENDPOINT_URL",
  ]) {
    const value = env[variable]?.trim();
    if (!value) continue;
    const host = URL.parse(value)?.hostname ?? "";
    // A database reached by a socket path names no host to hold off.
    if (host === "" && variable === "DATABASE_URL") continue;
    add(variable, host);
  }
  for (const variable of [
    "EGRESS_AUTHORIZER_HOST",
    "KUBERNETES_SERVICE_HOST",
  ]) {
    const value = env[variable]?.trim();
    if (value) add(variable, value);
  }
  for (const entry of (env.EGRESS_PRIVATE_DENY_HOSTS ?? "").split(",")) {
    if (entry.trim() !== "") add("EGRESS_PRIVATE_DENY_HOSTS", entry.trim());
  }
  return [...names];
}

/**
 * The installation's own hosts as keys, for a private grant's deny list
 * and for refusing one at registration: every address of this process's
 * interfaces, read on each call, and each of `names` with the addresses it
 * resolves to now or did in the last five minutes. Null when a name cannot
 * be resolved or the list would pass what the proxy reads: the caller then
 * gives no private grant, never a shorter list.
 */
export function createInstallationHosts(deps: {
  names: readonly string[];
  interfaces?: () => readonly string[];
  lookup?: Lookup;
  now?: () => number;
}): () => Promise<readonly string[] | null> {
  const lookup = deps.lookup ?? defaultLookup;
  const now = deps.now ?? Date.now;
  const interfaces =
    deps.interfaces ??
    (() =>
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).map((entry) => entry.address),
      ));
  // Per name: when it was last asked, and each address with when it lapses.
  const seen = new Map<string, { asked: number; until: Map<string, number> }>();

  async function addressesOf(name: string): Promise<string[] | null> {
    // An address names itself; the name's own key is already in the list.
    if (isIP(name) !== 0) return [];
    const at = now();
    let known = seen.get(name);
    if (known === undefined || at - known.asked >= REFRESH_MS) {
      let answers: readonly { address: string }[];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A lookup cannot be cancelled; one that answers late is not used.
        answers = await Promise.race([
          lookup(name),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("lookup timed out")),
              LOOKUP_TIMEOUT_MS,
            );
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      const keys = answers.map(({ address }) => answerKey(address));
      if (keys.length === 0 || keys.includes(null)) return null;
      known = { asked: at, until: known?.until ?? new Map() };
      for (const key of keys) known.until.set(key as string, at + MEMORY_MS);
      seen.set(name, known);
    }
    for (const [address, end] of known.until) {
      if (end <= at) known.until.delete(address);
    }
    return [...known.until.keys()];
  }

  return async () => {
    const hosts = new Set<string>(deps.names);
    for (const address of interfaces()) {
      const key = answerKey(address);
      if (key === null) return null;
      hosts.add(key);
    }
    const resolved = await Promise.all(deps.names.map(addressesOf));
    for (const addresses of resolved) {
      if (addresses === null) return null;
      for (const address of addresses) hosts.add(address);
    }
    return hosts.size > MAX_DENIED_HOSTS ? null : [...hosts];
  };
}
