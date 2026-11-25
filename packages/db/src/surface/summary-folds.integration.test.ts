import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationInputId,
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
} from "@werft-ai/contracts";
import {
  createConversationCallExecutor,
  createConversationCalls,
  createSummaryFolder,
  hashConversationCallToken,
  type OutboundHttp,
  type ProviderUsage,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { saveBudgetLimit } from "../budget-accounts.ts";
import { createPostgresConversationCalls } from "../conversation-calls.ts";
import {
  claimChannelSummaryFold,
  createPostgresChannelSummaryStore,
  releaseChannelSummaryFold,
} from "../conversations/channel-summaries.ts";
import { createPostgresSummaryFoldContexts } from "../conversations/context-fragments.ts";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { holdBufferedInput } from "../conversations/judgment-buffer.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../testing/spec-pins.ts";
import {
  createPostgresM1JudgmentStore,
  createPostgresSummaryFoldStore,
} from "./m1-judgments.ts";
import { createPostgresSlackSourceMarkStore } from "./slack-source-marks.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// No notice is published yet; one is put in so the gate can open.
const VERSIONS: readonly SlackNoticeVersionEntry[] = [
  {
    version: slackNoticeVersionSchema.parse(1),
    text: {
      ko: {
        body: ["k"],
        policyLink: { label: "l", href: "https://example.invalid" },
      },
      ja: {
        body: ["j"],
        policyLink: { label: "l", href: "https://example.invalid" },
      },
    },
    requiresReapproval: true,
  },
];

const MODEL = "claude-haiku-4-5";
const CONNECTION = "conn-fold";
const catalog = {
  connections: {
    [CONNECTION]: {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;

const FOLDED = "people talked about the release and the broken build";
const USED: ProviderUsage = {
  model: MODEL,
  inputTokens: 1_800,
  outputTokens: 40,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: false,
};

integration("channel summary folds (a1/J10)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const TEAM = "T0FOLD";
  let channelSeq = 0;
  let appSeq = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "summary_folds" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema }) as unknown as Database;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  type Agent = {
    agentId: string;
    teamId: string;
    releaseId: string;
    installationId: string;
  };

  /** An agent heard in shadow, approved, on a team with or without a limit. */
  async function newAgent(limited = true): Promise<Agent> {
    const agentId = randomUUID();
    const teamId = randomUUID();
    await pool.query(
      "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, $3)",
      [teamId, workspaceId, `team-${teamId.slice(0, 8)}`],
    );
    if (limited) {
      await saveBudgetLimit(
        db,
        workspaceId,
        { kind: "team", teamId },
        { costUsd: null, tokens: 10_000_000 },
      );
    }
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) VALUES ($1, $2, $3, $4, 'folder', 'active', 'shadow')",
      [agentId, workspaceId, teamId, `folder-${agentId.slice(0, 8)}`],
    );
    const versionId = randomUUID();
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    const releaseId = `rel-${randomUUID()}`;
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         repository_id, runtime_config_snapshot, effective_tools, policy_pins,
         ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', '{}', ${releaseSpecSqlValues()})`,
      [releaseId, agentId, versionId, "a".repeat(64)],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    const installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, $4)",
      [installationId, workspaceId, `A0FOLD${++appSeq}`, TEAM],
    );
    await pool.query(
      `INSERT INTO agent_identities
         (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
       VALUES ($1, $2, $3, 'slack_bot', $4, $5, $6)`,
      [
        randomUUID(),
        workspaceId,
        agentId,
        installationId,
        `U0BOT${appSeq}`,
        `slack/bot-fold-${appSeq}`,
      ],
    );
    await pool.query(
      `INSERT INTO slack_notice_approvals (id, workspace_id, agent_id, slack_team_id, notice_version, approved_by)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [randomUUID(), workspaceId, agentId, TEAM, randomUUID()],
    );
    return { agentId, teamId, releaseId, installationId };
  }

  type Channel = {
    channelId: string;
    conversationId: ConversationId;
    topicId: ConversationTopicId;
  };

  async function channelOf(agent: Agent): Promise<Channel> {
    const channelId = `C${String(++channelSeq).padStart(6, "0")}`;
    await pool.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
        installation_id, external_surface_id, surface_kind, mode, listen,
        ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
        '{}', 'full', 'ready')`,
      [
        randomUUID(),
        workspaceId,
        agent.agentId,
        agent.installationId,
        channelId,
      ],
    );
    const store = createPostgresConversationStore(db);
    const conversation = await store.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId: agent.agentId,
      teamId: TEAM,
      channelId,
    });
    const topic = await store.findOrCreateThreadTopic(conversation.id, {
      teamId: TEAM,
      channelId,
      threadTs: "100.000100",
    });
    return {
      channelId,
      conversationId: conversation.id,
      topicId: topic.id as ConversationTopicId,
    };
  }

  const placeOf = (channel: Channel) => ({
    workspaceId,
    teamId: TEAM,
    channelId: channel.channelId,
  });

  let tsSeq = 0;
  /** A buffered message of the agent's, to be a line's source. */
  async function message(agent: Agent, channel: Channel) {
    const ts = `300.${String(++tsSeq).padStart(6, "0")}`;
    await db.transaction((tx) =>
      holdBufferedInput(
        tx,
        { workspaceId, agentId: agent.agentId, teamId: TEAM },
        {
          topicId: channel.topicId,
          channelId: channel.channelId,
          ts,
          buffered: { body: `message ${ts}`, slackUserId: "U0PERSON" },
        },
        JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
      ),
    );
    const { rows } = await pool.query<{ id: ConversationInputId }>(
      "SELECT id FROM conversation_inputs WHERE slack_channel_id = $1 AND slack_ts = $2",
      [channel.channelId, ts],
    );
    const inputId = rows[0]?.id;
    if (inputId === undefined) throw new Error("not held");
    return { inputId, ts };
  }

  const summaries = () => createPostgresChannelSummaryStore(db);

  /** Adds one line of `bytes` ASCII bytes from a message of its own. */
  async function addLine(
    agent: Agent,
    channel: Channel,
    text: string,
  ): Promise<{ ts: string }> {
    const source = await message(agent, channel);
    const version = (await summaries().read(placeOf(channel)))?.version ?? 0;
    const written = await summaries().append({
      place: placeOf(channel),
      agentId: agent.agentId,
      expectedVersion: version,
      lines: [
        {
          text,
          sources: [
            {
              inputId: source.inputId,
              slack: {
                teamId: TEAM,
                channelId: channel.channelId,
                ts: source.ts,
              },
            },
          ],
        },
      ],
    });
    if (written.outcome !== "written") throw new Error(written.outcome);
    return source;
  }

  /** Six lines of 1,000 bytes: past the cap, four to fold. */
  async function longSummary(agent: Agent, channel: Channel) {
    const sources: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      sources.push((await addLine(agent, channel, String(i).repeat(1_000))).ts);
    }
    return sources;
  }

  /**
   * The folder as control-host wires it. Its transport stands in for the
   * egress proxy and the model: it grants the call's token, waits on
   * `during` as the model runs, then settles what the call used.
   */
  function folderOf(options: { during?: () => Promise<void> } = {}) {
    let calls = 0;
    const http: OutboundHttp = async (request) => {
      calls += 1;
      const ledger = createPostgresConversationCalls(db);
      const exchangeId = randomUUID();
      const granted = await ledger.authorizeAtomic({
        tokenHash: hashConversationCallToken(
          request.headers?.["x-api-key"] ?? "",
        ),
        exchangeId,
      });
      if (granted.outcome !== "ok") throw new Error(granted.outcome);
      await options.during?.();
      const settled = await ledger.settleAtomic({
        callId: granted.callId,
        exchangeId,
        usage: USED,
        priceFor: () => ({ costUsd: 0.001 }),
      });
      if (settled.outcome !== "settled") throw new Error(settled.outcome);
      return {
        status: 200,
        headers: new Headers(),
        text: JSON.stringify({
          content: [
            { type: "text", text: JSON.stringify({ summary: FOLDED }) },
          ],
        }),
      };
    };
    const executor = createConversationCallExecutor({
      calls: createConversationCalls({
        store: createPostgresConversationCalls(db),
        catalog,
      }),
      egressUrl: "http://egress-proxy.invalid:3129",
      http,
      logger: { warn: () => {} },
    });
    const gates = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
    const folder = createSummaryFolder({
      gate: (subject) => gates.gateOpen(subject),
      release: async (subject) => {
        const { rows } = await pool.query<{ active_release_id: string }>(
          "SELECT active_release_id FROM agents WHERE id = $1",
          [subject.agentId],
        );
        return {
          outcome: "ready",
          releaseId: rows[0]?.active_release_id ?? "",
          connectionId: CONNECTION,
          model: MODEL,
          instructions: "",
        };
      },
      context: createPostgresSummaryFoldContexts(db),
      store: createPostgresSummaryFoldStore(db, { versions: VERSIONS }),
      executor,
    });
    return { folder, calls: () => calls };
  }

  const subjectOf = (agent: Agent, channel: Channel) => ({
    workspaceId,
    agentId: agent.agentId,
    conversationId: channel.conversationId,
    teamId: TEAM,
    channelId: channel.channelId,
  });

  const texts = async (channel: Channel, version?: number) =>
    (await summaries().read(placeOf(channel), version))?.lines.map(
      (line) => line.text,
    );

  const callsOf = async (agent: Agent) =>
    (
      await pool.query(
        `SELECT c.call_class, c.root_kind, a.owner_kind, a.owner_id,
           r.state AS reservation, r.settled_tokens::int AS settled_tokens
         FROM conversation_calls c
         LEFT JOIN budget_reservations r ON r.call_id = c.id::text
         LEFT JOIN budget_accounts a ON a.id = r.account_id
         WHERE c.agent_id = $1`,
        [agent.agentId],
      )
    ).rows;

  const markDeleted = (channel: Channel, ts: string) =>
    createPostgresSlackSourceMarkStore(db).markDeleted({
      workspaceId,
      teamId: TEAM,
      channelId: channel.channelId,
      ts,
      at: new Date(),
    });

  test("a summary past 1.5k is folded in one call: fewer lines, a version up, the old one kept", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    await longSummary(agent, channel);
    const before = await summaries().read(placeOf(channel));
    const run = folderOf();
    expect(await run.folder.fold(subjectOf(agent, channel))).toBe("written");
    expect(run.calls()).toBe(1);
    const after = await summaries().read(placeOf(channel));
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    // The folded line stands first, the two newest lines after it.
    expect(after?.lines.map((line) => line.text)).toEqual([
      FOLDED,
      "4".repeat(1_000),
      "5".repeat(1_000),
    ]);
    expect(await texts(channel, before?.version)).toEqual(
      before?.lines.map((line) => line.text),
    );
    // The ledger's row: a summary call, nobody's request, on the agent's team.
    expect(await callsOf(agent)).toEqual([
      {
        call_class: "summary",
        root_kind: "none",
        owner_kind: "team",
        owner_id: agent.teamId,
        reservation: "settled",
        settled_tokens: expect.any(Number),
      },
    ]);
    expect((await callsOf(agent))[0]?.settled_tokens).toBeGreaterThan(0);
  });

  test("the folded line's sources are all the folded lines'; one deleted takes it out of every version", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    const sources = await longSummary(agent, channel);
    const before = (await summaries().read(placeOf(channel)))?.version ?? 0;
    expect(await folderOf().folder.fold(subjectOf(agent, channel))).toBe(
      "written",
    );
    const folded = (await summaries().read(placeOf(channel)))?.lines[0];
    expect(folded?.sources.map((source) => source.ts).sort()).toEqual(
      sources.slice(0, 4).sort(),
    );
    expect(folded?.sources.every((s) => s.speaker.kind !== "unknown")).toBe(
      true,
    );
    await markDeleted(channel, sources[1] as string);
    expect(await texts(channel)).toEqual([
      "4".repeat(1_000),
      "5".repeat(1_000),
    ]);
    // From history too: the version the fold made holds no folded line now.
    expect(await texts(channel, before + 1)).toEqual([
      "4".repeat(1_000),
      "5".repeat(1_000),
    ]);
  });

  test("two folds of one channel at once: one call, one fold", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    await longSummary(agent, channel);
    const one = folderOf();
    const two = folderOf();
    const outcomes = await Promise.all([
      one.folder.fold(subjectOf(agent, channel)),
      two.folder.fold(subjectOf(agent, channel)),
    ]);
    expect(outcomes.sort()).toEqual(["busy", "written"]);
    expect(one.calls() + two.calls()).toBe(1);
    expect((await callsOf(agent)).length).toBe(1);
  });

  test("a line added while it folds stays", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    await longSummary(agent, channel);
    const run = folderOf({
      during: async () => {
        await addLine(agent, channel, "a line added meanwhile");
      },
    });
    expect(await run.folder.fold(subjectOf(agent, channel))).toBe("written");
    expect(await texts(channel)).toEqual([
      FOLDED,
      "4".repeat(1_000),
      "5".repeat(1_000),
      "a line added meanwhile",
    ]);
  });

  test("a source deleted while it folds: the folded result is not written", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    const sources = await longSummary(agent, channel);
    const run = folderOf({
      during: async () => {
        await markDeleted(channel, sources[0] as string);
      },
    });
    expect(await run.folder.fold(subjectOf(agent, channel))).toBe("dropped");
    expect((await texts(channel))?.includes(FOLDED)).toBe(false);
    expect(await texts(channel)).toEqual(
      [1, 2, 3, 4, 5].map((i) => String(i).repeat(1_000)),
    );
  });

  for (const [what, lower] of [
    [
      "the switch lowered",
      (agent: Agent) =>
        pool.query(
          "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
          [agent.agentId],
        ),
    ],
    [
      "the approval revoked",
      (agent: Agent) =>
        pool.query(
          "UPDATE slack_notice_approvals SET revoked_at = now(), revoked_by = $2 WHERE agent_id = $1",
          [agent.agentId, randomUUID()],
        ),
    ],
  ] as const) {
    test(`${what} while it folds: the folded result is not written`, async () => {
      const agent = await newAgent();
      const channel = await channelOf(agent);
      await longSummary(agent, channel);
      const before = await texts(channel);
      const run = folderOf({
        during: async () => {
          await lower(agent);
        },
      });
      expect(await run.folder.fold(subjectOf(agent, channel))).toBe(
        "gate_closed",
      );
      expect(run.calls()).toBe(1);
      expect(await texts(channel)).toEqual(before);
      // The call was reserved, and is settled at what it used.
      expect(await callsOf(agent)).toMatchObject([
        { call_class: "summary", reservation: "settled" },
      ]);
    });

    test(`${what} before it starts: no model call, no reservation`, async () => {
      const agent = await newAgent();
      const channel = await channelOf(agent);
      await longSummary(agent, channel);
      await lower(agent);
      const run = folderOf();
      expect(await run.folder.fold(subjectOf(agent, channel))).toBe(
        "gate_closed",
      );
      expect(run.calls()).toBe(0);
      expect(await callsOf(agent)).toEqual([]);
    });
  }

  test("a team with no limit: no fold, the summary as it was", async () => {
    const agent = await newAgent(false);
    const channel = await channelOf(agent);
    await longSummary(agent, channel);
    const before = await texts(channel);
    const run = folderOf();
    expect(await run.folder.fold(subjectOf(agent, channel))).toBe("not_called");
    expect(run.calls()).toBe(0);
    expect(await texts(channel)).toEqual(before);
  });

  test("a fold holds the channel until released, and none starts again within its interval", async () => {
    const agent = await newAgent();
    const channel = await channelOf(agent);
    await addLine(agent, channel, "one line");
    const place = placeOf(channel);
    const claim = (intervalMs: number) =>
      claimChannelSummaryFold(db, place, { leaseMs: 60_000, intervalMs });
    expect(await claim(600_000)).toBe(true);
    // Held: not even with no interval.
    expect(await claim(0)).toBe(false);
    await releaseChannelSummaryFold(db, place);
    // Let go, but one started within the interval.
    expect(await claim(600_000)).toBe(false);
    expect(await claim(0)).toBe(true);
    // A channel with no summary has nothing to fold.
    expect(
      await claimChannelSummaryFold(
        db,
        { ...place, channelId: "C0NONE" },
        { leaseMs: 60_000, intervalMs: 0 },
      ),
    ).toBe(false);
  });
});
