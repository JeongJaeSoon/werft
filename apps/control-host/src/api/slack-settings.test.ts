import { describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { SlackSettingsStore } from "@werft-ai/db";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  carryOverSlackSettings,
  createSlackSettingsAdmin,
  importSlackEventsPublicUrl,
  slackEventsBaseOf,
} from "./slack-settings.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const CONSOLE = "https://werft.example.test";
const EVENTS = "https://events.example.test/in";

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
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

/** A store holding one row, or none, in memory. */
function memoryStore(initial: { eventsPublicUrl: string | null } | null) {
  let row = initial;
  const saves: Array<{ value: string | null; userId: string }> = [];
  const imports: string[] = [];
  const store: SlackSettingsStore = {
    read: async () => row,
    setEventsPublicUrl: async ({ value, audit }) => {
      saves.push({ value, userId: audit.userId });
      const changed = (row?.eventsPublicUrl ?? null) !== value;
      row = { eventsPublicUrl: value };
      return { changed };
    },
    importEventsPublicUrl: async (value) => {
      imports.push(value);
      if (row !== null) return false;
      row = { eventsPublicUrl: value };
      return true;
    },
  };
  return { store, saves, imports, row: () => row };
}

function admin(
  initial: { eventsPublicUrl: string | null } | null,
  consoleOrigin: string | null = CONSOLE,
) {
  const memory = memoryStore(initial);
  return {
    ...memory,
    admin: createSlackSettingsAdmin({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: memory.store,
      consoleOrigin,
    }),
  };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the Slack settings service", () => {
  test("is the signed-in owner's: an admin, a member and an owner's API key read and save nothing", async () => {
    const { admin: service, saves } = admin(null);
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      for (const attempt of [
        service.read(who),
        service.change(who, { events_public_url: EVENTS }),
      ]) {
        expect((await refusal(attempt)).code).toBe("FORBIDDEN");
      }
    }
    expect(saves).toEqual([]);
  });

  test("reads the computed address while nothing is saved, and the saved one after", async () => {
    const { admin: service } = admin(null);
    expect(await service.read(caller("owner"))).toEqual({
      events_public_url: null,
      computed_events_base: CONSOLE,
      events_url_template: `${CONSOLE}/v1/slack/events/{agent_id}`,
    });
    const saved = await service.change(caller("owner"), {
      events_public_url: `${EVENTS}/`,
    });
    expect(saved).toEqual({
      events_public_url: EVENTS,
      computed_events_base: CONSOLE,
      events_url_template: `${EVENTS}/v1/slack/events/{agent_id}`,
      receipt_id: expect.any(String),
    });
    expect(await service.read(caller("owner"))).toEqual({
      events_public_url: EVENTS,
      computed_events_base: CONSOLE,
      events_url_template: `${EVENTS}/v1/slack/events/{agent_id}`,
    });
  });

  test("the address already saved answers without a receipt", async () => {
    const { admin: service, saves } = admin({ eventsPublicUrl: EVENTS });
    const again = await service.change(caller("owner"), {
      events_public_url: EVENTS,
    });
    expect(again).not.toHaveProperty("receipt_id");
    expect(saves).toEqual([{ value: EVENTS, userId: USERS.owner }]);
  });

  test("null or blank clears it; without https CONSOLE_ORIGIN nothing is sent", async () => {
    for (const cleared of [null, "", "   "]) {
      const { admin: service, row } = admin(
        { eventsPublicUrl: EVENTS },
        "http://werft.example.test",
      );
      expect(
        await service.change(caller("owner"), {
          events_public_url: cleared,
        }),
      ).toEqual({
        events_public_url: null,
        computed_events_base: null,
        events_url_template: null,
        receipt_id: expect.any(String),
      });
      // The row stays, so a later start does not carry the old env in.
      expect(row()).toEqual({ eventsPublicUrl: null });
    }
  });

  test.each([
    "http://events.example.test",
    "https://events.example.test/?a=1",
    "https://events.example.test/#a",
    "https://user:pass@events.example.test",
    "events.example.test",
  ])("refuses %s before the store, with events_url_invalid", async (value) => {
    const { admin: service, saves } = admin(null);
    expect(
      await refusal(
        service.change(caller("owner"), { events_public_url: value }),
      ),
    ).toEqual({
      code: "BAD_REQUEST",
      details: { reason_code: "events_url_invalid" },
    });
    expect(saves).toEqual([]);
  });
});

describe("the events base Slack is sent", () => {
  test("follows a save without a restart, and falls back to the console", async () => {
    const { store } = memoryStore(null);
    const base = slackEventsBaseOf(store, CONSOLE);
    expect(await base()).toBe(CONSOLE);
    await store.setEventsPublicUrl({
      value: EVENTS,
      audit: { userId: USERS.owner, workspaceId: WORKSPACE, receiptId: "r" },
    });
    expect(await base()).toBe(EVENTS);
    await store.setEventsPublicUrl({
      value: null,
      audit: { userId: USERS.owner, workspaceId: WORKSPACE, receiptId: "r" },
    });
    expect(await base()).toBe(CONSOLE);
  });
});

