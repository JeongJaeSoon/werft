import {
  type CredentialRef,
  type InstallationSettingsStore,
  type SettingsSnapshot,
  settingsCredentialRefs,
  settingsSnapshot,
} from "@werft-ai/platform";
import type { SecretReader } from "./catalog-config.ts";

function missingMessage(entry: string, name: string): string {
  const carry = `${entry} names ${name}, which the API does not have, so it is left out. Set ${name} and restart the API to carry the value into the database once`;
  return entry.startsWith("connection:")
    ? `${carry}, or enter the key on the connection in Settings > Connections`
    : carry;
}

/**
 * Where the api's registry reads the installation settings from, every
 * credential resolved: a stored value from the database on each read, a
 * Secrets Manager one once per process (rotating it means a restart, as
 * with the files). A reference that cannot be read leaves its row out of
 * that read and is tried again on the next.
 *
 * An env reference is no longer read: each read first carries its value
 * into a stored one, once. Until the first workspace exists there is
 * nothing to keep it under, so until then the value is read from `env`.
 * The warnings name variables, never values, and come once per row.
 */
export function settingsSource(options: {
  store: Pick<InstallationSettingsStore, "read" | "carryEnvCredentials">;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
  warn: (message: string) => void;
}): { read(): Promise<SettingsSnapshot> } {
  const fetched = new Map<string, string>();
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    options.warn(message);
  };
  return {
    async read() {
      const waiting = new Set<string>();
      for (const carry of await options.store.carryEnvCredentials(
        (name) => options.env[name],
      )) {
        const { entry, env } = carry;
        switch (carry.outcome) {
          case "carried": {
            const rebound =
              carry.rebound === undefined
                ? ""
                : ` (${carry.rebound.push_requests} push requests and ${carry.rebound.worker_credentials} worker credentials moved to its new binding)`;
            options.warn(
              `${entry} took its credential from ${env} into the database and no longer reads it; remove ${env}${rebound}`,
            );
            break;
          }
          case "rebound":
            options.warn(
              `${entry} moved ${carry.rebound.push_requests} push requests and ${carry.rebound.worker_credentials} worker credentials written with its old binding after the move to the new one`,
            );
            break;
          case "invalid":
            warnOnce(
              `${entry} invalid`,
              `${entry} is left out and not carried into the database: ${carry.reason}. Correct ${env} and restart the API`,
            );
            break;
          case "missing":
            warnOnce(`${entry} missing`, missingMessage(entry, env));
            break;
          case "waiting":
            waiting.add(env);
            warnOnce(
              `${entry} waiting`,
              `${entry} reads ${env} until the first workspace exists; then the API carries it into the database once`,
            );
            break;
          case "failed":
            warnOnce(
              `${entry} failed`,
              `${entry} could not carry ${env} into the database and is left out; it is tried again on each read`,
            );
            break;
        }
      }
      const settings = await options.store.read({ openStored: true });
      for (const ref of settingsCredentialRefs(settings)) {
        if (!("secret_id" in ref) || fetched.has(ref.secret_id)) continue;
        try {
          const value = await options.readSecret(ref.secret_id);
          if (value) fetched.set(ref.secret_id, value);
        } catch {
          // Named in left_out by the snapshot below.
        }
      }
      return settingsSnapshot(settings, (ref: CredentialRef) =>
        "value_env" in ref
          ? waiting.has(ref.value_env)
            ? options.env[ref.value_env]
            : undefined
          : "secret_id" in ref
            ? fetched.get(ref.secret_id)
            : undefined,
      );
    },
  };
}

/**
 * The egress proxy's credential allowlist when the api is given the same
 * value: the console warns about an endpoint outside it (owner decision 4,
 * a warning only). Null when unset: the api does not know it.
 */
export function credentialHostsFromEnv(
  env: Record<string, string | undefined>,
): string[] | null {
  const lists = [
    env.EGRESS_CREDENTIAL_ALLOWLIST,
    env.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST,
  ].filter((raw): raw is string => raw !== undefined && raw.trim() !== "");
  if (lists.length === 0) return null;
  return lists.flatMap((raw) =>
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

export function leftOutReporter(
  warn: (message: string, fields: Record<string, unknown>) => void,
): (snapshot: SettingsSnapshot) => void {
  let last = "[]";
  return (snapshot) => {
    const now = JSON.stringify(snapshot.left_out);
    if (now === last) return;
    last = now;
    if (snapshot.left_out.length > 0) {
      warn("Installation settings left out of this replica's catalog", {
        left_out: snapshot.left_out,
      });
    }
  };
}
