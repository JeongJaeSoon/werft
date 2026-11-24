import { describe, expect, test } from "bun:test";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "@werft-ai/platform";
import { createSlackAppService } from "./slack-app-service.ts";
import {
  type SlackBotDirectory,
  SlackRateLimitedError,
  type SlackWorkspaceBot,
} from "./slack-config-api.ts";
import {
  createMemorySecretStore,
  createMemorySlackAppStore,
} from "./testing/slack-fakes.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const APP_ROW = "019a0000-0000-7000-8000-0000000000d1";
const TEAM = "T0ACME";
const OWN_BOT = "U0NOTES";
/** Another agent's bot of this Werft install, in the same Slack team. */
const WERFT_BOT = "U0WRITER";
const NOW = new Date("2026-11-22T00:00:00.000Z");

function owner(role: WorkspaceRole = "owner"): Caller {
  return callerFor(
    {
      kind: "user",
      id: crypto.randomUUID(),
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const agentAuthority: AgentAuthority = {
  agentOf: async (_workspace, resource) =>
    resource.kind === "agent" ? resource.id : null,
  isAdmin: async () => false,
};

const bot = (
  id: string,
  name: string,
  extra: Partial<SlackWorkspaceBot> = {},
): SlackWorkspaceBot => ({ id, teamId: TEAM, name, deleted: false, ...extra });

function setup(
  pages: SlackWorkspaceBot[][],
  options: {
    installed?: boolean;
    /** Slack always has another page; these answer users.info. */
    beyond?: SlackWorkspaceBot[];
  } = {},
) {
  const secrets = createMemorySecretStore();
  const apps = createMemorySlackAppStore({
    secrets,
    agents: new Map([
      [
        AGENT,
        {
          id: AGENT,
          workspaceId: WORKSPACE,
          name: "Notes",
          slug: "notes",
          role: "Writes notes",
          active: true,
        },
      ],
    ]),
    installs: new Map(
      options.installed === false
        ? []
        : [
            [AGENT, { teamId: TEAM, botUserId: OWN_BOT }],
            [crypto.randomUUID(), { teamId: TEAM, botUserId: WERFT_BOT }],
          ],
    ),
  });
  apps.seed({
    id: APP_ROW,
    workspaceId: WORKSPACE,
    kind: "agent",
    agentId: AGENT,
    state: "created",
    appId: "A0NOTES",
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
    createdByTokenUser: "U0ISSUER",
    createdAt: NOW,
    updatedAt: NOW,
  });
  secrets.write(
    {
      workspaceId: WORKSPACE,
      owner: { kind: "slack_app", id: APP_ROW },
      purpose: "slack_bot_token",
    },
    "xoxb-test",
  );
  const reads: (string | null)[] = [];
  const looked: string[] = [];
  let failure: Error | null = null;
  const api: SlackBotDirectory = {
    async listBots(_token, cursor) {
      if (failure) throw failure;
      reads.push(cursor);
      const index = cursor === null ? 0 : Number(cursor);
      return {
        bots: pages[index] ?? [],
        nextCursor:
          options.beyond !== undefined || index + 1 < pages.length
            ? String(index + 1)
            : null,
      };
    },
    async findBot(_token, id) {
      looked.push(id);
      return options.beyond?.find((found) => found.id === id) ?? null;
    },
  };
  const service = createSlackAppService({
    authorization: createAuthorizationPolicy({ agents: agentAuthority }),
    apps: apps.store,
    tokens: {} as never,
    api: {} as never,
    consoleOrigin: "https://console.example",
    bots: { secrets: secrets.store, api },
  });
  return {
    service,
    apps,
    reads,
    looked,
    fail(error: Error) {
      failure = error;
    },
  };
}

describe("the operator's changes to the agent's Slack bot allow list", () => {
  const pages = () => [
    [
      bot("U0REVIEW", "code-review"),
      bot(OWN_BOT, "notes"),
      bot(WERFT_BOT, "writer"),
      bot("U0FOREIGN", "x", { teamId: "T0OTHER" }),
    ],
  ];

  test("allows a live bot, once: allowing it again changes nothing", async () => {
    const { service } = setup(pages());
    const first = await service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
      action: "allow",
      botUserId: "U0REVIEW",
    });
    expect(first).toMatchObject({
      changed: true,
      added: ["U0REVIEW"],
      removed: [],
      allowed_user_ids: ["U0REVIEW"],
    });
    const again = await service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
      action: "allow",
      botUserId: "U0REVIEW",
    });
    expect(again).toMatchObject({ changed: false, added: [], removed: [] });
    const listed = await service.listAgentAppBotsAsOperator(WORKSPACE, AGENT);
    expect(listed.items).toEqual([
      {
        user_id: "U0REVIEW",
        name: "code-review",
        state: "active",
        allowed: true,
      },
    ]);
  });

  test("refuses each reason as the console does", async () => {
    const { service } = setup(pages());
    for (const [id, reason] of [
      [OWN_BOT, "slack_bot_own"],
      [WERFT_BOT, "slack_bot_werft_agent"],
      ["U0FOREIGN", "slack_bot_other_team"],
      ["U0PERSON", "slack_bot_unknown"],
    ] as const) {
      await expect(
        service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
          action: "allow",
          botUserId: id,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: reason, user_ids: [id] },
      });
    }
  });

  test("allowing a bot Slack lost but the agent still has changes nothing and adds nothing back", async () => {
    const { service, apps } = setup([[bot("U0OLD", "old", { deleted: true })]]);
    await apps.store.putAllowedBots({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      actor: null,
      allowedBotUserIds: ["U0OLD"],
    });
    const same = await service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
      action: "allow",
      botUserId: "U0OLD",
    });
    expect(same).toMatchObject({ changed: false, allowed_user_ids: ["U0OLD"] });
    // Not allowed any more, and gone: refused, as a new bot would be.
    await service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
      action: "disallow",
      botUserId: "U0OLD",
    });
    await expect(
      service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
        action: "allow",
        botUserId: "U0OLD",
      }),
    ).rejects.toMatchObject({ details: { reason_code: "slack_bot_unknown" } });
  });

  test("disallows one bot without asking Slack, and a bot not allowed changes nothing", async () => {
    const { service, reads, apps } = setup(pages());
    await apps.store.putAllowedBots({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      actor: null,
      allowedBotUserIds: ["U0REVIEW", "U0OTHER"],
    });
    const removed = await service.changeAgentAppBotAsOperator(
      WORKSPACE,
      AGENT,
      {
        action: "disallow",
        botUserId: "U0REVIEW",
      },
    );
    expect(removed).toMatchObject({
      changed: true,
      removed: ["U0REVIEW"],
      allowed_user_ids: ["U0OTHER"],
    });
    const none = await service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
      action: "disallow",
      botUserId: "U0REVIEW",
    });
    expect(none.changed).toBe(false);
    expect(reads).toEqual([]);
  });

  test("a list past the most an agent answers is refused, and an unknown agent is not found", async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      bot(`U0BOT${i}`, `b${i}`),
    );
    const { service, apps } = setup([many]);
    await apps.store.putAllowedBots({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      actor: null,
      allowedBotUserIds: many.slice(0, 20).map((b) => b.id),
    });
    await expect(
      service.changeAgentAppBotAsOperator(WORKSPACE, AGENT, {
        action: "allow",
        botUserId: "U0BOT20",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason_code: "slack_bots_too_many" },
    });
    await expect(
      service.listAgentAppBotsAsOperator(WORKSPACE, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the agent's Slack bot allow list", () => {
  test("lists every page's bots of the install's team but this Werft install's agents, live ones by name", async () => {
    const { service, reads } = setup([
      [bot("U0ZED", "zed"), bot(OWN_BOT, "notes"), bot(WERFT_BOT, "writer")],
      [bot("U0ALPHA", "alpha"), bot("U0FOREIGN", "x", { teamId: "T0OTHER" })],
    ]);
    const listed = await service.getAgentAppBots(owner(), AGENT);
    expect(reads).toEqual([null, "1"]);
    expect(listed.truncated).toBe(false);
    expect(listed.items).toEqual([
      { user_id: "U0ALPHA", name: "alpha", state: "active", allowed: false },
      { user_id: "U0ZED", name: "zed", state: "active", allowed: false },
    ]);
  });

  test("saves live bots and shows an allowed bot Slack lost as gone", async () => {
    const pages = [[bot("U0REVIEW", "code-review"), bot("U0OLD", "old")]];
    const { service } = setup(pages);
    const saved = await service.putAgentAppBots(owner(), AGENT, {
      allowed_user_ids: ["U0REVIEW", "U0OLD"],
    });
    expect(saved.items.filter((item) => item.allowed)).toHaveLength(2);

    // Slack deactivates one and drops the other from its list.
    pages[0] = [bot("U0OLD", "old", { deleted: true })];
    const listed = await service.getAgentAppBots(owner(), AGENT);
    expect(listed.items).toEqual([
      { user_id: "U0REVIEW", name: null, state: "gone", allowed: true },
      { user_id: "U0OLD", name: "old", state: "gone", allowed: true },
    ]);
    // Kept while gone, so the rest of the list still saves.
    await service.putAgentAppBots(owner(), AGENT, {
      allowed_user_ids: ["U0REVIEW"],
    });
  });

  test("refuses to add the agent's own bot, another Werft agent's, another team's, a deleted bot, or an id that is no bot here", async () => {
    const { service } = setup([
      [
        bot(OWN_BOT, "notes"),
        bot(WERFT_BOT, "writer"),
        bot("U0FOREIGN", "x", { teamId: "T0OTHER" }),
        bot("U0DEAD", "dead", { deleted: true }),
      ],
    ]);
    for (const [id, reason] of [
      [OWN_BOT, "slack_bot_own"],
      [WERFT_BOT, "slack_bot_werft_agent"],
      ["U0FOREIGN", "slack_bot_other_team"],
      ["U0DEAD", "slack_bot_unknown"],
      ["U0PERSON", "slack_bot_unknown"],
    ] as const) {
      await expect(
        service.putAgentAppBots(owner(), AGENT, { allowed_user_ids: [id] }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: reason, user_ids: [id] },
      });
    }
    expect(
      (await service.getAgentAppBots(owner(), AGENT)).items.some(
        (item) => item.allowed,
      ),
    ).toBe(false);
  });

  test("a bot allowed before it became another Werft agent's is out of the list and refused again", async () => {
    const { service, apps } = setup([
      [bot("U0REVIEW", "code-review"), bot(WERFT_BOT, "writer")],
    ]);
    // Saved while it was still any bot of the team.
    await apps.store.putAllowedBots({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      actor: {} as never,
      allowedBotUserIds: ["U0REVIEW", WERFT_BOT],
    });
    const listed = await service.getAgentAppBots(owner(), AGENT);
    expect(listed.items.map((item) => item.user_id)).toEqual(["U0REVIEW"]);
    await expect(
      service.putAgentAppBots(owner(), AGENT, {
        allowed_user_ids: ["U0REVIEW", WERFT_BOT],
      }),
    ).rejects.toMatchObject({
      details: { reason_code: "slack_bot_werft_agent", user_ids: [WERFT_BOT] },
    });
    // Saving what the list shows lets it go.
    const saved = await service.putAgentAppBots(owner(), AGENT, {
      allowed_user_ids: ["U0REVIEW"],
    });
    expect(saved.items.filter((item) => item.allowed)).toHaveLength(1);
  });

  test("a member reads nothing and saves nothing; an agent without an install is told so", async () => {
    const { service } = setup([[bot("U0REVIEW", "code-review")]]);
    await expect(
      service.putAgentAppBots(owner("member"), AGENT, {
        allowed_user_ids: ["U0REVIEW"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bare = setup([[bot("U0REVIEW", "code-review")]], {
      installed: false,
    });
    await expect(
      bare.service.getAgentAppBots(owner(), AGENT),
    ).rejects.toMatchObject({ code: "SLACK_NOT_INSTALLED" });
  });

  test("past the pages it reads, allowed and asked ids are looked up one by one", async () => {
    const { service, reads, looked } = setup([[bot("U0NEAR", "near")]], {
      beyond: [
        bot("U0FAR", "far"),
        bot("U0FARGONE", "far-gone", { deleted: true }),
        bot("U0FARFOREIGN", "x", { teamId: "T0OTHER" }),
      ],
    });
    const saved = await service.putAgentAppBots(owner(), AGENT, {
      allowed_user_ids: ["U0FAR", "U0NEAR"],
    });
    expect(reads).toHaveLength(20);
    // The near one came on a page; only the far one was looked up.
    expect(looked).toEqual(["U0FAR"]);
    expect(saved.items.filter((item) => item.allowed)).toEqual([
      { user_id: "U0FAR", name: "far", state: "active", allowed: true },
      { user_id: "U0NEAR", name: "near", state: "active", allowed: true },
    ]);
    expect(saved.truncated).toBe(true);
    for (const [id, reason] of [
      ["U0FARGONE", "slack_bot_unknown"],
      ["U0FARFOREIGN", "slack_bot_other_team"],
      [WERFT_BOT, "slack_bot_werft_agent"],
      ["U0NOWHERE", "slack_bot_unknown"],
    ] as const) {
      await expect(
        service.putAgentAppBots(owner(), AGENT, {
          allowed_user_ids: ["U0FAR", id],
        }),
      ).rejects.toMatchObject({
        details: { reason_code: reason, user_ids: [id] },
      });
    }
  });

  test("Slack's rate limit comes back as a wait", async () => {
    const { service, fail } = setup([[]]);
    fail(new SlackRateLimitedError("users.list", 30));
    await expect(service.getAgentAppBots(owner(), AGENT)).rejects.toMatchObject(
      { code: "BACKEND_UNAVAILABLE", retry: { afterSeconds: 30 } },
    );
  });
});
