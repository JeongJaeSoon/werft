import { parseArgs } from "node:util";
import {
  SLACK_CHANNEL_MEMBER_LIMIT,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  type ChannelSessionRow,
  channelSessionPlaces,
  createDatabaseAgentAuthority,
  createPostgresChannelMemberStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSurfaceBindingStore,
  type Database,
  memberships,
  readChannelScopePlan,
  sessions,
  sessionVisibleTo,
  users,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import type {
  ChannelKindNow,
  ChannelSessionPlace,
  SecretKey,
} from "@werft-ai/platform";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  agentSlackBotToken,
  createSlackBotApi,
  createSlackChannelKinds,
} from "../wiring/chat-slack.ts";
import {
  loadSecretKey,
  MasterKeyError,
  masterKeyConfigured,
} from "./catalog-config.ts";
import { slackApiUrlFrom } from "./slack-config.ts";

// Answer 15 (94S-2001): sessions from before private channel sessions were
// private_channel are moved by the operator, after a plan shows who loses
// them.

/** Part of the CLI contract: the docs and the verify skill branch on these. */
export const PRIVATE_CHANNEL_SESSIONS_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  /** Some channel's kind could not be read, or some session was not moved. */
  incomplete: 3,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/private-channel-sessions.ts plan [--workspace <workspace_id> | --agent <agent_id>]
       bun run apps/control-host/src/api/private-channel-sessions.ts apply [--workspace <workspace_id> | --agent <agent_id>]
  plan   asks Slack what each channel with linked sessions is now and prints, per session that
         would move, how many members would stop seeing it (people_losing) and how many of its
         turns an API key asked for (key_turns). It changes nothing.
  apply  moves them: a private channel's sessions to private_channel (a session its creator
         made private stays private), a public channel's private_channel ones back to workspace,
         and a binding left of the other kind follows (one turned private waits for approval).
         Running it again changes nothing more.
  Without --workspace or --agent, every workspace.
