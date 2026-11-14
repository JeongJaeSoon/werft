import { describe, expect, test } from "bun:test";
import type {
  CatalogProviderConfig,
  EnvCredentialCarry,
  InstallationSettings,
} from "@werft-ai/platform";
import { settingsSource } from "./installation-settings.ts";

const VALUE = "example-provider-key-1234";

function provider(auth: Record<string, string>): CatalogProviderConfig {
  return {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", ...auth },
  } as CatalogProviderConfig;
}

function source(
  carries: EnvCredentialCarry[][],
  connection: CatalogProviderConfig = provider({ value_env: "PROVIDER_KEY" }),
  stored: ReadonlyMap<string, string> = new Map(),
) {
  const warnings: string[] = [];
  let reads = 0;
  const settings = settingsSource({
    store: {
      async carryEnvCredentials(env) {
        expect(env("PROVIDER_KEY")).toBe(VALUE);
        return carries[reads] ?? [];
      },
      async read(): Promise<InstallationSettings> {
        reads += 1;
        return {
          generation: 1,
          connections: [{ id: "main", provider: connection, models: [] }],
          repositories: [],
          mcpServers: [],
          stored,
          invalid: [],
        };
      },
    },
    env: { PROVIDER_KEY: VALUE },
    readSecret: async () => undefined,
    warn: (message) => warnings.push(message),
  });
  return { settings, warnings };
}

const entry = "connection:main";

describe("settingsSource", () => {
  test("an env reference is not read: with a workspace it is left out, warned once by name", async () => {
    const { settings, warnings } = source([
      [{ entry, env: "PROVIDER_KEY", outcome: "missing" }],
      [{ entry, env: "PROVIDER_KEY", outcome: "missing" }],
    ]);
    for (let read = 0; read < 2; read += 1) {
      const snapshot = await settings.read();
      expect(Object.keys(snapshot.connections)).toEqual([]);
      expect(snapshot.left_out.map((left) => left.entry)).toEqual([entry]);
    }
    expect(warnings).toEqual([
      "connection:main names PROVIDER_KEY, which the API does not have, so it is left out. Set PROVIDER_KEY and restart the API to carry the value into the database once, or enter the key on the connection in Settings > Connections",
    ]);
  });

  test("until the first workspace exists the value is read from the environment", async () => {
    const { settings, warnings } = source([
      [{ entry, env: "PROVIDER_KEY", outcome: "waiting" }],
      [{ entry, env: "PROVIDER_KEY", outcome: "waiting" }],
    ]);
    for (let read = 0; read < 2; read += 1) {
      const snapshot = await settings.read();
      expect(snapshot.connections.main?.provider.auth).toMatchObject({
        value: VALUE,
        ref: { value_env: "PROVIDER_KEY" },
      });
    }
    expect(warnings).toEqual([
      "connection:main reads PROVIDER_KEY until the first workspace exists; then the API carries it into the database once",
    ]);
  });

  test("a carried row runs on its stored value and says so by name", async () => {
    const { settings, warnings } = source(
      [[{ entry, env: "PROVIDER_KEY", outcome: "carried" }]],
      provider({ stored: entry }),
      new Map([[entry, VALUE]]),
    );
    const snapshot = await settings.read();
    expect(snapshot.connections.main?.provider.auth).toMatchObject({
      value: VALUE,
      ref: { stored: entry },
    });
    expect(warnings).toEqual([
      "connection:main took its credential from PROVIDER_KEY into the database and no longer reads it; remove PROVIDER_KEY",
    ]);
    expect(warnings.join("\n")).not.toContain(VALUE);
  });

  test("a failed carry leaves the row out and is warned once", async () => {
    const { settings, warnings } = source([
      [{ entry, env: "PROVIDER_KEY", outcome: "failed" }],
      [{ entry, env: "PROVIDER_KEY", outcome: "failed" }],
    ]);
    for (let read = 0; read < 2; read += 1) {
      expect(Object.keys((await settings.read()).connections)).toEqual([]);
    }
    expect(warnings).toEqual([
      "connection:main could not carry PROVIDER_KEY into the database and is left out; it is tried again on each read",
    ]);
  });

  test("a value the catalog refuses is left out and warned once with the reason", async () => {
    const reason =
      "connections.main.auth.value_env: PROVIDER_KEY is shorter than 8 bytes";
    const { settings, warnings } = source([
      [{ entry, env: "PROVIDER_KEY", outcome: "invalid", reason }],
      [{ entry, env: "PROVIDER_KEY", outcome: "invalid", reason }],
    ]);
    for (let read = 0; read < 2; read += 1) {
      expect(Object.keys((await settings.read()).connections)).toEqual([]);
    }
    expect(warnings).toEqual([
      `connection:main is left out and not carried into the database: ${reason}. Correct PROVIDER_KEY and restart the API`,
    ]);
  });

  test("a carried repository says how many held rows moved to its new binding", async () => {
    const { settings, warnings } = source([
      [
        {
          entry: "repository:ghes",
          env: "PROVIDER_KEY",
          outcome: "carried",
          rebound: { push_requests: 2, worker_credentials: 1 },
        },
      ],
    ]);
    await settings.read();
    expect(warnings).toEqual([
      "repository:ghes took its credential from PROVIDER_KEY into the database and no longer reads it; remove PROVIDER_KEY (2 push requests and 1 worker credentials moved to its new binding)",
    ]);
  });
});
