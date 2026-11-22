import {
  type InstallationSettingsStore,
  type SettingsSnapshot,
  settingsSnapshot,
} from "@werft-ai/platform";

/**
 * Where the api's registry reads the installation settings from, each
 * stored value opened on every read. A row without its value is left out
 * of that read and tried again on the next.
 */
export function settingsSource(options: {
  store: Pick<InstallationSettingsStore, "read">;
}): { read(): Promise<SettingsSnapshot> } {
  return {
    async read() {
      return settingsSnapshot(await options.store.read({ openStored: true }));
    },
  };
}

/**
 * The egress proxy's credential allowlist when the api is given the same
 * value: the console warns about an endpoint outside it (a warning only).
 * Null when unset: the api does not know it.
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
