import { createHmac, randomBytes } from "node:crypto";

// Slack's Web API over HTTP, for tests and the local stack: whatever reads
// MOCK_SLACK_API_URL can be pointed at `<url>/api`. Every token it hands out is
// made here at runtime; none is a real credential.

export type FakeSlackApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  manifest: unknown;
  /** Bot tokens issued by oauth.v2.access for this app. */
  botTokens: string[];
};

/** One call as the fake saw it: method and outcome, never a token. */
export type FakeSlackCall = { method: string; ok: boolean; error?: string };

/** A channel of the fake's one team; `members` are the apps whose bot is in it. */
export type FakeSlackListedChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  members: string[];
};

export type SeedSlackChannel = {
  name: string;
  isPrivate?: boolean;
  isArchived?: boolean;
  members?: string[];
};

export type FakeSlackWebApi = {
  /** Every channel, in the order conversations.list pages through them. */
  conversations: FakeSlackListedChannel[];
  /**
   * Adds channels with made-up ids (`C…` public, `G…` private), which
   * conversations.info then describes too.
   */
  seedChannels(seeds: SeedSlackChannel[]): FakeSlackListedChannel[];
  /**
   * After `after` more calls of `method` go through, the next `times` answer
   * 429 with this Retry-After.
   */
  rateLimit(
    method: string,
    retryAfterSeconds: number,
    times?: number,
    after?: number,
  ): void;
  /** Answers `/api/<method>` and the fake's own routes; null for anything else. */
  handle(request: Request): Promise<Response | null>;
  /** A refresh token tooling.tokens.rotate takes once, as a pasted config token. */
  issueConfigToken(): string;
  /** Follows an authorize URL as an approving admin would; returns the code. */
  authorize(authorizeUrl: string): { code: string; state: string | null };
  apps: Map<string, FakeSlackApp>;
  calls: FakeSlackCall[];
  /** Fields merged into every apps.manifest.update answer. */
  manifestUpdateAnswer: Record<string, unknown>;
  /**
   * Posts an event to `url` as Slack would, signed with the app's secret:
   * `ageSeconds` backdates the timestamp (negative: from the future),
   * `challenge` sends a url_verification instead. Answers what came back.
   */
  sendEvent(input: SendSlackEventInput): Promise<{
    status: number;
    body: unknown;
    eventId: string | null;
  }>;
  /** Fields merged into every oauth.v2.access answer, to mimic a bad one. */
  installAnswer: Record<string, unknown>;
  /** users.info answers; a user not here is a full member of the team. */
  users: Map<string, FakeSlackUser>;
  /**
   * conversations.info answers; a channel not here is told by its id: D is
   * a DM, G a private channel, anything else public.
   */
  channels: Map<string, FakeSlackChannel>;
  /** Every thread status agents.sessions.setStatus accepted, in order. */
  statuses: { channelId: string; threadTs: string; status: string }[];
  /** Every message chat.postMessage and chat.postEphemeral accepted. */
  messages: FakeSlackMessage[];
  /** Every chat.update accepted, in order, with its blocks parsed. */
  updates: { channelId: string; ts: string; text: string; blocks: unknown }[];
  /** Every views.open accepted, in order. */
  views: { triggerId: string; view: unknown }[];
  /** Every views.update accepted, in order. */
  viewUpdates: { viewId: string; view: unknown }[];
  /** A send method named here answers ok:true without a ts, then forgets. */
  missingTs: Set<string>;
  /** A method named here answers ok:false with this error. */
  failures: Map<string, string>;
  /** A block type named here is refused as `invalid_blocks`, as an app without it would be. */
  refusedBlockTypes: Set<string>;
};

/** A chat.postMessage or chat.postEphemeral the fake accepted. */
export type FakeSlackMessage = {
  method: "chat.postMessage" | "chat.postEphemeral";
  channelId: string;
  threadTs: string | null;
  /** The ephemeral's reader. */
  userId: string | null;
  text: string;
  ts: string;
  /** The request's own fields, as sent, other than the above. */
  options: Record<string, string>;
};

export type FakeSlackUser = {
  teamId?: string;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  isStranger?: boolean;
  image48?: string;
};

export type FakeSlackChannel = {
  isIm?: boolean;
  isPrivate?: boolean;
  isMpim?: boolean;
};

