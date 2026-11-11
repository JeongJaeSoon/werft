import { randomBytes } from "node:crypto";
import {
  type LookupSlackChannelsQuery,
  type LookupSlackChannelsResponse,
  type SearchSlackChannelsQuery,
  type SearchSlackChannelsResponse,
  SLACK_BINDING_MESSAGES,
  SLACK_CHANNEL_SEARCH_MESSAGES,
  type SlackChannel,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  type SecretStore,
  SessionServiceError,
  type SlackAppStore,
  type SurfaceBindingService,
} from "@werft-ai/platform";
import { z } from "zod";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackChannelPage,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import {
  isTokenGone,
  isTokenRevoked,
  type SlackTokenRevoked,
} from "./slack-token-gone.ts";

// The channel picker's search: one app's whole channel list is read
// from Slack into a short cache, then filtered and paged here, so typing in
// the picker costs no Slack call. The cursor is ours, not Slack's: it names
// the cached list it pages through and stops working once that list is
// replaced.
//
// conversations.list is Slack's Tier 2 (20+ per minute):
// https://docs.slack.dev/reference/methods/conversations.list

export const SLACK_CHANNEL_CACHE_TTL_MS = 60_000;
/** Channels kept per app; past this the list says `truncated`. */
export const SLACK_CHANNEL_CACHE_MAX_CHANNELS = 10_000;
/** Apps cached at once; the least recently used is dropped first. */
export const SLACK_CHANNEL_CACHE_MAX_APPS = 500;
const ACTION = "binding.manage";
const UNKNOWN_CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "missing_scope",
  "no_permission",
  "method_not_supported_for_channel_type",
]);

export type SlackChannelApi = Pick<SlackBotApi, "listChannels"> &
  Partial<Pick<SlackBotApi, "channelInfo">>;

type Snapshot = {
  id: string;
  /** Sorted by name. */
  channels: readonly SlackChannel[];
  truncated: boolean;
  readAt: number;
};

type Read = {
  snapshot: Promise<Snapshot>;
  /** False once the key is invalidated: the result answers its callers only. */
  keep: boolean;
};

export type SlackChannelLookup = {
  snapshot: Snapshot;
  cache: "hit" | "miss" | "stale";
};

/**
 * Per-process cache of each app's channel list, keyed by our slack app id.
 * Concurrent misses on one key share one read.
 */
