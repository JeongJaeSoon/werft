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
 * The catalog the API would read after migrate imported the fixture: its
 * connections with their models, and its repositories, credentials resolved
 * from `env` (the fake GitHub App's key from a generated one).
 */
export async function fixtureCatalog(
  name: string,
  env: Record<string, string | undefined>,
): Promise<SessionCatalog> {
  const entries = parseSettingsDocument(
    await Bun.file(
      join(import.meta.dir, `../fixtures/settings/${name}.json`),
    ).json(),
  );
  const snapshot = settingsSnapshot(
    {
      generation: 0,
      connections: Object.entries(entries.connections).map(
        ([id, provider]) => ({
          id,
          provider,
          ...(entries.connection_models?.[id] ?? {}),
        }),
      ),
      repositories: Object.entries(entries.repositories).map(
        ([id, repository]) => ({ id, repository }),
      ),
      mcpServers: Object.entries(entries.mcp_servers).map(([id, server]) => ({
        id,
        server,
      })),
      stored: new Map(),
      invalid: [],
    },
    (ref) =>
      "value_env" in ref
        ? env[ref.value_env]
        : "secret_id" in ref && ref.secret_id === "werft/local/fake-github-app"
          ? appKey
          : undefined,
  );
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
