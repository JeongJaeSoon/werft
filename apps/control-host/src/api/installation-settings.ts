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