export function createSlackChannelCache(options?: {
  ttlMs?: number;
  maxChannels?: number;
  maxApps?: number;
  now?: () => number;
}) {
  const ttlMs = options?.ttlMs ?? SLACK_CHANNEL_CACHE_TTL_MS;
  const maxChannels = options?.maxChannels ?? SLACK_CHANNEL_CACHE_MAX_CHANNELS;
  const maxApps = options?.maxApps ?? SLACK_CHANNEL_CACHE_MAX_APPS;
  const now = options?.now ?? (() => Date.now());
  // Map order is the LRU order: oldest first.
  const snapshots = new Map<string, Snapshot>();
  // Neither is evicted with the snapshot: a key pushed out mid-read still
  // shares that read, and Slack's Retry-After holds until it passes.
  const reads = new Map<string, Read>();
  /** Slack's Retry-After, as a time: no call to Slack for the app before it. */
  const blockedUntil = new Map<string, number>();
  /** A read cut by a 429: what it had, and Slack's cursor to go on from. */
  const progress = new Map<
    string,
    { channels: SlackChannel[]; cursor: string }
  >();

  function keep(key: string, snapshot: Snapshot) {
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    while (snapshots.size > maxApps) {
      snapshots.delete(snapshots.keys().next().value as string);
    }
  }

  function block(key: string, until: number) {
    const at = now();
    for (const [other, time] of blockedUntil) {
      if (time <= at) blockedUntil.delete(other);
    }
    blockedUntil.set(key, until);
  }

  const blocked = (key: string) => now() < (blockedUntil.get(key) ?? 0);

  async function readAll(
    key: string,
    listPage: (cursor: string | null) => Promise<SlackChannelPage>,
    read: Read,
  ): Promise<Snapshot> {
    const resumed = progress.get(key);
    progress.delete(key);
    let channels: SlackChannel[] = resumed?.channels ?? [];
    let cursor: string | null = resumed?.cursor ?? null;
    let truncated = false;
    let resuming = resumed !== undefined;
    try {
      do {
        let page: SlackChannelPage;
        try {
          page = await listPage(cursor);
        } catch (error) {
          // Slack's cursors expire; a resumed read starts over, once.
          if (
            !resuming ||
            !(error instanceof SlackApiError) ||
            error.code !== "invalid_cursor"
          ) {
            throw error;
          }
          channels = [];
          cursor = null;
          page = await listPage(cursor);
        }
        resuming = false;
        channels.push(...page.channels);
        cursor = page.nextCursor;
        if (channels.length > maxChannels) {
          truncated = true;
          break;
        }
      } while (cursor !== null);
    } catch (error) {
      if (error instanceof SlackRateLimitedError) {
        block(key, now() + error.retryAfterSeconds * 1000);
        if (read.keep && cursor !== null) {
          progress.set(key, { channels, cursor });
          while (progress.size > maxApps) {
            progress.delete(progress.keys().next().value as string);
          }
        }
      }
      throw error;
    }
    channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      id: randomBytes(9).toString("base64url"),
      channels: channels.slice(0, maxChannels),
      truncated,
      readAt: now(),
    };
  }

  return {
    /** The cached list of `key`, reading it from Slack when it has expired. */
    async lookup(
      key: string,
      listPage: () => Promise<
        (cursor: string | null) => Promise<SlackChannelPage>
      >,
    ): Promise<SlackChannelLookup> {
      const cached = snapshots.get(key) ?? null;
      if (cached && now() - cached.readAt < ttlMs) {
        keep(key, cached);
        return { snapshot: cached, cache: "hit" };
      }
      if (blocked(key)) {
        if (cached) {
          keep(key, cached);
          return { snapshot: cached, cache: "stale" };
        }
        throw new SlackRateLimitedError(
          "conversations.list",
          Math.ceil(((blockedUntil.get(key) ?? 0) - now()) / 1000),
        );
      }
      let read = reads.get(key);
      if (read === undefined) {
        const started = { keep: true } as Read;
        started.snapshot = (async () =>
          readAll(key, await listPage(), started))();
        read = started;
        reads.set(key, started);
        started.snapshot.then(
          (snapshot) => {
            if (reads.get(key) === started) reads.delete(key);
            if (started.keep) keep(key, snapshot);
          },
          () => {
            if (reads.get(key) === started) reads.delete(key);
          },
        );
      }
      try {
        return { snapshot: await read.snapshot, cache: "miss" };
      } catch (error) {
        const fallback = snapshots.get(key) ?? null;
        if (error instanceof SlackRateLimitedError && fallback) {
          return { snapshot: fallback, cache: "stale" };
        }
        throw error;
      }
    },

    /**
     * The cached snapshot when it is still the one `snapshotId` names; stale
     * while Slack is rate limiting the app, as the first page was.
     */
    held(key: string, snapshotId: string): SlackChannelLookup | null {
      const snapshot = snapshots.get(key);
      if (snapshot?.id !== snapshotId) return null;
      keep(key, snapshot);
      return { snapshot, cache: blocked(key) ? "stale" : "hit" };
    },

    /**
     * Forgets the list, keeping any rate limit Slack set. A read in flight
     * still answers whoever waits on it, but is not kept.
     */
    invalidate(key: string): void {
      snapshots.delete(key);
      progress.delete(key);
      const read = reads.get(key);
      if (read) read.keep = false;
    },

    size: () => snapshots.size,
  };
}

export type SlackChannelCache = ReturnType<typeof createSlackChannelCache>;

type CursorState = { snapshot: string; offset: number; q: string };

const cursorShape = z
  .object({
    s: z.string().min(1).max(64),
    o: z.number().int().positive(),
    q: z.string().max(255),
  })
  .strict();

