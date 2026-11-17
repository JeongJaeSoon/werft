import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportResult,
  type SettingsSeedDecision,
  type SettingsSeedResult,
  type SettingsSeedStep,
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
      stored: connection:fake-messages
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
      stored: repository:sample-app
  bare:
    url: http://fake-git:3000/agent/bare.git
    branch: main
    auth:
      kind: github_app
      app_id: 1
      installation_id: 1
      api_base: http://fake-git:3000
      stored: repository:bare
`,
  "mcp-servers.yaml": `mcp_servers:
  fake:
    url: http://fake-mcp:4020/mcp
    credential_ref: mcp/fake
    auth:
      kind: bearer
      stored: mcp:fake
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
};

type Stranded = Awaited<
  ReturnType<SettingsDocumentStore["sessionsOnRepositories"]>
>;

function fakeStore(
  result: SettingsImportResult,
  /** The sessions a given list of left-out ids would find. */
  stranded: (ids: readonly string[]) => Stranded = () => [],
  seed: { decision?: SettingsSeedDecision; result?: SettingsSeedResult } = {},
) {
  const asked: Array<Parameters<SettingsDocumentStore["importEntries"]>> = [];
  const seeded: SettingsSeedStep[][] = [];
  let decided = 0;
  const store: Pick<
    SettingsDocumentStore,
    | "exportEntries"
    | "importEntries"
    | "sessionsOnRepositories"
    | "decideSeed"
    | "seedEntries"
  > = {
    decideSeed: async () => {
      decided++;
      return seed.decision ?? { outcome: "empty" };
    },
    seedEntries: async (steps) => {
      seeded.push([...steps]);
      return (
        seed.result ?? {
          outcome: "applied",
          steps: steps.map(() => PLAN),
          receipt_ids: [],
        }
      );
    },
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
  return { store, asked, seeded, decisions: () => decided };
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
      ["seed"],
      ["seed", "--document", "a", "--dry-run"],
      ["seed", "--from-dir", "b", "--if-present"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Usage:");
    }
  });

  test("seed takes the directory, the document or both", () => {
    expect(
      parseSettingsCommand([
        "seed",
        "--from-dir",
        "/legacy-config",
        "--document",
        "/settings/s.json",
      ]),
    ).toEqual({
      command: "seed",
      dir: "/legacy-config",
      document: "/settings/s.json",
    });
    expect(parseSettingsCommand(["seed", "--from-dir", "/l"])).toEqual({
      command: "seed",
      dir: "/l",
    });
  });

  test("the CLI prints a refusal as a message and exits 1, without a stack trace", async () => {
    // Unreachable: a refusal that still connected would hang until the kill.
    const unreachable = "postgresql://postgres:dev@203.0.113.1:5432/sessions";
    // An empty working directory has no env file Bun could auto-load into the
    // case that leaves DATABASE_URL out.
    const cwd = await mkdtemp(join(tmpdir(), "settings-cli-"));
    try {
      expect(await readdir(cwd)).toHaveLength(0);
      for (const [args, databaseUrl, message] of [
        [["import"], unreachable, "name one of --document or --from-dir"],
        [
          ["import", "--document", "a", "--force"],
          unreachable,
          "Unknown option",
        ],
        [["export"], undefined, "DATABASE_URL"],
      ] as const) {
        const result = Bun.spawnSync(
          [
            "bun",
            "--no-env-file",
            "run",
            join(import.meta.dir, "settings.ts"),
            ...args,
          ],
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? "",
              ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
            },
            stderr: "pipe",
            stdout: "pipe",
            timeout: 10_000,
          },
        );
        const stderr = result.stderr.toString();
        expect(result.exitCode, args.join(" ")).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(stderr.startsWith(message), stderr).toBe(true);
        expect(stderr).not.toContain("throw new Error");
        expect(stderr).not.toMatch(/^\s+at /m);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    // Three cold spawns, each killed at 10 s: above that sum, not the 5 s default.
  }, 35_000);
});

