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
 * interfaces and each of `names` with the addresses it resolves to, and
 * the addresses a name answered with in the last five minutes. Every call
 * asks every name itself, after it was made, so its list is never older
 * than the call; it adds what any other call learnt meanwhile. Null when a
 * name cannot be resolved, when a later question of a name failed while
 * this call waited, or when the list would pass what the proxy reads: the
 * caller then gives no private grant, never a shorter list.
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
  // Per name: each address it answered with and when that lapses, and the
  // newest question of it that failed. One per name for the life of the
  // process; the addresses are only ever added to and aged.
  const known = new Map<
    string,
    { until: Map<string, number>; failed: number }
  >();
  // Questions are told apart by the order they were asked in, not by the
  // clock, which may read the same for two of them.
  let questions = 0;

  /** Which question `name` answered, or null when it did not. */
  async function ask(name: string): Promise<number | null> {
    questions += 1;
    const question = questions;
    // An address names itself; its key is already in the list.
    if (isIP(name) !== 0) return question;
    let state = known.get(name);
    if (state === undefined) {
      state = { until: new Map(), failed: 0 };
      known.set(name, state);
    }
    const { until } = state;
    const failed = () => {
      state.failed = Math.max(state.failed, question);
      return null;
    };
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
      return failed();
    } finally {
      clearTimeout(timer);
    }
    const keys = answers.map(({ address }) => answerKey(address));
    if (keys.length === 0 || keys.includes(null)) return failed();
    const at = now();
    for (const key of keys) until.set(key as string, at + MEMORY_MS);
    for (const [address, end] of until) {
      if (end <= at) until.delete(address);
    }
    return question;
  }

  return async () => {
    const before = interfaces();
    const asked = await Promise.all(wired.map(({ name }) => ask(name)));
    const hosts = new Set<string>(wired.map(({ key }) => key));
    // Read again: an address this process took while the names were asked.
    for (const address of [...before, ...interfaces()]) {
      const key = answerKey(address);
      if (key === null) return null;
      hosts.add(key);
    }
    const at = now();
    for (const [index, { name }] of wired.entries()) {
      const mine = asked[index];
      if (mine === null || mine === undefined) return null;
      const state = known.get(name);
      if (state === undefined) continue;
      // A question of this name asked after this call's failed: what this
      // call holds of it may be behind, and nothing says it is not.
      if (state.failed > mine) return null;
      for (const [address, end] of state.until) {
        if (end > at) hosts.add(address);
      }
    }
    return hosts.size > MAX_DENIED_HOSTS ? null : [...hosts];
  };
}
