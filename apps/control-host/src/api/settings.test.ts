import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as platform from "@werft-ai/platform";
import {
  parseSettingsDocument,
  type SettingsDocumentStore,
  type SettingsImportResult,
  type SettingsSeedDecision,
  type SettingsSeedResult,
  type SettingsSeedStep,
} from "@werft-ai/platform";
import {
  inputRefusal,
  parseSettingsCommand,
  runSettingsCommand,
} from "./settings.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-cli-"));
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

const DOCUMENT = {
  version: 1,
  connections: {},
  repositories: {
    open: {
      url: "https://github.com/a/b.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
  },
  // An older export's empty field is still taken.
  mcp_servers: {},
};

function fakeStore(
  result: SettingsImportResult,
  seed: { decision?: SettingsSeedDecision; result?: SettingsSeedResult } = {},
) {
  const asked: Array<Parameters<SettingsDocumentStore["importEntries"]>> = [];
  const seeded: SettingsSeedStep[][] = [];
  let decided = 0;
  const store: Pick<
    SettingsDocumentStore,
    "exportEntries" | "importEntries" | "decideSeed" | "seedEntries"
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
  test("export takes nothing; import takes the document and --dry-run; seed the document", () => {
    expect(parseSettingsCommand(["export"])).toEqual({ command: "export" });
    expect(
      parseSettingsCommand(["import", "--document", "s.json", "--dry-run"]),
    ).toEqual({ command: "import", document: "s.json", dryRun: true });
    expect(
      parseSettingsCommand(["seed", "--document", "/settings/s.json"]),
    ).toEqual({ command: "seed", document: "/settings/s.json" });
  });

  test("no document, an unknown command or option is refused", () => {
    for (const argv of [
      ["import"],
      ["export", "--dry-run"],
      ["export", "--document", "a"],
      ["export", "extra"],
      ["apply"],
      ["import", "--document", "a", "--force"],
      ["seed"],
      ["seed", "--document", "a", "--dry-run"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Usage:");
    }
  });

  // The old catalog directory was the only thing they read.
  test("--from-dir and --if-present are unknown options now", () => {
    for (const argv of [
      ["import", "--from-dir", "/app/config"],
      ["import", "--from-dir", "/legacy-config", "--if-present"],
      ["seed", "--from-dir", "/legacy-config"],
      ["seed", "--from-dir", "/l", "--document", "/settings/s.json"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Unknown option");
    }
  });

  // Unreachable: a refusal that still connected would hang until the kill.
  const unreachable = "postgresql://postgres:dev@203.0.113.1:5432/sessions";

  async function expectRefusedAsMessage(
    cases: readonly (readonly [
      args: readonly string[],
      databaseUrl: string | undefined,
      message: string,
    ])[],
  ) {
    // An empty working directory has no env file Bun could auto-load into the
    // case that leaves DATABASE_URL out.
    const cwd = await mkdtemp(join(tmpdir(), "settings-cli-"));
    try {
      expect(await readdir(cwd)).toHaveLength(0);
      for (const [args, databaseUrl, message] of cases) {
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
  }

  test("the CLI prints a refusal as a message and exits 1, without a stack trace", async () => {
    await expectRefusedAsMessage([
      [["import"], unreachable, "name --document"],
      [["import", "--document", "a", "--force"], unreachable, "Unknown option"],
      [["export"], undefined, "DATABASE_URL"],
    ]);
    // Three cold spawns, each killed at 10 s: above that sum, not the 5 s default.
  }, 35_000);

  test("only a named input error becomes a message; a fault past the document keeps its stack", async () => {
    const missing = join(root, "missing-input.json");
    const broken = join(root, "broken-input.json");
    await writeFile(broken, "{ not json");
    for (const [path, message] of [
      [missing, `${missing} is missing`],
      [broken, `${broken} is not valid JSON`],
    ] as const) {
      const refusal = await runSettingsCommand(
        { command: "import", document: path, dryRun: false },
        {
          settings: fakeStore({ ...PLAN, outcome: "applied", receipt_ids: [] })
            .store,
        },
        captured().output,
      ).then(() => "resolved", inputRefusal);
      expect(refusal?.startsWith(message), refusal).toBe(true);
    }
    expect(
      inputRefusal(
        (() => {
          try {
            parseSettingsDocument({ profiles: {} });
          } catch (error) {
            return error;
          }
        })(),
      )?.startsWith("The settings document is invalid"),
    ).toBe(true);

    // A defect past the file: the command rejects with it untouched.
    const path = join(root, "fault.json");
    await writeFile(path, JSON.stringify(DOCUMENT));
    const fault = new TypeError("not an input error");
    const spy = spyOn(platform, "parseSettingsDocument").mockImplementation(
      () => {
        throw fault;
      },
    );
    try {
      const rejected = await runSettingsCommand(
        { command: "import", document: path, dryRun: false },
        {
          settings: fakeStore({ ...PLAN, outcome: "applied", receipt_ids: [] })
            .store,
        },
        captured().output,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejected).toBe(fault);
      expect(inputRefusal(rejected)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(inputRefusal(new Error("connect ECONNREFUSED"))).toBeUndefined();
  });

  test("an import file that is missing, malformed or invalid ends as a message, not a stack trace", async () => {
    const inputs = await mkdtemp(join(tmpdir(), "settings-cli-inputs-"));
    try {
      await writeFile(join(inputs, "broken.json"), "{ not json");
      await writeFile(join(inputs, "profiles.json"), '{ "profiles": {} }');
      const missing = join(inputs, "missing.json");
      await expectRefusedAsMessage([
        [
          ["import", "--document", missing],
          unreachable,
          `${missing} is missing`,
        ],
        [
          ["import", "--document", join(inputs, "broken.json")],
          unreachable,
          `${join(inputs, "broken.json")} is not valid JSON`,
        ],
        [
          ["import", "--document", join(inputs, "profiles.json")],
          unreachable,
          "The settings document is invalid",
        ],
      ]);
    } finally {
      await rm(inputs, { recursive: true, force: true });
    }
    // Three cold spawns, each killed at 10 s: above that sum, not the 5 s default.
  }, 35_000);
});

describe("settings seed", () => {
  const seedCommand = (document: string) => ({
    command: "seed" as const,
    document,
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
      const fake = fakeStore(appliedImport, { decision });
      const { output, err, out } = captured();
      // It cannot be read: nothing is touched once the seed is decided.
      const document = join(root, "no-such-document.json");
      expect(
        await runSettingsCommand(
          seedCommand(document),
          { settings: fake.store },
          output,
        ),
      ).toBe(true);
      expect(fake.decisions()).toBe(1);
      expect(fake.seeded).toEqual([]);
      expect(out).toEqual([]);
      expect(err).toEqual([
        `note: the settings document ${document} (SETTINGS_DOCUMENT) not imported: ${why}. It seeds an empty installation only; change settings in the console`,
      ]);
    },
  );

  test("an empty installation is seeded from the document in one step", async () => {
    const path = join(root, "seed.json");
    await writeFile(path, JSON.stringify(DOCUMENT));
    const fake = fakeStore(appliedImport);
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(path),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(fake.seeded).toHaveLength(1);
    const steps = fake.seeded[0] ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ entries: parseSettingsDocument(DOCUMENT) });
    expect(err.at(-1)).toBe(
      `seeded from the settings document ${path} (SETTINGS_DOCUMENT); from here on settings are changed in the console`,
    );
  });

  test("a refused seed exits non-zero and names the conflicts", async () => {
    const path = join(root, "seed-refused.json");
    await writeFile(path, JSON.stringify(DOCUMENT));
    const fake = fakeStore(appliedImport, {
      result: {
        ...PLAN,
        conflicts: ["repository:open"],
        outcome: "refused",
        step: 0,
      },
    });
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(path),
        { settings: fake.store },
        output,
      ),
    ).toBe(false);
    expect(err.at(-1)).toBe(
      "refused: nothing changed (the settings document conflicts: repository:open)",
    );
  });

  test("another migrate that decided first while this one read is a note, not a failure", async () => {
    const path = join(root, "seed-raced.json");
    await writeFile(path, JSON.stringify(DOCUMENT));
    const fake = fakeStore(appliedImport, {
      result: { outcome: "not_empty" },
    });
    const { output, err } = captured();
    expect(
      await runSettingsCommand(
        seedCommand(path),
        { settings: fake.store },
        output,
      ),
    ).toBe(true);
    expect(fake.seeded).toHaveLength(1);
    expect(err.at(-1)).toContain("the installation already holds settings");
  });
});

describe("settings CLI", () => {
  test("import hands the operator's import the document's entries, with no rule of its own", async () => {
    const path = join(root, "import.json");
    await writeFile(path, JSON.stringify(DOCUMENT));
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    expect(
      await runSettingsCommand(
        { command: "import", document: path, dryRun: false },
        { settings: store },
        captured().output,
      ),
    ).toBe(true);
    const [entries, options] = asked[0] ?? [];
    expect(entries).toEqual(parseSettingsDocument(DOCUMENT));
    expect(options).toEqual({ dryRun: false, actor: null });
  });

  // It used to be left out with a note and the rest imported.
  test("a repository without a GitHub App refuses the whole document, and nothing is imported", async () => {
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
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const refusal = await runSettingsCommand(
      { command: "import", document: file, dryRun: false },
      { settings: store },
      captured().output,
    ).then(() => "resolved", inputRefusal);
    expect(refusal).toStartWith("The settings document is invalid");
    expect(refusal).toContain("old-url");
    expect(asked).toEqual([]);
  });

  test("the verify GitHub sandbox document is one migrate accepts", async () => {
    const path = join(
      import.meta.dir,
      "../../../../scripts/verify/github-sandbox/settings.json",
    );
    const entries = parseSettingsDocument(await Bun.file(path).json());
    expect(Object.keys(entries.repositories).sort()).toEqual([
      "sample-app",
      "sandbox",
    ]);
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
      { command: "import", document: path, dryRun: true },
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