export type SendSlackEventInput = {
  url: string;
  appId: string;
  event?: Record<string, unknown>;
  eventId?: string;
  teamId?: string;
  ageSeconds?: number;
  retryNum?: number;
  challenge?: string;
};

type Context = {
  token: string | null;
  params: Record<string, string>;
};

class SlackError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Slack's limits on a message's blocks: 50 in all, a collapsible container
// counted with its children, at most 10 of them and never a container.
const MESSAGE_BLOCKS_MAX = 50;
const CONTAINER_CHILDREN_MAX = 10;

/** Throws `invalid_blocks` for blocks Slack would refuse to post. */
function checkBlocks(
  raw: string | undefined,
  refused: ReadonlySet<string> = new Set(),
): void {
  if (raw === undefined) return;
  let blocks: unknown;
  try {
    blocks = JSON.parse(raw);
  } catch {
    throw new SlackError("invalid_blocks");
  }
  if (!Array.isArray(blocks)) throw new SlackError("invalid_blocks");
  let count = 0;
  let tableCharacters = 0;
  for (const block of blocks as {
    type?: unknown;
    child_blocks?: unknown;
    rows?: unknown;
    text?: { text?: unknown };
  }[]) {
    count += 1;
    if (typeof block?.type === "string" && refused.has(block.type)) {
      throw new SlackError("invalid_blocks");
    }
    if (block?.type === "section" && block.text !== undefined) {
      const length = String(block.text.text ?? "").length;
      if (length === 0 || length > 3_000)
        throw new SlackError("invalid_blocks");
    }
    if (block?.type === "table") {
      const rows = block.rows;
      const cells = Array.isArray(rows) ? (rows as { text?: unknown }[][]) : [];
      if (
        cells.length === 0 ||
        cells.length > 100 ||
        cells.some(
          (row) =>
            !Array.isArray(row) ||
            row.length === 0 ||
            row.length > 20 ||
            row.some((cell) => String(cell?.text ?? "") === ""),
        )
      ) {
        throw new SlackError("invalid_blocks");
      }
      tableCharacters += cells
        .flat()
        .reduce((sum, cell) => sum + String(cell.text).length, 0);
      if (tableCharacters > 10_000) throw new SlackError("invalid_blocks");
    }
    if (block?.type !== "container") continue;
    const children = block.child_blocks;
    if (
      !Array.isArray(children) ||
      children.length === 0 ||
      children.length > CONTAINER_CHILDREN_MAX ||
      children.some((child) => child?.type === "container")
    ) {
      throw new SlackError("invalid_blocks");
    }
    count += children.length;
  }
  if (count > MESSAGE_BLOCKS_MAX) throw new SlackError("invalid_blocks");
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function createFakeSlackWebApi(
  options: {
    teamId?: string;
    /** The Slack user whose config token this is. */
    userId?: string;
    /** Seconds an access token lives; Slack's is 12 hours. */
    accessTtlSeconds?: number;
  } = {},
): FakeSlackWebApi {
  const teamId = options.teamId ?? "T0MOCK";
  const userId = options.userId ?? "U0MOCK";
  const ttl = options.accessTtlSeconds ?? 12 * 3600;
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const codes = new Map<string, { appId: string; redirectUri: string }>();
  const apps = new Map<string, FakeSlackApp>();
  const calls: FakeSlackCall[] = [];
  const updates: FakeSlackWebApi["updates"] = [];
  const views: FakeSlackWebApi["views"] = [];
  const viewUpdates: FakeSlackWebApi["viewUpdates"] = [];
  /** The scopes each pending code's authorize URL asked for. */
  const scopesOf = new Map<string, string>();
  const installAnswer: Record<string, unknown> = {};
  const manifestUpdateAnswer: Record<string, unknown> = {};
  const users = new Map<string, FakeSlackUser>();
  const channels = new Map<string, FakeSlackChannel>();
  const statuses: FakeSlackWebApi["statuses"] = [];
  const messages: FakeSlackMessage[] = [];
  const missingTs = new Set<string>();
  let messageCounter = 0;

  const post = (
    method: FakeSlackMessage["method"],
    context: Context,
    userId: string | null,
  ) => {
    installedBot(context);
    const { channel, thread_ts, text, user: _, ...options } = context.params;
    if (!channel) throw new SlackError("channel_not_found");
    if (!text) throw new SlackError("no_text");
    checkBlocks(options.blocks, refusedBlockTypes);
    messageCounter += 1;
    const ts = `${Math.floor(Date.now() / 1000)}.${String(messageCounter).padStart(6, "0")}`;
    messages.push({
      method,
      channelId: channel,
      threadTs: thread_ts ?? null,
      userId,
      text,
      ts,
      options,
    });
    return ts;
  };
  const failures = new Map<string, string>();
  const refusedBlockTypes = new Set<string>();
  /** The next call of a method answers exactly this, then it is forgotten. */
  const nextAnswers = new Map<string, { status: number; body: unknown }>();
  let appCounter = 0;
  const conversations: FakeSlackListedChannel[] = [];
  const rateLimits = new Map<
    string,
    { retryAfterSeconds: number; times: number; after: number }
  >();

  const seedChannels = (seeds: SeedSlackChannel[]) =>
    seeds.map((seed) => {
      const channel: FakeSlackListedChannel = {
        id: `${seed.isPrivate ? "G" : "C"}0${hex(5).toUpperCase()}`,
        name: seed.name,
        isPrivate: seed.isPrivate ?? false,
        isArchived: seed.isArchived ?? false,
        members: [...(seed.members ?? [])],
      };
      conversations.push(channel);
      channels.set(channel.id, { isPrivate: channel.isPrivate });
      return channel;
    });

  const issueConfigToken = () => {
    const refresh = `xoxe-1-${hex(24)}`;
    refreshTokens.add(refresh);
    return refresh;
  };

  const configToken = (context: Context) => {
    if (!context.token || !accessTokens.has(context.token)) {
      throw new SlackError("invalid_auth");
    }
  };

  const appOf = (appId: string | undefined) => {
    const app = appId === undefined ? undefined : apps.get(appId);
    if (!app) throw new SlackError("app_not_found");
    return app;
  };

  // Bot tokens of an app removed in Slack: Slack answers them
  // `token_revoked`, where a token it never issued is `invalid_auth`.
  const revokedBotTokens = new Set<string>();

  const installedBot = (context: Context) => {
    if (revokedBotTokens.has(context.token ?? "")) {
      throw new SlackError("token_revoked");
    }
    const app = [...apps.values()].find((candidate) =>
      candidate.botTokens.includes(context.token ?? ""),
    );
    if (!app) throw new SlackError("invalid_auth");
    return app;
  };

  // A channel not seeded has the bot in it already: nothing to join.
  const membershipOf = (context: Context, id: string) => {
    const app = installedBot(context);
    const listed = conversations.find((candidate) => candidate.id === id);
    return {
      is_member: listed ? listed.members.includes(app.appId) : true,
      is_archived: listed?.isArchived ?? false,
    };
  };

  const methods: Record<string, (context: Context) => object | null> = {
    "auth.test"(context) {
      if (context.token && accessTokens.has(context.token)) {
        return { team_id: teamId, user_id: userId };
      }
      const app = [...apps.values()].find((candidate) =>
        candidate.botTokens.includes(context.token ?? ""),
      );
      if (!app) return null;
      return {
        team_id: teamId,
        user_id: `U${app.appId}BOT`,
        bot_id: `B${app.appId}`,
        app_id: app.appId,
      };
    },

    "bots.info"(context) {
      const app = [...apps.values()].find((candidate) =>
        candidate.botTokens.includes(context.token ?? ""),
      );
      if (!app) return null;
      if (context.params.bot !== `B${app.appId}`) {
        throw new SlackError("bot_not_found");
      }
      return {
        bot: {
          id: `B${app.appId}`,
          app_id: app.appId,
          user_id: `U${app.appId}BOT`,
          deleted: false,
        },
      };
    },

    // As Slack does, the page is cut at `limit` before it is filtered, so a
    // page can come back short with more to read.
    "conversations.list"(context) {
      const app = installedBot(context);
      const types = new Set(
        (context.params.types ?? "public_channel").split(","),
      );
      const excludeArchived = ["true", "1"].includes(
        context.params.exclude_archived ?? "",
      );
      const limit = Math.min(
        Math.max(Number(context.params.limit ?? 100) || 100, 1),
        1000,
      );
      let offset = 0;
      if (context.params.cursor) {
        const match = /^offset:(\d+)$/.exec(
          Buffer.from(context.params.cursor, "base64").toString("utf8"),
        );
        if (!match) throw new SlackError("invalid_cursor");
        offset = Number(match[1]);
      }
      const end = offset + limit;
      const page = conversations
        .slice(offset, end)
        .filter(
          (channel) =>
            types.has(
              channel.isPrivate ? "private_channel" : "public_channel",
            ) &&
            !(excludeArchived && channel.isArchived) &&
            (!channel.isPrivate || channel.members.includes(app.appId)),
        );
      return {
        channels: page.map((channel) => ({
          id: channel.id,
          name: channel.name,
          is_channel: !channel.isPrivate,
          is_group: channel.isPrivate,
          is_private: channel.isPrivate,
          is_archived: channel.isArchived,
          is_member: channel.members.includes(app.appId),
        })),
        response_metadata: {
          next_cursor:
            end < conversations.length
              ? Buffer.from(`offset:${end}`).toString("base64")
              : "",
        },
      };
    },

    "users.info"(context) {
      installedBot(context);
      const id = context.params.user;
      if (!id) throw new SlackError("user_not_found");
      const user = users.get(id) ?? {};
      return {
        user: {
          id,
          team_id: user.teamId ?? teamId,
          is_bot: false,
          deleted: false,
          is_restricted: user.isRestricted ?? false,
          is_ultra_restricted: user.isUltraRestricted ?? false,
          ...(user.isStranger === undefined
            ? {}
            : { is_stranger: user.isStranger }),
          ...(user.image48 === undefined
            ? {}
            : { profile: { image_48: user.image48 } }),
        },
      };
    },

    "conversations.info"(context) {
      installedBot(context);
      const id = context.params.channel;
      if (!id) throw new SlackError("channel_not_found");
      // Slack hides a private channel from a bot that is not in it.
      const hidden = conversations.find((candidate) => candidate.id === id);
      if (
        hidden?.isPrivate &&
        !hidden.members.includes(installedBot(context).appId)
      ) {
        throw new SlackError("channel_not_found");
      }
      const channel = channels.get(id) ?? {
        isIm: id.startsWith("D"),
        isPrivate: id.startsWith("G"),
      };
      return {
        channel: {
          id,
          name: conversations.find((item) => item.id === id)?.name,
          is_im: channel.isIm ?? false,
          is_private: channel.isPrivate ?? false,
          is_mpim: channel.isMpim ?? false,
          ...membershipOf(context, id),
        },
      };
    },

    "conversations.join"(context) {
      const app = installedBot(context);
      const listed = conversations.find(
        (candidate) => candidate.id === context.params.channel,
      );
      if (!listed) throw new SlackError("channel_not_found");
      if (listed.isArchived) throw new SlackError("is_archived");
      if (listed.isPrivate) {
        throw new SlackError("method_not_supported_for_channel_type");
      }
      if (!listed.members.includes(app.appId)) listed.members.push(app.appId);
      return { channel: { id: listed.id, is_member: true } };
    },

    // Posted, but the answer names no message: Slack holds it all the same.
    "chat.postMessage"(context) {
      const ts = post("chat.postMessage", context, null);
      if (missingTs.delete("chat.postMessage")) return {};
      return { channel: context.params.channel, ts };
    },

    "chat.postEphemeral"(context) {
      const user = context.params.user;
      if (!user) throw new SlackError("user_not_found");
      const ts = post("chat.postEphemeral", context, user);
      if (missingTs.delete("chat.postEphemeral")) return {};
      return { message_ts: ts };
    },

    "chat.update"(context) {
      installedBot(context);
      const { channel, ts, text, blocks } = context.params;
      if (!channel || !ts) throw new SlackError("message_not_found");
      checkBlocks(blocks);
      updates.push({
        channelId: channel,
        ts,
        text: text ?? "",
        blocks: blocks === undefined ? undefined : JSON.parse(blocks),
      });
      return { channel, ts };
    },

    "views.open"(context) {
      installedBot(context);
      const { trigger_id, view } = context.params;
      if (!trigger_id || !view) throw new SlackError("invalid_arguments");
      views.push({ triggerId: trigger_id, view: JSON.parse(view) });
      return { view: { id: `V${views.length}` } };
    },

    "views.update"(context) {
      installedBot(context);
      const { view_id, view } = context.params;
      if (!view_id || !view) throw new SlackError("invalid_arguments");
      if (!/^V\d+$/.test(view_id) || Number(view_id.slice(1)) > views.length) {
        throw new SlackError("not_found");
      }
      viewUpdates.push({ viewId: view_id, view: JSON.parse(view) });
      return { view: { id: view_id } };
    },

    // Slack's archive link; the fake keeps no threads, so a reply's link
    // lacks the `thread_ts` and `cid` Slack adds.
    "chat.getPermalink"(context) {
      installedBot(context);
      const { channel, message_ts } = context.params;
      if (!channel || !message_ts) throw new SlackError("invalid_arguments");
      return {
        channel,
        permalink: `https://${teamId.toLowerCase()}.slack.com/archives/${channel}/p${message_ts.replace(".", "")}`,
      };
    },

    "agents.sessions.setStatus"(context) {
      installedBot(context);
      const { channel_id, thread_ts, status } = context.params;
      if (!channel_id || !status) throw new SlackError("invalid_arguments");
      if (!thread_ts) throw new SlackError("thread_ts_required");
      statuses.push({ channelId: channel_id, threadTs: thread_ts, status });
      return {};
    },

    "tooling.tokens.rotate"(context) {
      const refresh = context.params.refresh_token ?? "";
      if (!refreshTokens.delete(refresh)) {
        throw new SlackError("invalid_refresh_token");
      }
      const access = `xoxe.xoxp-1-${hex(24)}`;
      accessTokens.add(access);
      const iat = Math.floor(Date.now() / 1000);
      return {
        token: access,
        refresh_token: issueConfigToken(),
        team_id: teamId,
        user_id: userId,
        iat,
        exp: iat + ttl,
      };
    },

    "apps.manifest.create"(context) {
      configToken(context);
      const manifest = JSON.parse(context.params.manifest ?? "null");
      if (manifest === null || typeof manifest !== "object") {
        throw new SlackError("invalid_manifest");
      }
      appCounter += 1;
      const app: FakeSlackApp = {
        appId: `A0FAKE${hex(4).toUpperCase()}${appCounter}`,
        clientId: `${Date.now()}.${appCounter}`,
        clientSecret: hex(16),
        signingSecret: hex(16),
        manifest,
        botTokens: [],
      };
      apps.set(app.appId, app);
      return {
        app_id: app.appId,
        credentials: {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          signing_secret: app.signingSecret,
          verification_token: hex(12),
        },
        oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${app.clientId}`,
      };
    },

    "apps.manifest.update"(context) {
      configToken(context);
      const app = appOf(context.params.app_id);
      app.manifest = JSON.parse(context.params.manifest ?? "null");
      return {
        app_id: app.appId,
        permissions_updated: false,
        ...manifestUpdateAnswer,
      };
    },

    "apps.manifest.export"(context) {
      configToken(context);
      return { manifest: appOf(context.params.app_id).manifest };
    },

    "apps.manifest.delete"(context) {
      configToken(context);
      apps.delete(appOf(context.params.app_id).appId);
      return {};
    },

    "oauth.v2.access"(context) {
      const pending = codes.get(context.params.code ?? "");
      const scope = scopesOf.get(context.params.code ?? "");
      scopesOf.delete(context.params.code ?? "");
      codes.delete(context.params.code ?? "");
      const app = pending ? apps.get(pending.appId) : undefined;
      if (!pending || !app) throw new SlackError("invalid_code");
      if (
        context.params.client_id !== app.clientId ||
        context.params.client_secret !== app.clientSecret
      ) {
        throw new SlackError("invalid_client_id");
      }
      if (context.params.redirect_uri !== pending.redirectUri) {
        throw new SlackError("bad_redirect_uri");
      }
      const bot = `xoxb-${hex(24)}`;
      app.botTokens.push(bot);
      return {
        access_token: bot,
        token_type: "bot",
        bot_user_id: `U${app.appId}BOT`,
        app_id: app.appId,
        team: { id: teamId, name: "mock" },
        enterprise: null,
        is_enterprise_install: false,
        scope: scope ?? "",
        authed_user: { id: userId },
        ...installAnswer,
      };
    },
  };

  function authorize(authorizeUrl: string) {
    const query = new URL(authorizeUrl).searchParams;
    const app = [...apps.values()].find(
      (candidate) => candidate.clientId === query.get("client_id"),
    );
    const redirectUri = query.get("redirect_uri");
    if (!app || !redirectUri) throw new Error("unknown app or no redirect");
    const code = hex(16);
    codes.set(code, { appId: app.appId, redirectUri });
    scopesOf.set(code, query.get("scope") ?? "");
    return { code, state: query.get("state") };
  }

  async function sendEvent(input: SendSlackEventInput) {
    const app = appOf(input.appId);
    const envelope =
      input.challenge === undefined
        ? slackEventEnvelope({
            appId: app.appId,
            teamId: input.teamId ?? teamId,
            event: input.event ?? {},
            ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
          })
        : {
            token: hex(12),
            challenge: input.challenge,
            type: "url_verification",
          };
    const body = JSON.stringify(envelope);
    const sentAt = Math.floor(Date.now() / 1000) - (input.ageSeconds ?? 0);
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signSlackRequest(app.signingSecret, body, sentAt),
        ...(input.retryNum === undefined
          ? {}
          : {
              "X-Slack-Retry-Num": String(input.retryNum),
              "X-Slack-Retry-Reason": "http_timeout",
            }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let answer: unknown = text;
    try {
      answer = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      body: answer,
      eventId: "event_id" in envelope ? envelope.event_id : null,
    };
  }

  async function paramsOf(request: Request, url: URL) {
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (request.method !== "POST") return params;
    const type = request.headers.get("content-type") ?? "";
    const text = await request.text();
    if (type.startsWith("application/json")) {
      const body = JSON.parse(text || "{}") as Record<string, unknown>;
      for (const [name, value] of Object.entries(body)) {
        params[name] =
          typeof value === "string" ? value : JSON.stringify(value);
      }
    } else {
      Object.assign(params, Object.fromEntries(new URLSearchParams(text)));
    }
    return params;
  }

  return {
    apps,
    calls,
    updates,
    viewUpdates,
    views,
    conversations,
    seedChannels,
    rateLimit(method, retryAfterSeconds, times = 1, after = 0) {
      rateLimits.set(method, { retryAfterSeconds, times, after });
    },
    issueConfigToken,

    installAnswer,
    manifestUpdateAnswer,
    users,
    channels,
    statuses,
    messages,
    missingTs,
    failures,
    refusedBlockTypes,
    authorize,
    sendEvent,

    async handle(request) {
      const url = new URL(request.url);
      // The consent screen, answered as an approving admin: the code comes
      // back as JSON instead of a redirect, so curl can drive an install.
      if (
        url.pathname === "/fake/oauth/authorize" &&
        request.method === "GET"
      ) {
        try {
          return Response.json({ ok: true, ...authorize(url.toString()) });
        } catch {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
      }
      // The workspace removes the app with no event sent: its bot tokens
      // are answered `token_revoked` from now on; a new install mints new ones.
      if (
        url.pathname === "/fake/revoked-tokens" &&
        request.method === "POST"
      ) {
        const input = (await request.json().catch(() => null)) as {
          app_id?: unknown;
        } | null;
        const app =
          typeof input?.app_id === "string"
            ? apps.get(input.app_id)
            : undefined;
        if (!app) {
          return Response.json(
            { ok: false, error: "app_not_found" },
            { status: 400 },
          );
        }
        for (const token of app.botTokens.splice(0)) {
          revokedBotTokens.add(token);
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/fake/rate-limits" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          method?: unknown;
          retry_after_seconds?: unknown;
          times?: unknown;
          after?: unknown;
        } | null;
        const valid =
          typeof input?.method === "string" &&
          Object.hasOwn(methods, input.method) &&
          Number.isSafeInteger(input.retry_after_seconds) &&
          Number.isSafeInteger(input.times ?? 1) &&
          Number.isSafeInteger(input.after ?? 0);
        if (!valid) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        rateLimits.set(input.method as string, {
          retryAfterSeconds: input.retry_after_seconds as number,
          times: (input.times ?? 1) as number,
          after: (input.after ?? 0) as number,
        });
        return Response.json({ ok: true });
      }
      // For curl on the local stack: `bot_member` puts `app_id`'s bot in it.
      if (url.pathname === "/fake/channels" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          app_id?: unknown;
          channels?: unknown;
        } | null;
        const seeds = Array.isArray(input?.channels) ? input.channels : null;
        const appId =
          typeof input?.app_id === "string" && apps.has(input.app_id)
            ? input.app_id
            : null;
        const valid =
          seeds !== null &&
          seeds.length <= 1000 &&
          seeds.every(
            (seed) =>
              typeof seed?.name === "string" &&
              /^[a-z0-9_-]{1,80}$/.test(seed.name) &&
              (seed.bot_member === undefined || appId !== null),
          );
        if (!valid) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        const added = seedChannels(
          seeds.map((seed) => ({
            name: seed.name,
            isPrivate: seed.is_private === true,
            isArchived: seed.is_archived === true,
            members: seed.bot_member === true && appId ? [appId] : [],
          })),
        );
        return Response.json({
          ok: true,
          channels: added.map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_private: channel.isPrivate,
          })),
        });
      }
      // For curl on the local stack: `/invite` of `app_id`'s bot. The
      // member_joined_channel event is sent with /fake/events.
      if (url.pathname === "/fake/invites" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          app_id?: unknown;
          channel_id?: unknown;
        } | null;
        const appId = input?.app_id;
        const listed = conversations.find(
          (candidate) => candidate.id === input?.channel_id,
        );
        if (typeof appId !== "string" || !apps.has(appId) || !listed) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        if (!listed.members.includes(appId)) listed.members.push(appId);
        return Response.json({ ok: true, bot_user_id: `U${appId}BOT` });
      }
      // For curl on the local stack: `/remove` of `app_id`'s bot from a
      // channel. The member_left_channel event is sent with /fake/events.
      if (url.pathname === "/fake/removals" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          app_id?: unknown;
          channel_id?: unknown;
        } | null;
        const appId = input?.app_id;
        const listed = conversations.find(
          (candidate) => candidate.id === input?.channel_id,
        );
        if (typeof appId !== "string" || !apps.has(appId) || !listed) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        listed.members = listed.members.filter((member) => member !== appId);
        return Response.json({ ok: true, bot_user_id: `U${appId}BOT` });
      }
      if (url.pathname === "/fake/statuses" && request.method === "GET") {
        return Response.json({ ok: true, statuses });
      }
      if (url.pathname === "/fake/messages" && request.method === "GET") {
        return Response.json({ ok: true, messages });
      }
      if (url.pathname === "/fake/updates" && request.method === "GET") {
        return Response.json({ ok: true, updates, views, viewUpdates });
      }
      // For curl on the local stack: posts {payload} as Slack's signed
      // interactivity form, stamped with the app's id.
      if (url.pathname === "/fake/interactions" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          url?: unknown;
          app_id?: unknown;
          payload?: unknown;
        } | null;
        if (
          input === null ||
          typeof input.url !== "string" ||
          !/^https?:\/\//.test(input.url) ||
          typeof input.app_id !== "string" ||
          !apps.has(input.app_id) ||
          typeof input.payload !== "object" ||
          input.payload === null
        ) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        const app = appOf(input.app_id);
        const body = `payload=${encodeURIComponent(
          JSON.stringify({ ...input.payload, api_app_id: app.appId }),
        )}`;
        const response = await fetch(input.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...signSlackRequest(
              app.signingSecret,
              body,
              Math.floor(Date.now() / 1000),
            ),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        let answer: unknown = text;
        try {
          answer = JSON.parse(text);
        } catch {}
        return Response.json({
          ok: true,
          status: response.status,
          body: answer,
        });
      }
      // For curl on the local stack: {method} answers its next send with
      // ok:true and no ts.
      if (url.pathname === "/fake/missing-ts" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          method?: unknown;
        } | null;
        if (
          input?.method !== "chat.postMessage" &&
          input?.method !== "chat.postEphemeral"
        ) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        missingTs.add(input.method);
        return Response.json({ ok: true });
      }
      // For curl on the local stack: {method}'s next call answers `status`
      // with `body`, as text when it is a string and as JSON otherwise.
      if (url.pathname === "/fake/answers" && request.method === "POST") {
        const input = (await request.json().catch(() => null)) as {
          method?: unknown;
          status?: unknown;
          body?: unknown;
        } | null;
        if (
          typeof input?.method !== "string" ||
          !Object.hasOwn(methods, input.method) ||
          !Number.isSafeInteger(input.status) ||
          (input.status as number) < 200 ||
          (input.status as number) > 599 ||
          input.body === undefined
        ) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        nextAnswers.set(input.method, {
          status: input.status as number,
          body: input.body,
        });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/fake/config-tokens" && request.method === "POST") {
        return Response.json({ ok: true, refresh_token: issueConfigToken() });
      }
      // For curl on the local stack: the signature is made in here, from
      // the app's secret, and never leaves it.
      if (url.pathname === "/fake/events" && request.method === "POST") {
        const input = (await request.json()) as {
          url?: unknown;
          app_id?: unknown;
          event?: Record<string, unknown>;
          event_id?: string;
          team_id?: string;
          age_seconds?: number;
          retry_num?: number;
          challenge?: string;
        };
        if (
          typeof input.url !== "string" ||
          !/^https?:\/\//.test(input.url) ||
          typeof input.app_id !== "string" ||
          !apps.has(input.app_id)
        ) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        const sent = await sendEvent({
          url: input.url,
          appId: input.app_id,
          ...(input.event === undefined ? {} : { event: input.event }),
          ...(input.event_id === undefined ? {} : { eventId: input.event_id }),
          ...(input.team_id === undefined ? {} : { teamId: input.team_id }),
          ...(input.age_seconds === undefined
            ? {}
            : { ageSeconds: input.age_seconds }),
          ...(input.retry_num === undefined
            ? {}
            : { retryNum: input.retry_num }),
          ...(input.challenge === undefined
            ? {}
            : { challenge: input.challenge }),
        });
        return Response.json({
          ok: true,
          status: sent.status,
          body: sent.body,
          event_id: sent.eventId,
        });
      }
      const method = url.pathname.startsWith("/api/")
        ? url.pathname.slice("/api/".length)
        : null;
      const run = method === null ? undefined : methods[method];
      if (method === null || run === undefined) return null;
      const limited = rateLimits.get(method);
      if (limited && limited.after > 0) {
        limited.after -= 1;
      } else if (limited && limited.times > 0) {
        limited.times -= 1;
        calls.push({ method, ok: false, error: "ratelimited" });
        return Response.json(
          { ok: false, error: "ratelimited" },
          {
            status: 429,
            headers: { "Retry-After": String(limited.retryAfterSeconds) },
          },
        );
      }
      const canned = nextAnswers.get(method);
      if (canned) {
        nextAnswers.delete(method);
        calls.push({ method, ok: false, error: "fake_answer" });
        return typeof canned.body === "string"
          ? new Response(canned.body, { status: canned.status })
          : Response.json(canned.body, { status: canned.status });
      }
      const authorization = request.headers.get("authorization");
      const context: Context = {
        token: authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null,
        params: await paramsOf(request, url),
      };
      try {
        const failure = failures.get(method);
        if (failure !== undefined) throw new SlackError(failure);
        const answer = run(context);
        if (answer === null) return null;
        calls.push({ method, ok: true });
        return Response.json({ ok: true, ...answer });
      } catch (error) {
        if (!(error instanceof SlackError)) throw error;
        calls.push({ method, ok: false, error: error.code });
        // Slack answers HTTP 200 with ok:false.
        return Response.json({ ok: false, error: error.code });
      }
    },
  };
}

/** Slack's `v0` signature headers for a body, made with an app's secret. */
export function signSlackRequest(
  signingSecret: string,
  body: string,
  timestampSeconds: number,
): Record<string, string> {
  const timestamp = String(timestampSeconds);
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": signature,
  };
}

/** An `event_callback` envelope as Slack sends it. */
export function slackEventEnvelope(input: {
  appId: string;
  teamId: string;
  event: Record<string, unknown>;
  eventId?: string;
  eventTime?: number;
}) {
  return {
    token: hex(12),
    team_id: input.teamId,
    api_app_id: input.appId,
    event: input.event,
    type: "event_callback",
    event_id: input.eventId ?? `Ev${hex(6).toUpperCase()}`,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
  };
}

/** The Web API fake on its own port: `url` is what MOCK_SLACK_API_URL takes. */
export function startFakeSlackApi(
  options: Parameters<typeof createFakeSlackWebApi>[0] = {},
) {
  const api = createFakeSlackWebApi(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const answered = await api.handle(request);
      if (answered) return answered;
      return new URL(request.url).pathname === "/api/auth.test"
        ? Response.json({ ok: false, error: "invalid_auth" })
        : new Response("not found", { status: 404 });
    },
  });
  return {
    ...api,
    url: `http://127.0.0.1:${server.port}/api`,
    stop: () => server.stop(true),
  };
}
