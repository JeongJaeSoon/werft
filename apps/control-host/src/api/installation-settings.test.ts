import { describe, expect, test } from "bun:test";
import type { InstallationSettings } from "@werft-ai/platform";
import { settingsSource } from "./installation-settings.ts";

const VALUE = "example-provider-key-1234";
const entry = "connection:main";

function source(values: ReadonlyMap<string, string>[]) {
  const asked: unknown[] = [];
  const settings = settingsSource({
    store: {
      async read(options): Promise<InstallationSettings> {
        asked.push(options);
        return {
          generation: 1,
          connections: [
            {
              id: "main",
              provider: {
                kind: "anthropic",
                endpoint: "https://api.anthropic.invalid",
                auth: { kind: "api_key", stored: entry },
              },
              models: [],
            },
          ],
          repositories: [],
          stored: values[asked.length - 1] ?? new Map(),
          invalid: [],
        };
      },
    },
  });
  return { settings, asked };
}

describe("settingsSource", () => {
  test("opens the stored values on every read; a row without its value is left out, then runs once it has one", async () => {
    const { settings, asked } = source([new Map(), new Map([[entry, VALUE]])]);
    const missing = await settings.read();
    expect(Object.keys(missing.connections)).toEqual([]);
    expect([...missing.unavailable_connections]).toEqual(["main"]);
    expect(missing.left_out).toEqual([
      {
        entry,
        reason: "connections.main.auth.stored: connection:main is not set",
      },
    ]);
    const set = await settings.read();
    expect(set.connections.main?.provider.auth).toMatchObject({
      value: VALUE,
      ref: { stored: entry },
    });
    expect(asked).toEqual([{ openStored: true }, { openStored: true }]);
  });
});