describe("settings seed", () => {
  const seedCommand = (document?: string, dir?: string) => ({
    command: "seed" as const,
    ...(dir === undefined ? {} : { dir }),
    ...(document === undefined ? {} : { document }),
  });
  const appliedImport = {
    ...PLAN,
    outcome: "applied" as const,
    receipt_ids: [],
  };

  test.each([
    [
      { outcome: "decided", decided_at: new Date("2026-11-01T00:00:00Z") },
      "the automatic seed ran on 2026-11-01T00:00:00.000Z",
    ],
    [{ outcome: "not_empty" }, "the installation already holds settings"],
  ] as const)(
    "once decided (%o) it reads no file and imports nothing",
    async (decision, why) => {
      const fake = fakeStore(appliedImport, () => [], { decision });
      const { output, err, out } = captured();
      // Neither can be read: nothing is touched once the seed is decided.
      const document = join(root, "no-such-document.json");
      const notADirectory = join(root, "not-a-directory");
      await writeFile(notADirectory, "");
      expect(
        await runSettingsCommand(
          seedCommand(document, notADirectory),
          { settings: fake.store },
          output,
        ),
      ).toBe(true);
      expect(fake.seeded).toEqual([]);
      expect(out).toEqual([]);
      expect(err).toEqual([
        `note: ${notADirectory} and the settings document ${document} (SETTINGS_DOCUMENT) not imported: ${why}. They seed an empty installation only; change settings in the console`,
      ]);
    },
  );

  test("an empty installation is seeded from the directory, then the document, in one call", async () => {
    const path = join(root, "seed.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        connections: {},
        repositories: {},
        mcp_servers: {
          docs: {
            url: "https://mcp.example.invalid/mcp",
            credential_ref: "mcp/docs",
            auth: { kind: "bearer", stored: true },
            workspaces: ["*"],
          },
        },
      }),
    );
    const fake = fakeStore(appliedImport);
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(path, oldCatalog),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(fake.seeded).toHaveLength(1);
    const [fromDir, fromDocument] = fake.seeded[0] ?? [];
    expect(fromDir?.databaseOwnsRepositories).toBe(true);
    expect(Object.keys(fromDir?.entries.connections ?? {})).toEqual([
      "fake-messages",
    ]);
    expect(fromDocument?.databaseOwnsRepositories).toBe(false);
    expect(Object.keys(fromDocument?.entries.mcp_servers ?? {})).toEqual([
      "docs",
    ]);
    expect(err.at(-1)).toBe(
      `seeded from ${oldCatalog} and the settings document ${path} (SETTINGS_DOCUMENT); from here on settings are changed in the console`,
    );
  });

  test("an empty installation with a missing directory and no document is nothing to seed", async () => {
    const fake = fakeStore(appliedImport);
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(undefined, join(root, "absent")),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(err).toEqual(["nothing to seed"]);
    expect(fake.seeded).toEqual([]);
  });

  // Asking is what records the marker on an installation that holds settings.
  test("an installation that holds settings is decided even with no input", async () => {
    const fake = fakeStore(appliedImport, () => [], {
      decision: { outcome: "not_empty" },
    });
    const { output, err } = captured();
    const absent = join(root, "absent");
    expect(
      await runSettingsCommand(
        seedCommand(undefined, absent),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(fake.decisions()).toBe(1);
    expect(err).toEqual([
      `note: ${absent} not imported: the installation already holds settings. They seed an empty installation only; change settings in the console`,
    ]);
  });

  test("a refused step exits non-zero and names its source and conflicts", async () => {
    const fake = fakeStore(appliedImport, () => [], {
      result: {
        ...PLAN,
        conflicts: ["connection:fake-messages"],
        outcome: "refused",
        step: 0,
      },
    });
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(undefined, oldCatalog),
        { settings: fake.store },
        output,
      ),
    ).toBe(false);
    expect(err.at(-1)).toBe(
      `refused: nothing changed (${oldCatalog} conflicts: connection:fake-messages)`,
    );
  });

  test("another migrate that decided first while this one read is a note, not a failure", async () => {
    const fake = fakeStore(appliedImport, () => [], {
      result: { outcome: "not_empty" },
    });
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(undefined, oldCatalog),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(fake.seeded).toHaveLength(1);
    expect(err.at(-1)).toContain("the installation already holds settings");
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

  test("--from-dir refuses an entry that names an env or Secrets Manager reference, naming the field", async () => {
    for (const [file, from, to, field] of [
      [
        "connections.yaml",
        "stored: connection:fake-messages",
        "value_env: FAKE_KEY",
        "value_env",
      ],
      [
        "mcp-servers.yaml",
        "stored: mcp:fake",
        "secret_id: werft/fake",
        "secret_id",
      ],
    ] as const) {
      const dir = join(root, `external-${file}`);
      await mkdir(dir, { recursive: true });
      for (const [name, text] of Object.entries(OLD_CATALOG)) {
        await writeFile(
          join(dir, name),
          name === file ? text.replace(from, to) : text,
        );
      }
      const refused = await documentFromDir(dir).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(refused).toContain(`.auth.${field} is no longer supported`);
    }
  });

  test("import --from-dir hands the operator's import every entry", async () => {
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
