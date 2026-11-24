import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  SLACK_CHANNEL_MEMBER_LIMIT,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  type ChannelSessionRow,
  channelBindingKind,
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
import {
  type ChannelKindNow,
  type ChannelSessionPlace,
  SecretDecryptError,
  type SecretKey,
  type SecretStore,
  type SurfaceAppStore,
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
  MASTER_KEY_MISMATCH,
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
         Each session moved gets a share_session receipt (reason operator_private_channel_migration,
         people_losing, null for no_install) carrying the output's run_id, as the binding's receipt
         does; a failed receipt leaves its channel as it was. Running it again changes nothing more.
  A channel of an agent with no Slack install (SLACK_NOT_INSTALLED) is no_install: Slack cannot
  be asked, so its binding's kind is used. A private binding, or a channel no binding knows the
  kind of, narrows to private_channel; a public one is left as it is. Who would stop seeing them
  cannot be told (people_losing "unconfirmed_no_install"); it is not a reason to exit 3.
  Without --workspace or --agent, every workspace.
Environment: DATABASE_URL and PLATFORM_SECRET_KEY, or PLATFORM_SECRET_KEY_FILE naming a file that holds it (required)
Test only:   MOCK_SLACK_API_URL (default https://slack.com/api; for the mock Slack stack)
Output: one line of JSON on stdout, ids and counts only. outcome: planned (plan); moved when apply
        changed a session or a binding, unchanged when it changed nothing, incomplete with exit 3.
Exit codes: 0 done (also when nothing had to change); 1 unexpected error; 2 usage;
            3 incomplete: a channel's kind could not be read (unconfirmed_channels; no_install is not) or a session
              was not moved (skipped); those are left as they were, run it again after fixing them.
              A reason of master_key_mismatch: the stored bot token does not open with the key
              this command got; give it the key the API runs with`;

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

/**
 * Why a channel went unread when the stored bot token does not open: the
 * command's master key is not the one the API sealed it with.
 */
const KEY_MISMATCH = "master_key_mismatch";

/** Why a channel went unread when its agent has no Slack install. */
const NOT_INSTALLED = "SLACK_NOT_INSTALLED";

type BindingKind = "public_channel" | "private_channel" | "unknown";

const bindingKindOf = async (
  read: () => Promise<ChannelKindNow | null>,
): Promise<BindingKind> => (await read()) ?? "unknown";

// Without Slack only narrowing is safe: a public binding may be stale, and
// a session widened on it would already have been seen.
const noInstallKind = (kind: BindingKind): ChannelKindNow | null =>
  kind === "public_channel" ? null : "private_channel";

/** The Slack the command asks in production: the agent's own app. */
export function slackOfAgents(deps: {
  apps: Pick<SurfaceAppStore, "findForAgent">;
  secrets: Pick<SecretStore, "get">;
  api: ReturnType<typeof createSlackBotApi>;
}): PrivateChannelSlack {
  const { apps, secrets, api } = deps;
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
        if (error instanceof SecretDecryptError) {
          return { unconfirmed: KEY_MISMATCH };
        }
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
  memberIds: readonly string[] | null,
): Promise<{ losing: Map<string, number>; unconfirmed: boolean }> {
  const losing = new Map(sessionIds.map((id) => [id, 0]));
  if (sessionIds.length === 0) return { losing, unconfirmed: false };
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
): Promise<{
  exit: number;
  keyMismatch: boolean;
  line: Record<string, unknown>;
}> {
  const bindings = createPostgresSurfaceBindingStore(db);
  const places = await channelSessionPlaces(db, command.filter);
  const runId = randomUUID();
  const unconfirmedChannels: Record<string, string>[] = [];
  const skipped: Record<string, string>[] = [];
  const planned: PlannedSession[] = [];
  const moved: Record<string, string>[] = [];
  const bindingChanges: Record<string, string>[] = [];
  const noInstallChannels: Record<string, string | number>[] = [];
  const noInstallSessions: Omit<
    PlannedSession,
    "people_losing" | "members_unconfirmed"
  >[] = [];
  let noInstallMoved = 0;
  const noInstall = (
    ids: Record<string, string>,
    kind: BindingKind,
    sessionCount: number,
  ) =>
    noInstallChannels.push({
      ...ids,
      binding_kind: kind,
      treated_as: noInstallKind(kind) ?? "unchanged",
      sessions: sessionCount,
    });
  let keptPrivate = 0;
  let unchanged = 0;
  for (const place of places) {
    const ids = { agent_id: place.agentId, channel_id: place.channelId };
    if (command.command === "apply") {
      let reason = "failed";
      let bound: BindingKind = "unknown";
      let members: readonly string[] | null = null;
      // Asked inside the move, after its lock on the channel: a binding
      // changed meanwhile is read as it is now.
      const changed = await bindings.channelKindChanged(
        place,
        async (inside) => {
          const now = await slack.kindOf(place);
          if ("kind" in now) {
            // Read before the sessions are locked, for who loses them.
            if (now.kind === "private_channel") {
              members = await slack.memberIds(place);
            }
            return now.kind;
          }
          reason = now.unconfirmed;
          if (reason !== NOT_INSTALLED) return null;
          bound = await bindingKindOf(inside.bindingKind);
          return noInstallKind(bound);
        },
        {
          ref: { run_id: runId },
          reason: "operator_private_channel_migration",
          by: "operator_cli",
          noInstall: () => reason === NOT_INSTALLED,
          peopleLosing: async (tx, ids) =>
            reason === NOT_INSTALLED
              ? null
              : (await peopleLosing(tx as Database, place, ids, members))
                  .losing,
        },
      );
      if (reason === NOT_INSTALLED) {
        noInstall(ids, bound, changed?.moves.length ?? 0);
        noInstallMoved += changed?.moves.length ?? 0;
      }
      if (changed === null) {
        if (reason !== NOT_INSTALLED) {
          unconfirmedChannels.push({ ...ids, reason });
        }
        continue;
      }
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
    const read = await slack.kindOf(place);
    let kind: ChannelKindNow;
    let bound: BindingKind | null = null;
    if ("kind" in read) kind = read.kind;
    else if (read.unconfirmed === NOT_INSTALLED) {
      bound = await bindingKindOf(() => channelBindingKind(db, place));
      const narrowed = noInstallKind(bound);
      if (narrowed === null) {
        noInstall(ids, bound, 0);
        continue;
      }
      kind = narrowed;
    } else {
      unconfirmedChannels.push({ ...ids, reason: read.unconfirmed });
      continue;
    }
    const { rows, plan } = await readChannelScopePlan(db, place, kind);
    const live = await bindings.findLiveSlackChannel(
      place.installationId,
      place.channelId,
    );
    if (
      live !== null &&
      live.channelKind !== "dm" &&
      live.channelKind !== kind &&
      live.status !== "left"
    ) {
      bindingChanges.push({
        ...ids,
        binding: kind === "private_channel" ? "now_private" : "now_public",
      });
    }
    const rowOf = new Map<string, ChannelSessionRow>(
      rows.map((row) => [row.sessionId, row]),
    );
    const keyTurns = (move: { sessionId: string; to: string }) =>
      move.to === "private_channel"
        ? (rowOf.get(move.sessionId)?.keyTurns ?? 0)
        : 0;
    if (bound !== null) {
      // Members cannot be read without the install: who loses is unknown.
      noInstall(ids, bound, plan.moves.length);
      for (const move of plan.moves) {
        noInstallSessions.push({
          session_id: move.sessionId,
          ...ids,
          from: move.from,
          to: move.to,
          key_turns: keyTurns(move),
        });
      }
    }
    const narrowing = plan.moves
      .filter((move) => move.to === "private_channel")
      .map((move) => move.sessionId);
    const { losing, unconfirmed } =
      bound === null
        ? await peopleLosing(
            db,
            place,
            narrowing,
            narrowing.length === 0 ? null : await slack.memberIds(place),
          )
        : { losing: new Map<string, number>(), unconfirmed: true };
    for (const move of bound === null ? plan.moves : []) {
      planned.push({
        session_id: move.sessionId,
        ...ids,
        from: move.from,
        to: move.to,
        people_losing: losing.get(move.sessionId) ?? 0,
        key_turns: keyTurns(move),
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
  const changedAny = moved.length > 0 || bindingChanges.length > 0;
  return {
    exit: incomplete
      ? PRIVATE_CHANNEL_SESSIONS_EXIT.incomplete
      : PRIVATE_CHANNEL_SESSIONS_EXIT.ok,
    keyMismatch: unconfirmedChannels.some(
      (channel) => channel.reason === KEY_MISMATCH,
    ),
    line: {
      outcome:
        command.command === "plan"
          ? "planned"
          : incomplete
            ? "incomplete"
            : changedAny
              ? "moved"
              : "unchanged",
      ...(command.command === "plan"
        ? {}
        : {
            run_id: runId,
            sessions_moved: moved.length,
            bindings_changed: bindingChanges.length,
          }),
      channels: places.length,
      ...(command.command === "plan" ? { sessions: planned } : { moved }),
      bindings: bindingChanges,
      kept_private: keptPrivate,
      unchanged,
      skipped,
      unconfirmed_channels: unconfirmedChannels,
      no_install: {
        channel_count: noInstallChannels.length,
        session_count:
          command.command === "plan"
            ? noInstallSessions.length
            : noInstallMoved,
        kind_unknown_as_private: noInstallChannels.filter(
          (channel) => channel.binding_kind === "unknown",
        ).length,
        ...(command.command === "plan"
          ? { people_losing: "unconfirmed_no_install" }
          : {}),
        channels: noInstallChannels,
        ...(command.command === "plan" ? { sessions: noInstallSessions } : {}),
      },
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
        slackOfAgents({
          apps: createPostgresSlackAppStore(database.db, key),
          secrets: createPostgresSecretStore(database.db, key),
          api: createSlackBotApi({ apiUrl: slackApiUrlFrom(io.env) }),
        });
      const { exit, keyMismatch, line } = await run(
        command,
        database.db,
        slack,
      );
      io.out(JSON.stringify(line));
      // The JSON names the channels; this line says what to do about them.
      if (keyMismatch) {
        io.err(`private-channel-sessions: ${MASTER_KEY_MISMATCH}`);
      }
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