Environment: DATABASE_URL and PLATFORM_SECRET_KEY, or PLATFORM_SECRET_KEY_FILE naming a file that holds it (required)
Test only:   MOCK_SLACK_API_URL (default https://slack.com/api; for the mock Slack stack)
Output: one line of JSON on stdout, ids and counts only.
Exit codes: 0 done (also when nothing had to change); 1 unexpected error; 2 usage;
            3 incomplete: a channel's kind could not be read (unconfirmed_channels) or a session
              was not moved (skipped); those are left as they were, run it again after fixing them`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrivateChannelSessionsUsageError extends Error {}

export type PrivateChannelSessionsCommand = {
  command: "plan" | "apply";
  filter: { workspaceId?: string; agentId?: string };
};

export function parsePrivateChannelSessionsCommand(
  argv: string[],
): PrivateChannelSessionsCommand {
  const usage = (message?: string) =>
    new PrivateChannelSessionsUsageError(
      message ? `${message}\n${USAGE}` : USAGE,
    );
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length > 0 || (command !== "plan" && command !== "apply")) {
    throw usage();
  }
  const { workspace, agent } = parsed.values;
  if (workspace !== undefined && agent !== undefined) {
    throw usage("give at most one of --workspace and --agent");
  }
  for (const [name, value] of [
    ["--workspace", workspace],
    ["--agent", agent],
  ] as const) {
    if (value !== undefined && !UUID.test(value)) {
      throw usage(`${name} must be a UUID`);
    }
  }
  return {
    command,
    filter: {
      ...(workspace === undefined
        ? {}
        : { workspaceId: workspace.toLowerCase() }),
      ...(agent === undefined ? {} : { agentId: agent.toLowerCase() }),
    },
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      workspace: { type: "string" },
      agent: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/** What the command asks Slack, with the agent's own bot token. */
export type PrivateChannelSlack = {
  /** The channel's kind now; a reason when it cannot be told. */
  kindOf(
    place: ChannelSessionPlace,
  ): Promise<{ kind: ChannelKindNow } | { unconfirmed: string }>;
  /** Every member's Slack id; null when the list cannot be read whole. */
  memberIds(place: ChannelSessionPlace): Promise<readonly string[] | null>;
};

export type PrivateChannelSessionsIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  loadKey: (
    env: Record<string, string | undefined>,
  ) => Promise<SecretKey | null>;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
  openSlack?: (db: Database, key: SecretKey) => PrivateChannelSlack;
};

/** The Slack the command asks in production: the agent's own app. */
export function slackOfAgents(
  db: Database,
  key: SecretKey,
  apiUrl: string,
): PrivateChannelSlack {
  const apps = createPostgresSlackAppStore(db, key);
  const secrets = createPostgresSecretStore(db, key);
  const api = createSlackBotApi({ apiUrl });
  const kinds = createSlackChannelKinds({ apps, secrets, slack: api });
  return {
    async kindOf(place) {
      try {
        const kind = await kinds.kindOf(
          place.workspaceId,
          place.agentId,
          place.channelId,
        );
        return kind === "dm" ? { unconfirmed: "dm" } : { kind };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { unconfirmed: typeof code === "string" ? code : "failed" };
      }
    },
    async memberIds(place) {
      try {
        const token = await agentSlackBotToken(
          { apps, secrets },
          place.workspaceId,
          place.agentId,
        );
        if (token === null) return null;
        const members = new Set<string>();
        let cursor: string | null = null;
        do {
          const page = await api.channelMembers(token, {
            channelId: place.channelId,
            cursor,
          });
          for (const id of page.memberIds) members.add(id);
          if (members.size > SLACK_CHANNEL_MEMBER_LIMIT) return null;
          cursor = page.nextCursor;
        } while (cursor !== null);
        return [...members];
      } catch {
        return null;
      }
    },
  };
}

type PlannedSession = {
  session_id: string;
  agent_id: string;
  channel_id: string;
  from: string;
  to: string;
  people_losing: number;
  key_turns: number;
  members_unconfirmed: boolean;
};

// Who sees a session now (the one predicate every read uses) and who still
// would once it is private_channel: a member who may use the agent, with a
// live Slack link, in the channel now. A list that cannot be read keeps no
// one, as the policy hides what it cannot confirm.
async function peopleLosing(
  db: Database,
  place: ChannelSessionPlace,
  sessionIds: readonly string[],
  slack: PrivateChannelSlack,
): Promise<{ losing: Map<string, number>; unconfirmed: boolean }> {
  const losing = new Map(sessionIds.map((id) => [id, 0]));
  if (sessionIds.length === 0) return { losing, unconfirmed: false };
  const memberIds = await slack.memberIds(place);
  const authority = createDatabaseAgentAuthority(db);
  const subjects = createPostgresChannelMemberStore(db);
  const people = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, place.workspaceId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    );
  for (const person of people) {
    const seen = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.id, [...sessionIds]),
          sessionVisibleTo(db, { userId: person.userId, apiKeyId: null }),
        ),
      );
    if (seen.length === 0) continue;
    const usage = await authority.usageOf?.(place.workspaceId, place.agentId, {
      userId: person.userId,
      role: person.role as WorkspaceRole,
      keyAgentId: null,
    });
    const subject = await subjects.subject({
      workspaceId: place.workspaceId,
      agentId: place.agentId,
      userId: person.userId,
    });
    const keeps =
      usage?.allowed === true &&
      subject !== null &&
      memberIds !== null &&
      memberIds.includes(subject.slackUserId);
    if (keeps) continue;
    for (const { id } of seen) losing.set(id, (losing.get(id) ?? 0) + 1);
  }
  return { losing, unconfirmed: memberIds === null };
}

async function run(
  command: PrivateChannelSessionsCommand,
  db: Database,
  slack: PrivateChannelSlack,
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const bindings = createPostgresSurfaceBindingStore(db);
  const places = await channelSessionPlaces(db, command.filter);
  const unconfirmedChannels: Record<string, string>[] = [];
  const skipped: Record<string, string>[] = [];
  const planned: PlannedSession[] = [];
  const moved: Record<string, string>[] = [];
  const bindingChanges: Record<string, string>[] = [];
  let keptPrivate = 0;
  let unchanged = 0;
  for (const place of places) {
    const ids = { agent_id: place.agentId, channel_id: place.channelId };
    const read = await slack.kindOf(place);
    if ("unconfirmed" in read) {
      unconfirmedChannels.push({ ...ids, reason: read.unconfirmed });
      continue;
    }
    if (command.command === "apply") {
      const changed = await bindings.channelKindChanged(place, read.kind);
      if (changed.binding !== "unchanged") {
        bindingChanges.push({ ...ids, binding: changed.binding });
      }
      for (const move of changed.moves) {
        moved.push({
          session_id: move.sessionId,
          ...ids,
          from: move.from,
          to: move.to,
        });
      }
      for (const skip of changed.skipped) {
        skipped.push({
          session_id: skip.sessionId,
          ...ids,
          reason: skip.reason,
        });
      }
      keptPrivate += changed.keptPrivate.length;
      unchanged += changed.unchanged.length;
      continue;
    }
    const { rows, plan } = await readChannelScopePlan(db, place, read.kind);
    const live = await bindings.findLiveSlackChannel(
      place.installationId,
      place.channelId,
    );
    if (
      live !== null &&
      live.channelKind !== "dm" &&
      live.channelKind !== read.kind &&
      live.status !== "left"
    ) {
      bindingChanges.push({
        ...ids,
        binding: read.kind === "private_channel" ? "now_private" : "now_public",
      });
    }
    const narrowing = plan.moves
      .filter((move) => move.to === "private_channel")
      .map((move) => move.sessionId);
    const { losing, unconfirmed } = await peopleLosing(
      db,
      place,
      narrowing,
      slack,
    );
    const rowOf = new Map<string, ChannelSessionRow>(
      rows.map((row) => [row.sessionId, row]),
    );
    for (const move of plan.moves) {
      planned.push({
        session_id: move.sessionId,
        ...ids,
        from: move.from,
        to: move.to,
        people_losing: losing.get(move.sessionId) ?? 0,
        key_turns:
          move.to === "private_channel"
            ? (rowOf.get(move.sessionId)?.keyTurns ?? 0)
            : 0,
        members_unconfirmed: move.to === "private_channel" && unconfirmed,
      });
    }
    for (const skip of plan.skipped) {
      skipped.push({ session_id: skip.sessionId, ...ids, reason: skip.reason });
    }
    keptPrivate += plan.keptPrivate.length;
    unchanged += plan.unchanged.length;
  }
  const incomplete = unconfirmedChannels.length > 0 || skipped.length > 0;
  return {
    exit: incomplete
      ? PRIVATE_CHANNEL_SESSIONS_EXIT.incomplete
      : PRIVATE_CHANNEL_SESSIONS_EXIT.ok,
    line: {
      outcome:
        command.command === "plan"
          ? "planned"
          : incomplete
            ? "incomplete"
            : "moved",
      channels: places.length,
      ...(command.command === "plan" ? { sessions: planned } : { moved }),
      bindings: bindingChanges,
      kept_private: keptPrivate,
      unchanged,
      skipped,
      unconfirmed_channels: unconfirmedChannels,
    },
  };
}

/** Returns the exit code. Nothing it writes carries a secret. */
export async function runPrivateChannelSessions(
  argv: string[],
  io: PrivateChannelSessionsIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`private-channel-sessions: ${message}`);
    return code;
  };
  try {
    const command = parsePrivateChannelSessionsCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(
        PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
        "DATABASE_URL is required",
      );
    }
    const key = await io.loadKey(io.env);
    if (key === null) {
      return fail(
        PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
        "master_key_missing: the master key is not set (PLATFORM_SECRET_KEY or PLATFORM_SECRET_KEY_FILE); Slack cannot be asked without the bot tokens",
      );
    }
    const database = await io.openDatabase(databaseUrl);
    try {
      const slack =
        io.openSlack?.(database.db, key) ??
        slackOfAgents(database.db, key, slackApiUrlFrom(io.env));
      const { exit, line } = await run(command, database.db, slack);
      io.out(JSON.stringify(line));
      return exit;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof PrivateChannelSessionsUsageError) {
      return fail(PRIVATE_CHANNEL_SESSIONS_EXIT.usage, error.message);
    }
    if (error instanceof MasterKeyError) {
      return fail(
        PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
        `${error.code}: ${error.message}`,
      );
    }
    return fail(
      PRIVATE_CHANNEL_SESSIONS_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runPrivateChannelSessions(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    loadKey: async (env) =>
      masterKeyConfigured(env) ? loadSecretKey(env) : null,
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "private-channel-sessions",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
