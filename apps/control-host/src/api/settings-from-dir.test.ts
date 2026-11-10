import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTIONS_FILE,
  dirIsEmpty,
  REPOSITORIES_FILE,
  readCatalogConfig,
  readConnections,
} from "./settings-from-dir.ts";

const REPOSITORIES = `repositories:
  sample-app:
    url: http://fake-git:3000/agent/sample-app.git
    branch: main
    auth:
      kind: github_app
      app_id: 1
      installation_id: 1
      api_base: http://fake-git:3000
      value_env: GITHUB_APP_KEY
`;
const CONNECTIONS = `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`;

let root: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-from-dir-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dirWith(
  files: Partial<Record<string, string>> = {},
): Promise<string> {
  const dir = join(root, String(count++));
  await mkdir(dir);
  const contents: Record<string, string | undefined> = {
    [REPOSITORIES_FILE]: REPOSITORIES,
    [CONNECTIONS_FILE]: CONNECTIONS,
    ...files,
  };
  for (const [name, text] of Object.entries(contents)) {
    if (text !== undefined) await writeFile(join(dir, name), text);
  }
  return dir;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the read to fail");
}

describe("the old catalog directory", () => {
  test("a missing file, bad YAML or a stray top-level key names the file", async () => {
    const noRepositories = await dirWith({ [REPOSITORIES_FILE]: undefined });
    expect(await failure(readCatalogConfig(noRepositories))).toBe(
      `${join(noRepositories, REPOSITORIES_FILE)} is missing`,
    );
    const broken = await dirWith({
      [REPOSITORIES_FILE]: "repositories: [unclosed",
    });
    expect(await failure(readCatalogConfig(broken))).toStartWith(
      `${join(broken, REPOSITORIES_FILE)} is not valid YAML: `,
    );
    for (const text of [
      `${REPOSITORIES}connections: {}\n`,
      "repository:\n  a: {}\n",
      "- repositories\n",
      "",
    ]) {
      const dir = await dirWith({ [REPOSITORIES_FILE]: text });
      expect(await failure(readCatalogConfig(dir))).toBe(
        `${join(dir, REPOSITORIES_FILE)} must hold exactly one top-level key: repositories`,
      );
    }
  });

  test("a repository's old profiles list is dropped, not refused", async () => {
    const dir = await dirWith({
      [REPOSITORIES_FILE]: REPOSITORIES.replace(
        "    branch: main\n",
        "    branch: main\n    profiles: [coding]\n",
      ),
    });
    const config = await readCatalogConfig(dir);
    expect(Object.keys(config.repositories)).toEqual(["sample-app"]);
    expect(Object.hasOwn(config.repositories["sample-app"] ?? {}, "profiles"))
      .toBe(false);
  });

  test("a directory without connections.yaml is refused, naming the file", async () => {
    const dir = await dirWith({ [CONNECTIONS_FILE]: undefined });
    expect(await failure(readConnections(dir))).toBe(
      `${join(dir, CONNECTIONS_FILE)} is missing`,
    );
  });

  test("a key defined twice is refused, not resolved to the last one", async () => {
    const dir = await dirWith({
      [REPOSITORIES_FILE]: REPOSITORIES.replace(
        "    branch: main\n",
        "    branch: main\n    branch: develop\n",
      ),
    });
    expect(await failure(readCatalogConfig(dir))).toStartWith(
      `${join(dir, REPOSITORIES_FILE)} is not valid YAML: Map keys must be unique`,
    );
  });

  test("an invalid repository stops the read with its path", async () => {
    const dir = await dirWith({
      [REPOSITORIES_FILE]: REPOSITORIES.replace(
        "    branch: main\n",
        "    branch: 7\n",
      ),
    });
    expect(await failure(readCatalogConfig(dir))).toStartWith(
      `Catalog config in ${dir} is invalid: repositories.sample-app.branch: `,
    );
  });

  test("a directory holding only volume bookkeeping counts as empty", async () => {
    const dir = join(root, "kube");
    await mkdir(join(dir, "..2026_11_04"), { recursive: true });
    expect(await dirIsEmpty(dir)).toBe(true);
    expect(await dirIsEmpty(join(root, "absent"))).toBe(true);
    expect(await dirIsEmpty(await dirWith())).toBe(false);
  });
});
