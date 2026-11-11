import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportResult,
} from "@werft-ai/platform";
import {
  documentFromDir,
  parseSettingsCommand,
  runSettingsCommand,
} from "./settings.ts";

const OLD_CATALOG = {
  "connections.yaml": `connections:
  fake-messages:
    kind: anthropic
    endpoint: http://fake-messages:4010
    auth:
      kind: api_key
      secret_id: werft/local/fake-messages
`,
  "repositories.yaml": `repositories:
  sample-app:
    url: http://fake-git:3000/agent/sample-app.git
    branch: main
    profiles: [coding]
    auth:
      kind: github_app
      app_id: 1
      installation_id: 1
      api_base: http://fake-git:3000
      value_env: GITHUB_APP_KEY
  bare:
    url: http://fake-git:3000/agent/bare.git
    branch: main
    auth:
      kind: github_app
      app_id: 1
      installation_id: 1
      api_base: http://fake-git:3000
      value_env: GITHUB_APP_KEY
`,
  "mcp-servers.yaml": `mcp_servers:
  fake:
    url: http://fake-mcp:4020/mcp
    credential_ref: mcp/fake
    auth:
      kind: bearer
      secret_id: werft/local/fake-mcp
    workspaces: [verify]
`,
  "profiles.yaml": `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: http://fake-messages:4010
      auth:
        kind: api_key
        secret_id: werft/local/fake-messages
`,
  "platform.yaml": `secret_key:
  value_env: UNREAD
`,
};

let root: string;
let oldCatalog: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-cli-"));
  oldCatalog = join(root, "catalog");
  await mkdir(oldCatalog);
  for (const [name, text] of Object.entries(OLD_CATALOG)) {
    await writeFile(join(oldCatalog, name), text);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const PLAN = {
  add: [],
  unchanged: [],
  inactive: [],
  needs_value: [],
  conflicts: [],
  refused_external: [],
};

type Stranded = Awaited<
  ReturnType<SettingsDocumentStore["sessionsOnRepositories"]>
>;

function fakeStore(
  result: SettingsImportResult,
  /** The sessions a given list of left-out ids would find. */
  stranded: (ids: readonly string[]) => Stranded = () => [],
) {
  const asked: Array<Parameters<SettingsDocumentStore["importEntries"]>> = [];
  const store: Pick<
    SettingsDocumentStore,
    "exportEntries" | "importEntries" | "sessionsOnRepositories"
  > = {
    sessionsOnRepositories: async (ids) => stranded(ids),
    exportEntries: async () => ({
      entries: {
        connections: {
          main: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", stored: "connection:main" },
          },
        },
        repositories: {},
        mcp_servers: {},
      },
      last4: new Map([["connection:main", "wxyz"]]),
    }),
    importEntries: async (...args) => {
      asked.push(args);
      return result;
    },
  };
  return { store, asked };
}

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    output: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

