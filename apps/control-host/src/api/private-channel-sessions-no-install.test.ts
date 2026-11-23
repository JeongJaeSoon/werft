import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listSessionsResponseSchema,
} from "@werft-ai/contracts";
import type { Database } from "@werft-ai/db";
import * as schema from "@werft-ai/db";
import {
  channelSessionPlaces,
  createDatabaseAgentAuthority,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  createPostgresSurfaceBindingStore,
} from "@werft-ai/db";
import { makeFixtureRelease, TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { StructuredLogger } from "@werft-ai/observability";
import {
  authenticatedIdentity,
  type ChannelMemberCheckable,
  createAuthorizationPolicy,
  createSessionService,
  type IdentityReader,
  type SecretKey,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { testCatalog } from "../testing/catalog.ts";
import { sessionReleases } from "../testing/releases.ts";
import { fakeWebSessions } from "../testing/web-session.ts";
import { createApiApp } from "./app.ts";
import { hashApiKey } from "./keys.ts";
import {
  PRIVATE_CHANNEL_SESSIONS_EXIT,
  type PrivateChannelSlack,
  runPrivateChannelSessions,
} from "./private-channel-sessions.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";

// An agent whose Slack app is not installed (SLACK_NOT_INSTALLED) cannot be
// asked what its channels are now. Its channels are no_install: counted on
// their own, not a reason to stop. They narrow by what their binding says
// (a kind no binding knows counts as private) and never widen.

let client: PGlite;
let db: Database;
const workspaceId = randomUUID();
const creator = randomUUID();
const named = randomUUID();
let agentId = "";
const ids = { g1: "", p1: "", n1: "", n1b: "", n2: "", n3: "" };

// G1 and P1 are read from Slack; N1, N2 and N3 belong to no install.
const notInstalled: PrivateChannelSlack = {
  kindOf: async (place) =>
    place.channelId === "G1"
      ? { kind: "private_channel" }
      : place.channelId === "P1"
        ? { kind: "public_channel" }
        : { unconfirmed: "SLACK_NOT_INSTALLED" },
  memberIds: async () => [],
};

async function run(argv: string[], slack: PrivateChannelSlack = notInstalled) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await runPrivateChannelSessions(argv, {
    env: { DATABASE_URL: "postgres://unused.invalid/db" },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    loadKey: async () => ({}) as SecretKey,
    openDatabase: async () => ({ db, close: async () => {} }),
    openSlack: () => slack,
  });
  expect(out).toHaveLength(1);
  return { exit, err, line: JSON.parse(out[0] as string) };
}

const scopes = async () =>
  Object.fromEntries(
    (
      await client.query<{ session_id: string; scope: string }>(
        "SELECT session_id, scope FROM session_shares WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows.map((row) => [row.session_id, row.scope]),
  );

beforeAll(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  const releaseId = await makeFixtureRelease(db, {
    workspaceId,
    model: TEST_MODEL,
  });
  agentId = (
    await client.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_releases WHERE id = $1",
      [releaseId],
    )
  ).rows[0]?.agent_id as string;
  for (const user of [creator, named]) {
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [user, `${user}@example.invalid`],
    );
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, user],
    );
  }
  const installationId = randomUUID();
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, 'T1')",
    [installationId, workspaceId, `A${installationId.slice(0, 8)}`],
  );
  // N3's link names a binding of another channel id: no binding knows N3.
  const bindings: Record<string, string> = {};
  for (const [channel, bound, kind] of [
    ["G1", "G1", "private_channel"],
    ["P1", "P1", "public_channel"],
    ["N1", "N1", "private_channel"],
    ["N2", "N2", "public_channel"],
    ["N3", "X9", "private_channel"],
  ] as const) {
    bindings[channel] = randomUUID();
    await client.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
         external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', '{}', 'full', 'ready')`,
      [bindings[channel], workspaceId, agentId, installationId, bound, kind],
    );
  }
  // A Slack session hangs off its channel's conversation: the door reads it.
  const parents: Record<string, string> = {};
  for (const channel of Object.keys(bindings)) {
    parents[channel] = randomUUID();
    await client.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T1', $3)",
      [randomUUID(), workspaceId, channel],
    );
    await client.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', 'T1', $4)",
      [parents[channel], workspaceId, agentId, channel],
    );
  }
  let n = 0;
  const session = async (channel: string) => {
    const parent = parents[channel];
    const id = randomUUID();
    n += 1;
    await client.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id, parent_conversation_id)
       VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid, $4, $5)`,
      [id, workspaceId, `session/${id}`, creator, parent],
    );
    await client.query(
      `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
         surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id)
       VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
      [
        randomUUID(),
        workspaceId,
        id,
        installationId,
        bindings[channel],
        `${channel}:${n}.1`,
        channel,
        `${n}.1`,
        agentId,
        releaseId,
      ],
    );
    return id;
  };
  ids.g1 = await session("G1");
  ids.p1 = await session("P1");
  ids.n1 = await session("N1");
  ids.n1b = await session("N1");
  ids.n2 = await session("N2");
  ids.n3 = await session("N3");
  await client.query(
    "INSERT INTO session_shares (session_id, owner_id, workspace_id, scope) VALUES ($1, $2::text, $2::uuid, 'people')",
    [ids.n1, workspaceId],
  );
  await client.query(
    "INSERT INTO session_share_targets (id, workspace_id, session_id, user_id) VALUES ($1, $2, $3, $4)",
    [randomUUID(), workspaceId, ids.n1, named],
  );
  // Already private_channel: a public binding must not widen it unasked.
  await client.query(
    "INSERT INTO session_shares (session_id, owner_id, workspace_id, scope) VALUES ($1, $2::text, $2::uuid, 'private_channel')",
    [ids.n2, workspaceId],
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("private-channel-sessions with an agent that has no install", () => {
  test("plan counts no_install channels apart and exits 0", async () => {
    const before = await scopes();
    const { exit, err, line } = await run(["plan", "--agent", agentId]);
    expect(err).toEqual([]);
    expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.ok);
    expect(line.unconfirmed_channels).toEqual([]);
    expect(
      (line.sessions as { session_id: string }[]).map((row) => row.session_id),
    ).toEqual([ids.g1]);
    expect(line.no_install).toEqual({
      channel_count: 3,
      session_count: 3,
      kind_unknown_as_private: 1,
      people_losing: "unconfirmed_no_install",
      channels: [
        {
          agent_id: agentId,
          channel_id: "N1",
          binding_kind: "private_channel",
          treated_as: "private_channel",
          sessions: 2,
        },
        {
          agent_id: agentId,
          channel_id: "N2",
          binding_kind: "public_channel",
          treated_as: "unchanged",
          sessions: 0,
        },
        {
          agent_id: agentId,
          channel_id: "N3",
          binding_kind: "unknown",
          treated_as: "private_channel",
          sessions: 1,
        },
      ],
      sessions: expect.arrayContaining([
        expect.objectContaining({
          session_id: ids.n1,
          channel_id: "N1",
          from: "people",
          to: "private_channel",
        }),
        expect.objectContaining({ session_id: ids.n1b, from: "workspace" }),
        expect.objectContaining({ session_id: ids.n3, channel_id: "N3" }),
      ]),
    });
    expect(await scopes()).toEqual(before);
  });

  test("any other unread channel still exits 3, beside the no_install ones", async () => {
    const { exit, line } = await run(["plan", "--agent", agentId], {
      ...notInstalled,
      kindOf: async (place) =>
        place.channelId === "G1"
          ? { unconfirmed: "BACKEND_UNAVAILABLE" }
          : notInstalled.kindOf(place),
    });
    expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.incomplete);
    expect(line.unconfirmed_channels).toEqual([
      { agent_id: agentId, channel_id: "G1", reason: "BACKEND_UNAVAILABLE" },
    ]);
    expect(line.no_install.channel_count).toBe(3);
  });

  test("the move reads a binding's kind inside, under its lock", async () => {
    const store = createPostgresSurfaceBindingStore(db);
    const read: Record<string, unknown> = {};
    for (const place of await channelSessionPlaces(db, { agentId })) {
      const changed = await store.channelKindChanged(place, async (inside) => {
        read[place.channelId] = await inside.bindingKind();
        return null;
      });
      expect(changed).toBeNull();
    }
    expect(read).toEqual({
      G1: "private_channel",
      P1: "public_channel",
      N1: "private_channel",
      N2: "public_channel",
      N3: null,
    });
  });

  test("apply moves no_install channels like the others, never widening", async () => {
    const first = await run(["apply", "--agent", agentId]);
    expect(first.err).toEqual([]);
    expect(first.exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.ok);
    expect(first.line.outcome).toBe("moved");
    expect(
      (first.line.moved as { session_id: string }[])
        .map((row) => row.session_id)
        .sort(),
    ).toEqual([ids.g1, ids.n1, ids.n1b, ids.n3].sort());
    expect(first.line.no_install).toMatchObject({
      channel_count: 3,
      session_count: 3,
      kind_unknown_as_private: 1,
    });
    expect(await scopes()).toEqual({
      [ids.g1]: "private_channel",
      [ids.n1]: "private_channel",
      [ids.n1b]: "private_channel",
      [ids.n2]: "private_channel",
      [ids.n3]: "private_channel",
    });
    // Each moved session's receipt says whether Slack or its binding decided.
    const marks = await client.query<{
      session_id: string;
      no_install: boolean;
      people_losing: number | null;
    }>(
      `SELECT target_ref->>'session_id' AS session_id,
         (result->>'no_install')::boolean AS no_install,
         (result->>'people_losing')::int AS people_losing
       FROM receipts WHERE operation = 'share_session' AND result->>'run_id' = $1`,
      [first.line.run_id],
    );
    expect(
      Object.fromEntries(
        marks.rows.map((row) => [
          row.session_id,
          [row.no_install, row.people_losing],
        ]),
      ),
    ).toEqual({
      // G1's binding was private already: the door hid it from non-members.
      [ids.g1]: [false, 0],
      [ids.n1]: [true, null],
      [ids.n1b]: [true, null],
      [ids.n3]: [true, null],
    });
    const second = await run(["apply", "--agent", agentId]);
    expect(second.exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.ok);
    expect(second.line.outcome).toBe("unchanged");
    expect(second.line.moved).toEqual([]);
  });
});