function encodeCursor(state: CursorState): string {
  return Buffer.from(
    JSON.stringify({ s: state.snapshot, o: state.offset, q: state.q }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): CursorState {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {}
  const parsed = cursorShape.safeParse(raw);
  if (!parsed.success) {
    throw new SessionServiceError("BAD_REQUEST", "Invalid cursor");
  }
  return { snapshot: parsed.data.s, offset: parsed.data.o, q: parsed.data.q };
}

/** Lower case, without a leading `#` or surrounding space. */
export function normalizeChannelQuery(q: string): string {
  return q.trim().replace(/^#+/, "").toLowerCase();
}

const notInstalled = () =>
  new SessionServiceError(
    "SLACK_NOT_INSTALLED",
    SLACK_BINDING_MESSAGES.notInstalled,
  );

export type SlackChannelSearchResult = {
  page: SearchSlackChannelsResponse;
  slackAppId: string;
  cache: SlackChannelLookup["cache"];
};

export function createSlackChannelSearchService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentAuthority, "agentOf">;
  /** Null when the API runs without a master key. */
  apps: Pick<SlackAppStore, "findForAgent"> | null;
  secrets: Pick<SecretStore, "get"> | null;
  api: SlackChannelApi;
  cache?: SlackChannelCache;
  /** Revokes the install when Slack says the bot token was revoked. */
  tokenRevoked?: SlackTokenRevoked;
}) {
  const { authorization, api } = deps;
  const cache = deps.cache ?? createSlackChannelCache();
  const names = new Map<
    string,
    { at: number; value: LookupSlackChannelsResponse["items"][number] }
  >();
  const pendingNames = new Map<
    string,
    Promise<LookupSlackChannelsResponse["items"][number]>
  >();
  const rateLimitedUntil = new Map<string, number>();

  return {
    cache,

    async lookupSlackChannels(
      caller: Caller,
      agentId: string,
      query: LookupSlackChannelsQuery,
    ): Promise<LookupSlackChannelsResponse> {
      await requirePermitted(authorization, caller, ACTION, {
        kind: "agent",
        id: agentId,
      });
      if (
        deps.apps === null ||
        deps.secrets === null ||
        api.channelInfo === undefined
      )
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "Slack channel lookup is unavailable",
        );
      const app = await deps.apps.findForAgent(caller.ownerId, agentId);
      if (app === null || app.state !== "created") {
        const agent = await deps.agents.agentOf(caller.ownerId, {
          kind: "agent",
          id: agentId,
        });
        throw agent === null
          ? new SessionServiceError("NOT_FOUND", "Resource not found")
          : notInstalled();
      }
      const startedAt = new Date();
      const until = rateLimitedUntil.get(app.id) ?? 0;
      if (until > Date.now())
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          SLACK_CHANNEL_SEARCH_MESSAGES.rateLimited,
          { afterSeconds: Math.ceil((until - Date.now()) / 1000) },
        );
      rateLimitedUntil.delete(app.id);
      const token = await deps.secrets.get({
        workspaceId: app.workspaceId,
        owner: { kind: "slack_app", id: app.id },
        purpose: "slack_bot_token",
      });
      if (token === null) throw notInstalled();
      const channelInfo = api.channelInfo;
      const items = await Promise.all(
        [...new Set(query.ids)].map(async (id) => {
          const key = `${app.id}:${id}`;
          const cached = names.get(key);
          if (cached && Date.now() - cached.at < SLACK_CHANNEL_CACHE_TTL_MS)
            return cached.value;
          const existing = pendingNames.get(key);
          if (existing) return existing;
          const promise = (async () => {
            let value: LookupSlackChannelsResponse["items"][number];
            try {
              const channel = await channelInfo(token, id);
              value = { id, name: channel.name, state: "known" };
            } catch (error) {
              if (error instanceof SlackRateLimitedError) {
                rateLimitedUntil.set(
                  app.id,
                  Date.now() + error.retryAfterSeconds * 1000,
                );
                if (rateLimitedUntil.size > SLACK_CHANNEL_CACHE_MAX_APPS) {
                  const oldest = rateLimitedUntil.keys().next().value;
                  if (oldest !== undefined) rateLimitedUntil.delete(oldest);
                }
                throw new SessionServiceError(
                  "BACKEND_UNAVAILABLE",
                  SLACK_CHANNEL_SEARCH_MESSAGES.rateLimited,
                  { afterSeconds: error.retryAfterSeconds },
                );
              }
              if (!(error instanceof SlackApiError)) throw error;
              if (isTokenGone(error)) {
                if (isTokenRevoked(error)) {
                  await deps.tokenRevoked?.({
                    workspaceId: app.workspaceId,
                    agentId,
                    slackAppId: app.id,
                    appId: app.appId,
                    failedToken: token,
                    since: startedAt,
                  });
                }
                throw notInstalled();
              }
              if (!error.answered || !UNKNOWN_CHANNEL_ERRORS.has(error.code)) {
                throw new SessionServiceError(
                  "BACKEND_UNAVAILABLE",
                  "Slack did not answer conversations.info; try again",
                  { afterSeconds: 5 },
                );
              }
              value = { id, name: "unknown", state: "unknown" };
            }
            names.delete(key);
            names.set(key, { at: Date.now(), value });
            if (names.size > 25_000) {
              const oldest = names.keys().next().value;
              if (oldest !== undefined) names.delete(oldest);
            }
            return value;
          })();
          pendingNames.set(key, promise);
          try {
            return await promise;
          } finally {
            pendingNames.delete(key);
          }
        }),
      );
      return { items };
    },

    /** Drops the cached channels of the agent's app, if it has one. */
    async forgetAgent(workspaceId: string, agentId: string): Promise<void> {
      const app = await deps.apps?.findForAgent(workspaceId, agentId);
      if (app) cache.invalidate(app.id);
    },

    async searchSlackChannels(
      caller: Caller,
      agentId: string,
      query: SearchSlackChannelsQuery,
    ): Promise<SlackChannelSearchResult> {
      await requirePermitted(authorization, caller, ACTION, {
        kind: "agent",
        id: agentId,
      });
      if (deps.apps === null || deps.secrets === null) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
          undefined,
          { reason_code: "secret_store_off" },
        );
      }
      const secrets = deps.secrets;
      const app = await deps.apps.findForAgent(caller.ownerId, agentId);
      if (app === null || app.state !== "created") {
        // The policy lets an owner through for any id; an agent of another
        // workspace, or none, is not found rather than not installed.
        const agent = await deps.agents.agentOf(caller.ownerId, {
          kind: "agent",
          id: agentId,
        });
        throw agent === null
          ? new SessionServiceError("NOT_FOUND", "Resource not found")
          : notInstalled();
      }
      const startedAt = new Date();
      const q = normalizeChannelQuery(query.q);
      const from =
        query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (from !== null && from.q !== q) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The cursor belongs to another search",
        );
      }

      let lookup: SlackChannelLookup;
      const held = from === null ? null : cache.held(app.id, from.snapshot);
      if (held !== null) {
        lookup = held;
      } else if (from !== null) {
        throw new SessionServiceError(
          "CURSOR_EXPIRED",
          SLACK_CHANNEL_SEARCH_MESSAGES.cursorExpired,
        );
      } else {
        let usedToken: string | null = null;
        try {
          lookup = await cache.lookup(app.id, async () => {
            const botToken = await secrets.get({
              workspaceId: app.workspaceId,
              owner: { kind: "slack_app", id: app.id },
              purpose: "slack_bot_token",
            });
            if (botToken === null) throw notInstalled();
            usedToken = botToken;
            return (cursor) => api.listChannels(botToken, cursor);
          });
        } catch (error) {
          if (error instanceof SlackRateLimitedError) {
            throw new SessionServiceError(
              "BACKEND_UNAVAILABLE",
              SLACK_CHANNEL_SEARCH_MESSAGES.rateLimited,
              { afterSeconds: error.retryAfterSeconds },
            );
          }
          if (error instanceof SlackApiError) {
            if (isTokenGone(error)) {
              if (isTokenRevoked(error) && usedToken !== null) {
                await deps.tokenRevoked?.({
                  workspaceId: app.workspaceId,
                  agentId,
                  slackAppId: app.id,
                  appId: app.appId,
                  failedToken: usedToken,
                  since: startedAt,
                });
              }
              throw notInstalled();
            }
            throw new SessionServiceError(
              "BACKEND_UNAVAILABLE",
              `Slack did not answer ${error.method}; try again`,
              { afterSeconds: 5 },
            );
          }
          throw error;
        }
      }

      const { snapshot } = lookup;
      const matches =
        q === ""
          ? snapshot.channels
          : snapshot.channels.filter((channel) =>
              channel.name.toLowerCase().startsWith(q),
            );
      const offset = from?.offset ?? 0;
      const end = offset + query.limit;
      return {
        page: {
          items: matches.slice(offset, end),
          next_cursor:
            end < matches.length
              ? encodeCursor({ snapshot: snapshot.id, offset: end, q })
              : null,
          truncated: snapshot.truncated,
          stale: lookup.cache === "stale",
        },
        slackAppId: app.id,
        cache: lookup.cache,
      };
    },
  };
}

export type SlackChannelSearchService = ReturnType<
  typeof createSlackChannelSearchService
>;

/**
 * The binding service, with a set binding also dropping that agent's cached
 * channels in this process. Other processes wait out the TTL. The binding is
 * already written when the drop runs, so a failed drop is not the PUT's error.
 */
export function forgettingChannelsOnBindingPut(
  bindings: SurfaceBindingService,
  search: Pick<SlackChannelSearchService, "forgetAgent">,
): SurfaceBindingService {
  return {
    ...bindings,
    async putSlackBinding(caller, agentId, request) {
      const set = await bindings.putSlackBinding(caller, agentId, request);
      await search.forgetAgent(caller.ownerId, agentId).catch(() => {});
      return set;
    },
  };
}
