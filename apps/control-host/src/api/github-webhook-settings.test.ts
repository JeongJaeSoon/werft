import { describe, expect, test } from "bun:test";
import {
  type GitHubWebhookUpdateFailure,
  type Principal,
  scopesForRole,
} from "@werft-ai/contracts";
import type {
  GitHubWebhookApp,
  GitHubWebhookSettingsStore,
} from "@werft-ai/db";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "@werft-ai/platform";
import { refusal } from "@werft-ai/platform/testing/refusal";
import { userPrincipal } from "@werft-ai/testkit/callers";
import {
  carryOverGitHubWebhookSettings,
  createGitHubWebhookSettingsAdmin,
  githubWebhookUrlFrom,
  importGitHubWebhookBaseUrl,
} from "./github-webhook-settings.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER = "019a0000-0000-7000-8000-0000000000a2";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const BASE = "https://hooks.example.test/in";
const URL = `${BASE}/v1/github/webhook`;

function caller(who: keyof typeof USERS): Caller {
  return callerFor(
    userPrincipal(USERS[who], WORKSPACE, who),
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

const app = (
  appId: number,
  workspaceIds: string[],
  privateKey: string | null = `key-${appId}`,
): GitHubWebhookApp => ({
  appId,
  apiBase: "https://api.github.test",
  name: `werft-${appId}`,
  workspaceIds,
  privateKey,
});

/** A store holding one row, or none, in memory. */
function memoryStore(initial: { publicUrl: string | null } | null) {
  let row = initial;
  const saves: Array<{ value: string | null; userId: string }> = [];
  const imports: string[] = [];
  const store: GitHubWebhookSettingsStore = {
    read: async () => row,
    setPublicUrl: async ({ value, audit }) => {
      saves.push({ value, userId: audit.userId });
      const changed = (row?.publicUrl ?? null) !== value;
      row = { publicUrl: value };
      return { changed };
    },
    importPublicUrl: async (value) => {
      imports.push(value);
      if (row !== null) return false;
      row = { publicUrl: value };
      return true;
    },
  };
  return { store, saves, imports, row: () => row };
}

function admin(
  initial: { publicUrl: string | null } | null,
  apps: GitHubWebhookApp[] = [],
  answers: Record<number, "updated" | GitHubWebhookUpdateFailure> = {},
) {
  const memory = memoryStore(initial);
  const sent: Array<{ appId: number; privateKey: string; url: string }> = [];
  const warned: Array<{ message: string; fields: unknown }> = [];
  return {
    ...memory,
    sent,
    warned,
    admin: createGitHubWebhookSettingsAdmin({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: memory.store,
      apps: async () => apps,
      setHook: async (target, url) => {
        sent.push({ appId: target.appId, privateKey: target.privateKey, url });
        return answers[target.appId] ?? "updated";
      },
      warn: (message, fields) => warned.push({ message, fields }),
    }),
  };
}

describe("the GitHub webhook settings service", () => {
  test("is the signed-in owner's: an admin, a member and an owner's API key read, save and send nothing", async () => {
    const {
      admin: service,
      saves,
      sent,
    } = admin({ publicUrl: BASE }, [app(7, [WORKSPACE])]);
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      for (const attempt of [
        service.read(who),
        service.change(who, { webhook_public_url: "https://new.example.test" }),
        service.retry(who, { app_ids: [7] }),
      ]) {
        expect((await refusal(attempt)).code).toBe("FORBIDDEN");
      }
    }
    expect(saves).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("reads the saved address, the URL Apps get, and which Apps other workspaces hold", async () => {
    const { admin: service } = admin({ publicUrl: BASE }, [
      app(7, [WORKSPACE]),
      app(8, [WORKSPACE, OTHER]),
      app(9, [OTHER]),
    ]);
    expect(await service.read(caller("owner"))).toEqual({
      webhook_public_url: BASE,
      webhook_url: URL,
      apps: [
        { app_id: 7, name: "werft-7", other_workspaces: 0 },
        { app_id: 8, name: "werft-8", other_workspaces: 1 },
        { app_id: 9, name: "werft-9", other_workspaces: 1 },
      ],
    });
    const empty = admin(null);
    expect(await empty.admin.read(caller("owner"))).toEqual({
      webhook_public_url: null,
      webhook_url: null,
      apps: [],
    });
  });

  test("a changed address commits with its receipt, then every App is set to it and answers on its own", async () => {
    const {
      admin: service,
      saves,
      sent,
      warned,
    } = admin(
      { publicUrl: "https://old.example.test" },
      [app(7, [WORKSPACE]), app(8, [OTHER]), app(9, [OTHER], null)],
      { 8: "url_refused" },
    );
    const answer = await service.change(caller("owner"), {
      webhook_public_url: ` ${BASE}/ `,
    });
    expect(saves).toEqual([{ value: BASE, userId: USERS.owner }]);
    expect(answer.receipt_id).toBeString();
    expect(answer.webhook_url).toBe(URL);
    expect(answer.updates).toEqual([
      { app_id: 7, name: "werft-7", outcome: "updated" },
      {
        app_id: 8,
        name: "werft-8",
        outcome: "failed",
        reason_code: "url_refused",
      },
      {
        app_id: 9,
        name: "werft-9",
        outcome: "failed",
        reason_code: "key_unreadable",
      },
    ]);
    // An App whose key does not open is never sent.
    expect(sent).toEqual([
      { appId: 7, privateKey: "key-7", url: URL },
      { appId: 8, privateKey: "key-8", url: URL },
    ]);
    // The log names the App and the reason, never the address or a key.
    const byApp = (fields: unknown) => (fields as { app_id: number }).app_id;
    expect(
      warned.map(({ fields }) => fields).sort((a, b) => byApp(a) - byApp(b)),
    ).toEqual([
      { app_id: 8, reason_code: "url_refused" },
      { app_id: 9, reason_code: "key_unreadable" },
    ]);
  });

  test("a slower PATCH of an earlier save does not leave the App on that address", async () => {
    const memory = memoryStore(null);
    const sent: string[] = [];
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = createGitHubWebhookSettingsAdmin({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: memory.store,
      apps: async () => [app(7, [WORKSPACE])],
      setHook: async (_target, url) => {
        if (sent.length === 0) {
          sent.push(url);
          await firstHeld;
        } else {
          sent.push(url);
        }
        return "updated";
      },
      warn: () => {},
    });
    const first = service.change(caller("owner"), {
      webhook_public_url: "https://a.example.test",
    });
    await Bun.sleep(0);
    await service.change(caller("owner"), {
      webhook_public_url: "https://b.example.test",
    });
    releaseFirst();
    await first;
    expect(sent).toEqual([
      "https://a.example.test/v1/github/webhook",
      "https://b.example.test/v1/github/webhook",
      "https://b.example.test/v1/github/webhook",
    ]);
  });

  test("a PATCH keeps following saves made meanwhile and ends on what is saved", async () => {
    const memory = memoryStore(null);
    const sent: string[] = [];
    const later = [
      "https://b.example.test",
      "https://c.example.test",
      "https://d.example.test",
      "https://e.example.test",
    ];
    const service = createGitHubWebhookSettingsAdmin({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: memory.store,
      apps: async () => [app(7, [WORKSPACE])],
      setHook: async (_target, url) => {
        sent.push(url);
        // Another replica saves while this PATCH is out.
        const next = later.shift();
        if (next !== undefined) {
          await memory.store.setPublicUrl({
            value: next,
            audit: {
              userId: USERS.owner,
              workspaceId: WORKSPACE,
              receiptId: crypto.randomUUID(),
            },
          });
        }
        return "updated";
      },
      warn: () => {},
    });
    const answer = await service.change(caller("owner"), {
      webhook_public_url: "https://a.example.test",
    });
    expect(answer.updates).toEqual([
      { app_id: 7, name: "werft-7", outcome: "updated" },
    ]);
    expect(sent.at(-1)).toBe("https://e.example.test/v1/github/webhook");
    expect(sent).toHaveLength(5);
  });

  test("a new App follows the saved address, and nothing is sent while none is saved", async () => {
    const unset = admin(null);
    expect(
      await unset.admin.follow({
        appId: 5,
        apiBase: "https://api.github.test",
        name: "new",
        privateKey: "key-5",
      }),
    ).toBe(null);
    expect(unset.sent).toEqual([]);
    const saved = admin({ publicUrl: BASE });
    expect(
      await saved.admin.follow({
        appId: 5,
        apiBase: "https://api.github.test",
        name: "new",
        privateKey: "key-5",
      }),
    ).toEqual({ app_id: 5, name: "new", outcome: "updated" });
    expect(saved.sent.map(({ url }) => url)).toEqual([URL]);
  });

  test("a failed PATCH ends the loop at once, even when the address moved meanwhile", async () => {
    for (const failure of [
      "url_refused",
      "github_rejected",
      "github_unreachable",
    ] as const) {
      const memory = memoryStore(null);
      const sent: string[] = [];
      const service = createGitHubWebhookSettingsAdmin({
        authorization: createAuthorizationPolicy({
          agents: { agentOf: async () => null, isAdmin: async () => false },
          decisions: { record: async () => {} },
        }),
        store: memory.store,
        apps: async () => [app(7, [WORKSPACE])],
        setHook: async (_target, url) => {
          sent.push(url);
          await memory.store.setPublicUrl({
            value: "https://b.example.test",
            audit: {
              userId: USERS.owner,
              workspaceId: WORKSPACE,
              receiptId: crypto.randomUUID(),
            },
          });
          return failure;
        },
        warn: () => {},
      });
      const answer = await service.change(caller("owner"), {
        webhook_public_url: "https://a.example.test",
      });
      expect(answer.updates).toEqual([
        { app_id: 7, name: "werft-7", outcome: "failed", reason_code: failure },
      ]);
      expect(sent).toEqual(["https://a.example.test/v1/github/webhook"]);
    }
  });

  test("an updated App gets one PATCH when the address did not move, and one more per address saved since", async () => {
    const still = admin(null, [app(7, [WORKSPACE])]);
    await still.admin.change(caller("owner"), { webhook_public_url: BASE });
    expect(still.sent.map(({ url }) => url)).toEqual([URL]);
    const retried = admin({ publicUrl: BASE }, [app(7, [WORKSPACE])]);
    await retried.admin.retry(caller("owner"), { app_ids: [7] });
    expect(retried.sent.map(({ url }) => url)).toEqual([URL]);
  });

  test("the address already saved leaves no receipt and sends no App", async () => {
    const { admin: service, sent } = admin({ publicUrl: BASE }, [
      app(7, [WORKSPACE]),
    ]);
    const answer = await service.change(caller("owner"), {
      webhook_public_url: BASE,
    });
    expect(answer.receipt_id).toBeUndefined();
    expect(answer.updates).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("clearing keeps the row and sends no App", async () => {
    for (const cleared of [null, "", "  "]) {
      const {
        admin: service,
        sent,
        row,
      } = admin({ publicUrl: BASE }, [app(7, [WORKSPACE])]);
      const answer = await service.change(caller("owner"), {
        webhook_public_url: cleared,
      });
      expect(answer).toMatchObject({
        webhook_public_url: null,
        webhook_url: null,
        updates: [],
      });
      expect(answer.receipt_id).toBeString();
      expect(sent).toEqual([]);
      expect(row()).toEqual({ publicUrl: null });
    }
  });

  test.each([
    "http://hooks.example.test",
    "https://hooks.example.test/?a=1",
    "https://hooks.example.test/#a",
    "https://user:pass@hooks.example.test",
    "hooks.example.test",
  ])("refuses %s before the store, with webhook_url_invalid", async (value) => {
    const { admin: service, saves, sent } = admin(null, [app(7, [WORKSPACE])]);
    expect(
      await refusal(
        service.change(caller("owner"), { webhook_public_url: value }),
      ),
    ).toEqual({
      code: "BAD_REQUEST",
      details: { reason_code: "webhook_url_invalid" },
    });
    expect(saves).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a retry sends the saved address to the Apps named, once each, and says which are gone", async () => {
    const {
      admin: service,
      sent,
      saves,
    } = admin({ publicUrl: BASE }, [app(7, [WORKSPACE]), app(8, [OTHER])]);
    expect(
      await service.retry(caller("owner"), { app_ids: [8, 8, 404] }),
    ).toEqual({
      updates: [
        { app_id: 8, name: "werft-8", outcome: "updated" },
        {
          app_id: 404,
          name: null,
          outcome: "failed",
          reason_code: "not_found",
        },
      ],
    });
    expect(sent).toEqual([{ appId: 8, privateKey: "key-8", url: URL }]);
    expect(saves).toEqual([]);
  });

  test("a retry with nothing saved is refused with webhook_url_unset", async () => {
    for (const initial of [null, { publicUrl: null }]) {
      const { admin: service, sent } = admin(initial, [app(7, [WORKSPACE])]);
      expect(
        await refusal(service.retry(caller("owner"), { app_ids: [7] })),
      ).toEqual({
        code: "REVISION_CONFLICT",
        details: { reason_code: "webhook_url_unset" },
      });
      expect(sent).toEqual([]);
    }
  });
});

describe("the webhook URL Apps and the skill sync read", () => {
  test("follows a save without a restart", async () => {
    const { store } = memoryStore(null);
    const url = githubWebhookUrlFrom(store);
    const audit = {
      userId: USERS.owner,
      workspaceId: WORKSPACE,
      receiptId: "r",
    };
    expect(await url()).toBe(null);
    await store.setPublicUrl({ value: BASE, audit });
    expect(await url()).toBe(URL);
    await store.setPublicUrl({ value: null, audit });
    expect(await url()).toBe(null);
  });
});

describe("carrying GITHUB_WEBHOOK_BASE_URL in on upgrade", () => {
  const CARRIED =
    "GITHUB_WEBHOOK_BASE_URL was carried into Settings > Integrations > GitHub and is no longer read; remove it";

  test("an unset or empty value does nothing", async () => {
    for (const env of [{}, { GITHUB_WEBHOOK_BASE_URL: "" }]) {
      const { store, imports } = memoryStore(null);
      expect(await importGitHubWebhookBaseUrl(env, store)).toEqual([]);
      expect(imports).toEqual([]);
    }
  });

  test("a valid value is carried in while nothing is saved, and the warning holds no value", async () => {
    const { store, row } = memoryStore(null);
    const warnings = await importGitHubWebhookBaseUrl(
      { GITHUB_WEBHOOK_BASE_URL: `${BASE}/` },
      store,
    );
    expect(row()).toEqual({ publicUrl: BASE });
    expect(warnings).toEqual([CARRIED]);
  });

  test("a value that is not plain https is not carried in, and no longer stops the start", async () => {
    for (const value of [
      "hooks.example.test",
      "http://hooks.example.test",
      "https://hooks.example.test/?a=1",
    ]) {
      const { store, row, imports } = memoryStore(null);
      const warnings = await importGitHubWebhookBaseUrl(
        { GITHUB_WEBHOOK_BASE_URL: value },
        store,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith(
        "GITHUB_WEBHOOK_BASE_URL was not carried in",
      );
      expect(warnings[0]).not.toContain(value);
      expect(row()).toBe(null);
      expect(imports).toEqual([]);
    }
  });

  test("once settings exist, even cleared ones, the env is ignored", async () => {
    for (const saved of [
      { publicUrl: null },
      { publicUrl: "https://other.example.test" },
    ]) {
      const { store, row, imports } = memoryStore(saved);
      expect(
        await importGitHubWebhookBaseUrl(
          { GITHUB_WEBHOOK_BASE_URL: BASE },
          store,
        ),
      ).toEqual(["Ignored removed settings: GITHUB_WEBHOOK_BASE_URL"]);
      expect(row()).toEqual(saved);
      expect(imports).toEqual([]);
    }
  });

  test("a database that does not answer yet is retried, and a read waits for the carry-over", async () => {
    const memory = memoryStore(null);
    const state = { down: true };
    const flaky: GitHubWebhookSettingsStore = {
      ...memory.store,
      read: async () => {
        if (state.down) throw new Error("connect ECONNREFUSED");
        return memory.store.read();
      },
    };
    const warned: string[] = [];
    const carrying = carryOverGitHubWebhookSettings({
      env: { GITHUB_WEBHOOK_BASE_URL: BASE },
      store: flaky,
      warn: (message) => warned.push(message),
      info: () => {},
      retryMs: 60_000,
    });
    await carrying.started;
    expect(warned).toEqual([
      "GitHub webhook settings could not be read; retrying",
    ]);
    state.down = false;
    expect(await githubWebhookUrlFrom(carrying.store)()).toBe(URL);
    expect(memory.imports).toEqual([BASE]);
    expect(warned.slice(1)).toEqual([CARRIED]);
  });

  test("says once that no webhook address is saved", async () => {
    const { store } = memoryStore(null);
    const said: string[] = [];
    await carryOverGitHubWebhookSettings({
      env: {},
      store,
      warn: () => {},
      info: (message) => said.push(message),
      retryMs: 5,
    }).started;
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("GitHub skills sync without push webhooks");
  });
});
