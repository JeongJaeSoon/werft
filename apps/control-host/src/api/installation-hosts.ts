import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolveEveryTime } from "@werft-ai/system";
import type { Lookup } from "./oidc/provider-http.ts";
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
/**
 * How long an address a name answered with stays denied after the name
 * moved: a connection to it may outlive the answer, as the proxy keeps the
 * authorizer's for the same five minutes.
 */
const MEMORY_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * A name asked of the resolver on every call, as the egress proxy asks: an
 * answer kept for its TTL would leave a host that moved out of the list
 * the proxy is judging the new address against.
 */
export const freshLookup: Lookup = (host) => resolveEveryTime(host);

/**
 * The hosts this installation is wired to, read from the API's own
 * environment and spelled as configured: its database, its worker gateway,
 * its object store, its authorizer listener, the Kubernetes API, and what
 * the deployment and the operator add in `EGRESS_PRIVATE_DENY_HOSTS` (the
 * API's own Service names, a front VIP or NAT address no interface of this
 * process shows). Throws on a value that names no host: a deny list with a
 * hole is not one.
 */
export function installationHostNames(
  env: Record<string, string | undefined>,
): string[] {
  // By spelling, not by key: `db.corp` and `db.corp.` are one key and may
  // be two answers where a search domain is set, and both are held off.
  const names = new Set<string>();
  const add = (variable: string, host: string) => {
    if (hostKey(host) === null) {
      throw new Error(
        `${variable} names no host a private upstream can be held off`,
      );
    }
    names.add(host.toLowerCase());
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
 * interfaces and each of `names` with the addresses it resolves to, all
 * read on each call, and the addresses a name answered with in the last
 * five minutes. Null when a name cannot be resolved or the list would pass
 * what the proxy reads: the caller then gives no private grant, never a
 * shorter list.
 */
export function createInstallationHosts(deps: {
  names: readonly string[];
  interfaces?: () => readonly string[];
  lookup?: Lookup;
  /** A clock that never steps back; what it counts from does not matter. */
  now?: () => number;
}): () => Promise<readonly string[] | null> {
  const lookup = deps.lookup ?? freshLookup;
  const now = deps.now ?? (() => performance.now());
  const interfaces =
    deps.interfaces ??
    (() =>
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).map((entry) => entry.address),
      ));
  // The key each name is compared by, and the spelling the resolver is
  // asked: a trailing dot keeps a name off the search domains.
  const wired = deps.names.map((name) => {
    const key = hostKey(name);
    if (key === null) throw new Error("A wired host names no host");
    return { key, name: name.replace(/^\[|\]$/g, "") };
  });
  // Per name, each address it answered with and when that lapses. One map
  // per name for the life of the process, only ever added to and aged.
  const answered = new Map<string, Map<string, number>>();
  // One collection of every name at a time: calls that overlap share it and
  // its outcome, so none builds a list on an older answer than another, or
  // on a name whose newer question failed.
  let collecting: Promise<readonly string[] | null> | undefined;

  /** Whether `name` answered; what it answered with is in `answered`. */
  async function ask(name: string): Promise<boolean> {
    // An address names itself; its key is already in the list.
    if (isIP(name) !== 0) return true;
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
      return false;
    } finally {
      clearTimeout(timer);
    }
    const keys = answers.map(({ address }) => answerKey(address));
    if (keys.length === 0 || keys.includes(null)) return false;
    const at = now();
    let until = answered.get(name);
    if (until === undefined) {
      until = new Map();
      answered.set(name, until);
    }
    for (const key of keys) until.set(key as string, at + MEMORY_MS);
    for (const [address, end] of until) {
      if (end <= at) until.delete(address);
    }
    return true;
  }

  async function collect(): Promise<readonly string[] | null> {
    const hosts = new Set<string>(wired.map(({ key }) => key));
    for (const address of interfaces()) {
      const key = answerKey(address);
      if (key === null) return null;
      hosts.add(key);
    }
    const all = await Promise.all(wired.map(({ name }) => ask(name)));
    if (all.includes(false)) return null;
    const at = now();
    for (const { name } of wired) {
      for (const [address, end] of answered.get(name) ?? []) {
        if (end > at) hosts.add(address);
      }
    }
    return hosts.size > MAX_DENIED_HOSTS ? null : [...hosts];
  }

  return () => {
    collecting ??= collect().finally(() => {
      collecting = undefined;
    });
    return collecting;
  };
}
