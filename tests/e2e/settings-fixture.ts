import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  parseSettingsDocument,
  type SessionCatalog,
  settingsSnapshot,
} from "@werft-ai/platform";

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/**
 * The catalog the API would read after migrate imported the fixture and the
 * stack's seed step set its values: `values` holds what was set, by
 * `<kind>:<id>`; a stored entry without one does not resolve. Every
 * repository holds the fake GitHub App's key, as the seed step sets it.
 */
export async function fixtureCatalog(
  name: string,
  values: Record<string, string | undefined>,
): Promise<SessionCatalog> {
  const entries = parseSettingsDocument(
    await Bun.file(
      join(import.meta.dir, `../fixtures/settings/${name}.json`),
    ).json(),
  );
  const stored = new Map<string, string>();
  for (const id of Object.keys(entries.repositories)) {
    stored.set(`repository:${id}`, appKey);
  }
  for (const [ref, value] of Object.entries(values)) {
    if (value) stored.set(ref, value);
  }
  const snapshot = settingsSnapshot({
    generation: 0,
    connections: Object.entries(entries.connections).map(([id, provider]) => ({
      id,
      provider,
      ...(entries.connection_models?.[id] ?? {}),
    })),
    repositories: Object.entries(entries.repositories).map(
      ([id, repository]) => ({ id, repository }),
    ),
    stored,
    invalid: [],
  });
  if (snapshot.left_out.length > 0) {
    throw new Error(
      `${name}: ${snapshot.left_out.map((entry) => `${entry.entry}: ${entry.reason}`).join("; ")}`,
    );
  }
  return {
    connections: snapshot.connections,
    repositories: snapshot.repositories,
    mcp_servers: snapshot.mcp_servers,
  };
}