// After apply, nobody passes the door of a channel whose members cannot be
// read: not the person over the web console, not their own key. P1's
// session is the control that the same callers see what is open to them.
describe("after apply, over HTTP", () => {
  const KEY = `csp_${randomUUID()}`;
  const noInstall: ChannelMemberCheckable = {
    isMember: async () => false,
    membership: async () => "unconfirmed",
  };
  const reinstalled: ChannelMemberCheckable = {
    isMember: async () => true,
    membership: async () => "member",
  };

  function api(channelMembers: ChannelMemberCheckable) {
    const web = fakeWebSessions(workspaceId);
    // The web session and the key live only here; who they are is real rows.
    const identity: IdentityReader = {
      async reread(subject) {
        const { principal } = subject;
        return principal.kind === "api_key"
          ? {
              status: "ok",
              principal,
              keyCreator: { userId: creator, role: "member" },
            }
          : authenticatedIdentity.reread(subject);
      },
    };
    const authorization = createAuthorizationPolicy({
      identity,
      agents: createDatabaseAgentAuthority(db),
      sessions: createPostgresSessionShareStore(db),
      channelMembers,
    });
    const catalog = testCatalog();
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
      releases: sessionReleases(db, catalog),
    });
    const app = createApiApp({
      authMode: "api-key",
      logger: new StructuredLogger({ sinks: [] }),
      identity: web.identity,
      authorization,
      keyStore: {
        async find(hash: Uint8Array) {
          if (!Buffer.from(hash).equals(Buffer.from(hashApiKey(KEY)))) {
            return null;
          }
          return {
            id: randomUUID(),
            ownerId: workspaceId,
            workspaceId,
            kind: "personal" as const,
            agentId: null,
            createdByUserId: creator,
            creatorRole: "member" as const,
            scopes: ["sessions:read" as const],
          };
        },
      },
      registerRoutes: (router) => registerSessionRoutes(router, service),
    });
    const as = {
      web: (userId: string) => ({
        Cookie: web.cookieFor("member", { userId }),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      }),
      key: () => ({ Authorization: `Bearer ${KEY}` }),
    };
    return { app, as };
  }

  async function reach(
    app: ReturnType<typeof api>["app"],
    headers: Record<string, string>,
  ) {
    const listed = await app.request("/v1/sessions", { headers });
    expect(listed.status).toBe(200);
    const list = new Set(
      listSessionsResponseSchema
        .parse(await listed.json())
        .items.map((item) => item.id),
    );
    const out: Record<string, string> = {};
    for (const [name, id] of Object.entries(ids)) {
      const detail = await app.request(`/v1/sessions/${id}`, { headers });
      out[name] = `${detail.status} ${list.has(id) ? "listed" : "unlisted"}`;
    }
    return out;
  }

  const hidden = "404 unlisted";
  test("no_install sessions are hidden from the person's web session and key", async () => {
    const { app, as } = api(noInstall);
    for (const headers of [as.web(creator), as.web(named), as.key()]) {
      expect(await reach(app, headers)).toEqual({
        g1: hidden,
        p1: "200 listed",
        n1: hidden,
        n1b: hidden,
        n2: hidden,
        n3: hidden,
      });
    }
  });

  test("once members can be read again, the web sees them and the key still does not", async () => {
    const { app, as } = api(reinstalled);
    expect(await reach(app, as.web(creator))).toMatchObject({
      n1: "200 listed",
      n1b: "200 listed",
      n3: "200 listed",
    });
    expect(await reach(app, as.key())).toMatchObject({
      n1: hidden,
      n1b: hidden,
      n3: hidden,
    });
  });
});