describe("settings CLI arguments", () => {
  test("export takes nothing; import takes one source and --dry-run", () => {
    expect(parseSettingsCommand(["export"])).toEqual({ command: "export" });
    expect(
      parseSettingsCommand(["import", "--document", "s.json", "--dry-run"]),
    ).toEqual({
      command: "import",
      source: { document: "s.json" },
      dryRun: true,
    });
    expect(
      parseSettingsCommand(["import", "--from-dir", "/app/config"]),
    ).toEqual({
      command: "import",
      source: { dir: "/app/config", ifPresent: false },
      dryRun: false,
    });
    expect(
      parseSettingsCommand([
        "import",
        "--from-dir",
        "/legacy-config",
        "--if-present",
      ]),
    ).toMatchObject({
      source: { dir: "/legacy-config", ifPresent: true },
    });
  });

  test("no source, two sources, an unknown command or option is refused", () => {
    for (const argv of [
      ["import"],
      ["import", "--document", "a", "--from-dir", "b"],
      ["export", "--dry-run"],
      ["export", "extra"],
      ["apply"],
      ["import", "--document", "a", "--force"],
      ["import", "--document", "a", "--if-present"],
      ["export", "--if-present"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Usage:");
    }
  });
});

describe("settings CLI", () => {
  test("--from-dir turns the old files into the document, the fake-messages connection included, and says what it leaves out", async () => {
    const { document, notes } = await documentFromDir(oldCatalog);
    const entries = parseSettingsDocument(document);
    expect(Object.keys(entries.connections)).toEqual(["fake-messages"]);
    expect(entries.connections["fake-messages"]).toMatchObject({
      kind: "anthropic",
      endpoint: "http://fake-messages:4010",
    });
    expect(Object.keys(entries.repositories).sort()).toEqual([
      "bare",
      "sample-app",
    ]);
    expect(Object.keys(entries.mcp_servers)).toEqual(["fake"]);
    expect(notes).toEqual([
      "platform.yaml is not imported: set the master key in PLATFORM_SECRET_KEY",
      "profiles.yaml is not imported: profiles are removed; list each connection's models in the console or under connections.<id>.models",
    ]);
    expect(document).not.toHaveProperty("profiles");
    expect(entries.repositories["sample-app"]).not.toHaveProperty("profiles");
  });

  test("import --from-dir hands the operator's import every entry, external references allowed", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const { output, out, err } = captured();
    const ok = await runSettingsCommand(
      {
        command: "import",
        source: { dir: oldCatalog, ifPresent: false },
        dryRun: false,
      },
      { settings: store },
      output,
    );
    expect(ok).toBe(true);
    const [entries, options] = asked[0] ?? [];
    expect(Object.keys((entries as SettingsEntries).connections)).toEqual([
      "fake-messages",
    ]);
    expect(options).toEqual({
      dryRun: false,
      allowExternal: true,
      databaseOwnsRepositories: true,
      actor: null,
    });
    expect(err.some((line) => line.includes("platform.yaml"))).toBe(true);
    expect(err.some((line) => line.includes("profiles.yaml"))).toBe(true);
    expect(JSON.parse(out.join("\n"))).not.toHaveProperty("profiles");
  });

  test("a kept repository is named on stderr, and a document import keeps none", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      kept: ["repository:app"],
      outcome: "applied",
      receipt_ids: [],
    });
    const { output, err } = captured();
    await runSettingsCommand(
      {
        command: "import",
        source: { dir: oldCatalog, ifPresent: false },
        dryRun: true,
      },
      { settings: store },
      output,
    );
    expect(err).toContain(
      "note: repository:app from the file is not applied; the database keeps its row",
    );
    expect(asked[0]?.[1]).toHaveProperty("databaseOwnsRepositories", true);
  });

  test("a repository without a GitHub App is left out with a note, in a directory and in a document, and the rest imports", async () => {
    const legacy = `  old-url:
    url: https://git.example.invalid/team/old.git
    branch: main
  old-basic:
    url: https://git.example.invalid/team/basic.git
    branch: main
    auth:
      kind: basic
      username: bot
      value_env: OLD_TOKEN
  old-bearer:
    url: https://git.example.invalid/team/bearer.git
    branch: main
    auth:
      kind: bearer
      value_env: OLD_TOKEN
`;
    const dir = join(root, "with-legacy");
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(OLD_CATALOG)) {
      await writeFile(
        join(dir, name),
        name === "repositories.yaml" ? `${text}${legacy}` : text,
      );
    }
    const { document, notes } = await documentFromDir(dir);
    expect(
      Object.keys(parseSettingsDocument(document).repositories).sort(),
    ).toEqual(["bare", "sample-app"]);
    expect(notes.filter((note) => note.startsWith("repository "))).toHaveLength(
      3,
    );
    expect(notes.join("\n")).toContain("repository old-basic is not imported");

    const planned = { ...PLAN, outcome: "applied" as const, receipt_ids: [] };
    const { store, asked } = fakeStore(planned);
    const fromDir = captured();
    expect(
      await runSettingsCommand(
        { command: "import", source: { dir, ifPresent: false }, dryRun: false },
        { settings: store },
        fromDir.output,
      ),
    ).toBe(true);
    expect(
      Object.keys((asked[0]?.[0] as SettingsEntries).repositories).sort(),
    ).toEqual(["bare", "sample-app"]);
    expect(fromDir.err.filter((line) => line.includes("old-url"))).toHaveLength(
      1,
    );

    const file = join(root, "legacy-document.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repositories: {
          "old-url": {
            url: "https://git.example.invalid/team/old.git",
            branch: "main",
          },
          kept: {
            url: "https://github.com/acme/kept",
            branch: "main",
            auth: { kind: "github_app" },
          },
        },
      }),
    );
    const fromDocument = captured();
    expect(
      await runSettingsCommand(
        { command: "import", source: { document: file }, dryRun: false },
        { settings: store },
        fromDocument.output,
      ),
    ).toBe(true);
    expect(
      Object.keys((asked[1]?.[0] as SettingsEntries).repositories),
    ).toEqual(["kept"]);
    expect(fromDocument.err.some((line) => line.includes("old-url"))).toBe(
      true,
    );
  });

  test("a session still on a repository the file alone knew stops the import before anything is written; others do not", async () => {
    const dir = join(root, "stranded");
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(OLD_CATALOG)) {
      await writeFile(
        join(dir, name),
        name === "repositories.yaml"
          ? `${text}  old-url:\n    url: https://git.example.invalid/team/old.git\n    branch: main\n`
          : text,
      );
    }
    const planned = { ...PLAN, outcome: "applied" as const, receipt_ids: [] };
    const command = {
      command: "import" as const,
      source: { dir, ifPresent: false },
      dryRun: false,
    };

    const asked: string[][] = [];
    const held = fakeStore(planned, (ids) => {
      asked.push([...ids]);
      return [{ session_id: "ses_1", repository_id: "old-url", via: "policy" }];
    });
    const refused = captured();
    expect(
      await runSettingsCommand(
        command,
        { settings: held.store },
        refused.output,
      ),
    ).toBe(false);
    expect(asked).toEqual([["old-url"]]);
    expect(held.asked).toHaveLength(0);
    expect(refused.err.join("\n")).toContain("ses_1 (old-url, policy)");

    // The same files with no session on it: the import goes on, as before.
    const free = fakeStore(planned);
    expect(
      await runSettingsCommand(
        command,
        { settings: free.store },
        captured().output,
      ),
    ).toBe(true);
    expect(free.asked).toHaveLength(1);

    // A dry run is refused too, so the operator sees it before the window.
    const dry = fakeStore(planned, () => [
      { session_id: "ses_2", repository_id: "old-url", via: "primary" },
    ]);
    expect(
      await runSettingsCommand(
        { ...command, dryRun: true },
        { settings: dry.store },
        captured().output,
      ),
    ).toBe(false);
  });

  test("the verify GitHub sandbox document is one migrate accepts", async () => {
    const path = join(
      import.meta.dir,
      "../../../../.claude/skills/verify-werft/github-sandbox/settings.json",
    );
    const entries = parseSettingsDocument(await Bun.file(path).json());
    expect(Object.keys(entries.repositories).sort()).toEqual([
      "sample-app",
      "sandbox",
    ]);
  });

  test("--if-present skips a missing or empty directory, and only that", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    for (const dir of [empty, join(root, "absent")]) {
      const { output, err } = captured();
      expect(
        await runSettingsCommand(
          {
            command: "import",
            source: { dir, ifPresent: true },
            dryRun: false,
          },
          { settings: store },
          output,
        ),
      ).toBe(true);
      expect(err).toEqual([`nothing to import from ${dir}`]);
    }
    expect(asked).toEqual([]);

    const partial = join(root, "partial");
    await mkdir(partial, { recursive: true });
    await writeFile(
      join(partial, "repositories.yaml"),
      OLD_CATALOG["repositories.yaml"],
    );
    await expect(
      runSettingsCommand(
        {
          command: "import",
          source: { dir: partial, ifPresent: true },
          dryRun: false,
        },
        { settings: store },
        captured().output,
      ),
    ).rejects.toThrow("connections.yaml is missing");
    expect(asked).toEqual([]);
  });

  test("a refused import exits non-zero, and names the conflicts", async () => {
    const path = join(root, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        connections: {},
        repositories: {
          open: {
            url: "https://github.com/a/b.git",
            branch: "main",
            auth: { kind: "github_app" },
          },
        },
        mcp_servers: {},
      }),
    );
    const { store, asked } = fakeStore({
      ...PLAN,
      conflicts: ["repository:open"],
      outcome: "refused",
      receipt_ids: [],
    });
    const { output, err, out } = captured();
    const ok = await runSettingsCommand(
      { command: "import", source: { document: path }, dryRun: true },
      { settings: store },
      output,
    );
    expect(ok).toBe(false);
    expect(asked[0]?.[1].dryRun).toBe(true);
    expect(JSON.parse(out.join("\n")).conflicts).toEqual(["repository:open"]);
    expect(err.join("\n")).toContain("repository:open");
  });

  test("export prints the document with no stored reference, and its digest apart", async () => {
    const { store } = fakeStore({
      ...PLAN,
      outcome: "dry_run",
      receipt_ids: [],
    });
    const { output, out, err } = captured();
    expect(
      await runSettingsCommand(
        { command: "export" },
        { settings: store },
        output,
      ),
    ).toBe(true);
    const document = JSON.parse(out.join("\n"));
    expect(document.connections.main.auth).toEqual({
      kind: "api_key",
      stored: true,
      last4: "wxyz",
    });
    expect(out.join("\n")).not.toContain("connection:main");
    expect(err).toEqual([
      expect.stringMatching(/^digest sha256:[0-9a-f]{64}$/),
    ]);
  });
});