describe("carrying SLACK_EVENTS_PUBLIC_URL in on upgrade", () => {
  test("an unset or empty value does nothing", async () => {
    for (const env of [{}, { SLACK_EVENTS_PUBLIC_URL: "" }]) {
      const { store, imports } = memoryStore(null);
      expect(await importSlackEventsPublicUrl(env, store)).toEqual([]);
      expect(imports).toEqual([]);
    }
  });

  test("a valid value is carried in while nothing is saved, and the warning holds no value", async () => {
    const { store, row } = memoryStore(null);
    const warnings = await importSlackEventsPublicUrl(
      { SLACK_EVENTS_PUBLIC_URL: "https://events.example.test/in/" },
      store,
    );
    expect(row()).toEqual({ eventsPublicUrl: EVENTS });
    expect(warnings).toEqual([
      "SLACK_EVENTS_PUBLIC_URL was carried into Settings > Integrations > Slack and is no longer read; remove it",
    ]);
  });

  test("once settings exist, even cleared ones, the env is ignored", async () => {
    for (const saved of [
      { eventsPublicUrl: null },
      { eventsPublicUrl: "https://other.example.test" },
    ]) {
      const { store, row, imports } = memoryStore(saved);
      expect(
        await importSlackEventsPublicUrl(
          { SLACK_EVENTS_PUBLIC_URL: EVENTS },
          store,
        ),
      ).toEqual(["Ignored removed settings: SLACK_EVENTS_PUBLIC_URL"]);
      expect(row()).toEqual(saved);
      expect(imports).toEqual([]);
    }
  });

  test("another replica carrying it in first leaves only the ignored warning", async () => {
    const { store } = memoryStore(null);
    const racing: SlackSettingsStore = {
      ...store,
      importEventsPublicUrl: async () => false,
    };
    expect(
      await importSlackEventsPublicUrl(
        { SLACK_EVENTS_PUBLIC_URL: EVENTS },
        racing,
      ),
    ).toEqual(["Ignored removed settings: SLACK_EVENTS_PUBLIC_URL"]);
  });

  test("an invalid value is not carried in and no longer stops the start", async () => {
    const leak = "http://leak-canary.example.test/?token=canary";
    const { store, imports } = memoryStore(null);
    const warnings = await importSlackEventsPublicUrl(
      { SLACK_EVENTS_PUBLIC_URL: leak },
      store,
    );
    expect(imports).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was not carried in");
    expect(warnings.join("\n")).not.toContain("canary");
  });
});

describe("the carry-over at start", () => {
  const CARRIED =
    "SLACK_EVENTS_PUBLIC_URL was carried into Settings > Integrations > Slack and is no longer read; remove it";
  const RETRYING = "Slack settings could not be read; retrying";

  /** A memory store whose reads fail while `down` is set. */
  function flakyStore() {
    const memory = memoryStore(null);
    const state = { down: true };
    const store: SlackSettingsStore = {
      ...memory.store,
      read: async () => {
        if (state.down) throw new Error("connect ECONNREFUSED");
        return memory.store.read();
      },
    };
    return { ...memory, store, state };
  }

  test("a database that does not answer yet is retried, not a stopped start", async () => {
    const { store, row, state } = flakyStore();
    const warned: string[] = [];
    await carryOverSlackSettings({
      env: { SLACK_EVENTS_PUBLIC_URL: `${EVENTS}/` },
      store,
      consoleOrigin: CONSOLE,
      warn: (message) => warned.push(message),
      retryMs: 5,
    }).started;
    expect(warned).toEqual([RETRYING]);
    expect(row()).toBe(null);
    state.down = false;
    await Bun.sleep(50);
    expect(row()).toEqual({ eventsPublicUrl: EVENTS });
    expect(warned.slice(1)).toEqual([CARRIED]);
  });

  test("a request before the retry carries the env in first, never sending the computed address", async () => {
    const { store, imports, state } = flakyStore();
    const warned: string[] = [];
    const carrying = carryOverSlackSettings({
      env: { SLACK_EVENTS_PUBLIC_URL: EVENTS },
      store,
      consoleOrigin: CONSOLE,
      warn: (message) => warned.push(message),
      retryMs: 60_000,
    });
    await carrying.started;
    state.down = false;
    const base = slackEventsBaseOf(carrying.store, CONSOLE);
    expect(await base()).toBe(EVENTS);
    expect(await base()).toBe(EVENTS);
    expect(imports).toEqual([EVENTS]);
    expect(warned).toEqual([RETRYING, CARRIED]);
  });

  test("a read failing with nothing to carry still warns of no address once it answers", async () => {
    const { store, state } = flakyStore();
    const warned: string[] = [];
    await carryOverSlackSettings({
      env: {},
      store,
      consoleOrigin: null,
      warn: (message) => warned.push(message),
      retryMs: 5,
    }).started;
    expect(warned).toEqual([RETRYING]);
    state.down = false;
    await Bun.sleep(50);
    expect(warned).toHaveLength(2);
    expect(warned[1]).toStartWith("Slack apps get no event subscription");
  });

  test("says once that no events address is known", async () => {
    const { store } = memoryStore(null);
    const warned: string[] = [];
    await carryOverSlackSettings({
      env: {},
      store,
      consoleOrigin: null,
      warn: (message) => warned.push(message),
      retryMs: 5,
    }).started;
    expect(warned).toHaveLength(1);
    expect(warned[0]).toStartWith("Slack apps get no event subscription");
  });
});
