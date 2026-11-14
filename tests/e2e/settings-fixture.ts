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
 * connections with their models, and its repositories. As the API's first
 * read does, an env reference with a value in `env` is carried into a
 * stored value of its row's own; one without stays and does not resolve.
 * The fake GitHub App's key comes from a generated one.
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
  const stored = new Map<string, string>();
  const carried = <T extends { auth?: unknown }>(
    kind: string,
    id: string,
    entry: T,
  ): T => {
    const { value_env: name, ...kept } = (entry.auth ?? {}) as {
      value_env?: string;
    };
    const value = name === undefined ? undefined : env[name];
    if (!value) return entry;
    stored.set(`${kind}:${id}`, value);
    return { ...entry, auth: { ...kept, stored: `${kind}:${id}` } };
  };
  const snapshot = settingsSnapshot(
    {
      generation: 0,
      connections: Object.entries(entries.connections).map(
        ([id, provider]) => ({
          id,
          provider: carried("connection", id, provider),
          ...(entries.connection_models?.[id] ?? {}),
        }),
      ),
      repositories: Object.entries(entries.repositories).map(
        ([id, repository]) => ({
          id,
          repository: carried("repository", id, repository),
        }),
      ),
      mcpServers: Object.entries(entries.mcp_servers).map(([id, server]) => ({
        id,
        server: carried("mcp", id, server),
      })),
      stored,
      invalid: [],
    },
    (ref) =>
      "secret_id" in ref && ref.secret_id === "werft/local/fake-github-app"
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
