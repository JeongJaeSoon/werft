import {
  type SlackChannel,
  type SlackUser,
  type SurfaceChannelKind,
  slackPermalinkSchema,
} from "@werft-ai/contracts";
import { z } from "zod";

// The App Configuration API calls the platform makes with a workspace's
// config token: rotating the token and creating, updating and deleting the
// apps it made. Answers are parsed with zod and errors carry only Slack's
// error code, never a body: the body of a create answer holds secrets.

export const SLACK_API_URL = "https://slack.com/api";
// Slack's answer, to an apps.manifest call, when the app it names no longer exists.
export const SLACK_APP_GONE_CODES: ReadonlySet<string> = new Set([
  "app_not_found",
  "invalid_app_id",
  "app_deleted",
]);
export const SLACK_HTTP_TIMEOUT_MS = 10_000;

/**
 * `answered`: Slack said no (`ok:false`), so nothing changed on its side.
 * Otherwise the call may or may not have taken effect: Slack was
 * unreachable, timed out or answered something unreadable.
 */
export class SlackApiError extends Error {
  /** Null when no answer came. */
  readonly httpStatus: number | null;
  readonly failure: SlackCallFailure;
  /** Slack's `errors` lines (`pointer: message`); never the rest of the body. */
  readonly details: readonly string[];

  constructor(
    readonly method: string,
    readonly code: string,
    readonly answered: boolean,
    detail: {
      httpStatus?: number;
      failure?: SlackCallFailure;
      details?: readonly string[];
    } = {},
  ) {
    super(`${method}: ${code}`);
    this.name = "SlackApiError";
    this.httpStatus = detail.httpStatus ?? null;
    this.failure = detail.failure ?? "slack_error";
    this.details = detail.details ?? [];
  }
}

/**
 * How a Slack call failed: no answer, a non-JSON answer (`http_status`), an
 * answer that does not parse, or Slack's own `error`.
 */
export type SlackCallFailure =
  | "unreachable"
  | "timeout"
  | "http_status"
  | "unexpected_answer"
  | "slack_error";

/** Used when a 429 carries no readable Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Slack answered 429: no call before `retryAfterSeconds` have passed. */
export class SlackRateLimitedError extends SlackApiError {
  constructor(
    method: string,
    readonly retryAfterSeconds: number,
  ) {
    super(method, "ratelimited", true, { httpStatus: 429 });
    this.name = "SlackRateLimitedError";
  }
}

function retryAfterOf(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RETRY_AFTER_SECONDS;
}

export type RotatedConfigToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  issuerUserId: string;
  issuerTeamId: string;
};

export type CreatedSlackApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

export interface SlackConfigApi {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(configToken: string, manifest: object): Promise<CreatedSlackApp>;
  updateApp(
    configToken: string,
    appId: string,
    manifest: object,
  ): Promise<{ permissionsUpdated: boolean }>;
  deleteApp(configToken: string, appId: string): Promise<void>;
  /** Resolves while Slack still shows the app to this token's user. */
  exportApp(configToken: string, appId: string): Promise<void>;
}

/** What `oauth.v2.access` granted, before it is checked. */
export type SlackInstallGrant = {
  botToken: string;
  appId: string;
  /** Null for an enterprise-wide install, which names no team. */
  teamId: string | null;
  enterpriseInstall: boolean;
  scopes: string[];
};

export type SlackBotIdentity = {
  teamId: string;
  botUserId: string;
  appId: string;
};

/** The calls that install an app and check the bot token it returns. */
export interface SlackInstallApi {
  exchangeInstallCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<SlackInstallGrant>;
  /** `auth.test` names the team and bot user; `bots.info` names the app. */
  botIdentity(botToken: string): Promise<SlackBotIdentity>;
}

const slackId = z.string().regex(/^[A-Z0-9]{1,64}$/);
const opaque = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

const rotateAnswer = z.object({
  token: opaque,
  refresh_token: opaque,
  team_id: slackId,
  user_id: slackId,
  exp: z.number().int().positive(),
});

const createAnswer = z.object({
  app_id: slackId,
  credentials: z.object({
    client_id: z.string().regex(/^[0-9.]{1,64}$/),
    client_secret: opaque,
    signing_secret: opaque,
  }),
});

const installAnswer = z.object({
  access_token: opaque,
  token_type: z.literal("bot"),
  scope: z.string().max(4096),
  app_id: slackId,
  team: z.object({ id: slackId }).nullish(),
  is_enterprise_install: z.boolean().optional(),
});

const authTestAnswer = z.object({
  team_id: slackId,
  user_id: slackId,
  bot_id: slackId,
});

const botsInfoAnswer = z.object({
  bot: z.object({ app_id: slackId }),
});

const updateAnswer = z.object({
  permissions_updated: z.boolean().optional(),
});

const ERROR_CODE = /^[a-z_]{1,64}$/;

export type SlackApiOptions = {
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const ERROR_LINES_MAX = 10;
const ERROR_LINE_MAX = 300;

// A manifest refusal names what is wrong in `errors: [{message, pointer}]`.
// Only those two strings are kept, bounded; the rest of the body may hold secrets.
function errorLines(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  const lines: string[] = [];
  for (const entry of errors.slice(0, ERROR_LINES_MAX)) {
    if (entry === null || typeof entry !== "object") continue;
    const { message, pointer } = entry as Record<string, unknown>;
    if (typeof message !== "string" || message === "") continue;
    const line =
      typeof pointer === "string" && pointer !== ""
        ? `${pointer}: ${message}`
        : message;
    lines.push(line.slice(0, ERROR_LINE_MAX));
  }
  return lines;
}

/** `httpStatus` when the headers came and the body broke off. */
function noAnswer(method: string, error: unknown, httpStatus?: number) {
  const failure =
    error instanceof Error && error.name === "TimeoutError"
      ? "timeout"
      : "unreachable";
  return new SlackApiError(method, failure, false, {
    failure,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

function slackCaller(options?: SlackApiOptions) {
  const apiUrl = (options?.apiUrl ?? SLACK_API_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SLACK_HTTP_TIMEOUT_MS;

  return async function call<T>(
    method: string,
    init: { token?: string; body: URLSearchParams | object },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const json = !(init.body instanceof URLSearchParams);
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/${method}`, {
        method: "POST",
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          "Content-Type": json
            ? "application/json; charset=utf-8"
            : "application/x-www-form-urlencoded",
        },
        body: json ? JSON.stringify(init.body) : init.body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw noAnswer(method, error);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new SlackRateLimitedError(method, retryAfterOf(response));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw noAnswer(method, error, response.status);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (body === null || typeof body !== "object") {
      throw new SlackApiError(method, `http_${response.status}`, false, {
        httpStatus: response.status,
        failure: "http_status",
      });
    }
    if (body.ok !== true) {
      // A 5xx with ok:false still leaves doubt about what Slack did.
      const answered = response.status < 500;
      const named =
        typeof body.error === "string" && ERROR_CODE.test(body.error);
      throw new SlackApiError(
        method,
        named ? (body.error as string) : `http_${response.status}`,
        answered,
        {
          httpStatus: response.status,
          failure: named ? "slack_error" : "http_status",
          details: named ? errorLines(body.errors) : [],
        },
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new SlackApiError(method, "unexpected_answer", false, {
        httpStatus: response.status,
        failure: "unexpected_answer",
      });
    }
    return parsed.data;
  };
}

// A send answers whatever Slack said, for the caller to classify; only a
// missing answer throws, since Slack may then hold the message.
function slackSender(options?: SlackApiOptions) {
  const apiUrl = (options?.apiUrl ?? SLACK_API_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SLACK_HTTP_TIMEOUT_MS;

  return async function send(
    method: string,
    botToken: string,
    body: Record<string, unknown>,
  ): Promise<SlackSendResponse> {
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw noAnswer(method, error);
    }
    // A body that breaks off mid-read is no body: the status and Retry-After
    // already came, and the caller judges what they leave known.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {}
    return {
      httpStatus: response.status,
      retryAfterHeader: response.headers.get("retry-after"),
      body: parsed,
    };
  };
}

export function createSlackConfigApi(
  options?: SlackApiOptions,
): SlackConfigApi & SlackInstallApi {
  const call = slackCaller(options);
  return {
    async rotateConfigToken(refreshToken) {
      const answer = await call(
        "tooling.tokens.rotate",
        { body: new URLSearchParams({ refresh_token: refreshToken }) },
        rotateAnswer,
      );
      return {
        accessToken: answer.token,
        refreshToken: answer.refresh_token,
        expiresAt: new Date(answer.exp * 1000),
        issuerUserId: answer.user_id,
        issuerTeamId: answer.team_id,
      };
    },

    async createApp(configToken, manifest) {
      const answer = await call(
        "apps.manifest.create",
        { token: configToken, body: { manifest: JSON.stringify(manifest) } },
        createAnswer,
      );
      return {
        appId: answer.app_id,
        clientId: answer.credentials.client_id,
        clientSecret: answer.credentials.client_secret,
        signingSecret: answer.credentials.signing_secret,
      };
    },

    async updateApp(configToken, appId, manifest) {
      const answer = await call(
        "apps.manifest.update",
        {
          token: configToken,
          body: { app_id: appId, manifest: JSON.stringify(manifest) },
        },
        updateAnswer,
      );
      return { permissionsUpdated: answer.permissions_updated === true };
    },

    async deleteApp(configToken, appId) {
      await call(
        "apps.manifest.delete",
        { token: configToken, body: { app_id: appId } },
        z.object({}),
      );
    },

    async exportApp(configToken, appId) {
      await call(
        "apps.manifest.export",
        { token: configToken, body: { app_id: appId } },
        z.object({}),
      );
    },

    async exchangeInstallCode(input) {
      const answer = await call(
        "oauth.v2.access",
        {
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
          }),
        },
        installAnswer,
      );
      return {
        botToken: answer.access_token,
        appId: answer.app_id,
        teamId: answer.team?.id ?? null,
        enterpriseInstall: answer.is_enterprise_install === true,
        scopes: answer.scope.split(",").filter((scope) => scope.length > 0),
      };
    },

    async botIdentity(botToken) {
      const auth = await call(
        "auth.test",
        { token: botToken, body: new URLSearchParams() },
        authTestAnswer,
      );
      const info = await call(
        "bots.info",
        { token: botToken, body: new URLSearchParams({ bot: auth.bot_id }) },
        botsInfoAnswer,
      );
      return {
        teamId: auth.team_id,
        botUserId: auth.user_id,
        appId: info.bot.app_id,
      };
    },
  };
}

/** The progress line under a thread's last message. */
export const SLACK_SET_STATUS_METHOD = "agents.sessions.setStatus";

/** Slack advises no more than 200 per page. */
export const SLACK_CHANNEL_PAGE_SIZE = 200;

export type SlackChannelPage = {
  channels: SlackChannel[];
  nextCursor: string | null;
};

export type SlackChannelMembership = {
  kind: SurfaceChannelKind;
  isMember: boolean;
  isArchived: boolean;
};

/** The calls a bot token makes about the people and places it hears from. */
export interface SlackBotApi {
  channelInfo?(
    botToken: string,
    channelId: string,
  ): Promise<{ id: string; name: string }>;
  /** `users.info`: the flags that tell a member from a guest or a stranger. */
  userInfo(botToken: string, userId: string): Promise<SlackUser>;
  /** `conversations.info`, read for whether the bot is in the channel. */
  channelMembership(
    botToken: string,
    channelId: string,
  ): Promise<SlackChannelMembership>;
  /** `conversations.join` (`channels:join`): public channels only. */
  joinChannel(botToken: string, channelId: string): Promise<void>;
  /** `conversations.info`: what kind of place the channel is. */
  channelKind(botToken: string, channelId: string): Promise<SurfaceChannelKind>;
  /**
   * `conversations.list`: one page of the public channels and the private
   * ones the bot is in. Slack's Tier 2 (20+ per minute).
   */
  listChannels(
    botToken: string,
    cursor: string | null,
  ): Promise<SlackChannelPage>;
  setStatus(
    botToken: string,
    input: { channelId: string; threadTs: string; status: string },
  ): Promise<void>;
  /** `chat.getPermalink`, which needs no scope. */
  permalink(
    botToken: string,
    input: { channelId: string; ts: string },
  ): Promise<string>;
  /** `chat.update` of a message the bot posted: new text and blocks. */
  updateMessage?(
    botToken: string,
    input: { channelId: string; ts: string; text: string; blocks: unknown[] },
  ): Promise<void>;
  /** `views.open` with the `trigger_id` of a press made seconds ago. */
  openView?(
    botToken: string,
    input: { triggerId: string; view: Record<string, unknown> },
  ): Promise<{ viewId: string }>;
  /** `views.update` of a modal this app opened. */
  updateView?(
    botToken: string,
    input: { viewId: string; view: Record<string, unknown> },
  ): Promise<void>;
}

/** What the outbox sends with a bot token. */
export interface SlackBotSender {
  /**
   * `chat.postMessage` into a thread (the channel itself when `threadTs`
   * is ""), as Kollegium sends it: no
   * `@name` linking, no unfurls. Answers what Slack said, whatever it was;
   * throws `SlackApiError` only when no answer came. `username` and
   * `iconUrl` show the message as someone else's; Slack applies them only
   * with `chat:write.customize`.
   */
  postMessage(
    botToken: string,
    input: {
      channelId: string;
      threadTs: string;
      text: string;
      username?: string;
      iconUrl?: string;
      /** Block Kit; `text` stays the notification and fallback. */
      blocks?: unknown[];
    },
  ): Promise<SlackSendResponse>;
  /** `users.info`'s 48px profile image; null when Slack names none. */
  userImage(botToken: string, userId: string): Promise<string | null>;
  /** `chat.postEphemeral`; Slack's `message_ts` comes back as `ts`. */
  postEphemeral(
    botToken: string,
    input: {
      channelId: string;
      userId: string;
      threadTs: string;
      text: string;
    },
  ): Promise<SlackSendResponse>;
}

/** Slack's answer to a send, for `classifySlackSendResult`. */
export type SlackSendResponse = {
  httpStatus: number;
  retryAfterHeader: string | null;
  /** The parsed JSON body, or null when there was none or it did not parse. */
  body: unknown;
};

const userImageAnswer = z.object({
  user: z.object({
    profile: z.object({ image_48: z.url().optional() }).optional(),
  }),
});

const userInfoAnswer = z.object({
  user: z.object({
    id: slackId,
    team_id: slackId,
    is_restricted: z.boolean().optional(),
    is_ultra_restricted: z.boolean().optional(),
    is_stranger: z.boolean().optional(),
  }),
});

const conversationInfoAnswer = z.object({
  channel: z.object({
    is_im: z.boolean().optional(),
    is_mpim: z.boolean().optional(),
    is_private: z.boolean().optional(),
    is_member: z.boolean().optional(),
    is_archived: z.boolean().optional(),
  }),
});

const namedConversationAnswer = z.object({
  channel: z.object({ id: slackId, name: z.string().min(1).max(255) }),
});

const permalinkAnswer = z.object({ permalink: slackPermalinkSchema });

const listChannelsAnswer = z.object({
  channels: z.array(
    z.object({
      id: slackId,
      name: z.string().min(1).max(255),
      is_private: z.boolean().default(false),
      is_member: z.boolean().default(false),
      is_archived: z.boolean().default(false),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().max(4096).optional() })
    .optional(),
});

export function createSlackBotApi(
  options?: SlackApiOptions,
): SlackBotApi &
  Required<Pick<SlackBotApi, "updateMessage" | "openView" | "updateView">> &
  SlackBotSender {
  const call = slackCaller(options);
  const send = slackSender(options);
  return {
    async userInfo(botToken, userId) {
      const { user } = await call(
        "users.info",
        { token: botToken, body: new URLSearchParams({ user: userId }) },
        userInfoAnswer,
      );
      return {
        id: user.id,
        team_id: user.team_id,
        ...(user.is_restricted === undefined
          ? {}
          : { is_restricted: user.is_restricted }),
        ...(user.is_ultra_restricted === undefined
          ? {}
          : { is_ultra_restricted: user.is_ultra_restricted }),
        ...(user.is_stranger === undefined
          ? {}
          : { is_stranger: user.is_stranger }),
      };
    },

    async channelInfo(botToken, channelId) {
      const { channel } = await call(
        "conversations.info",
        { token: botToken, body: new URLSearchParams({ channel: channelId }) },
        namedConversationAnswer,
      );
      return channel;
    },

    async channelKind(botToken, channelId) {
      const { channel } = await call(
        "conversations.info",
        { token: botToken, body: new URLSearchParams({ channel: channelId }) },
        conversationInfoAnswer,
      );
      if (channel.is_im) return "dm";
      return channel.is_private || channel.is_mpim
        ? "private_channel"
        : "public_channel";
    },

    async channelMembership(botToken, channelId) {
      const { channel } = await call(
        "conversations.info",
        { token: botToken, body: new URLSearchParams({ channel: channelId }) },
        conversationInfoAnswer,
      );
      return {
        kind: channel.is_im
          ? "dm"
          : channel.is_private || channel.is_mpim
            ? "private_channel"
            : "public_channel",
        isMember: channel.is_member ?? false,
        isArchived: channel.is_archived ?? false,
      };
    },

    async joinChannel(botToken, channelId) {
      await call(
        "conversations.join",
        { token: botToken, body: new URLSearchParams({ channel: channelId }) },
        z.object({}),
      );
    },

    async listChannels(botToken, cursor) {
      const answer = await call(
        "conversations.list",
        {
          token: botToken,
          body: new URLSearchParams({
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: String(SLACK_CHANNEL_PAGE_SIZE),
            ...(cursor === null ? {} : { cursor }),
          }),
        },
        listChannelsAnswer,
      );
      return {
        channels: answer.channels
          .filter((channel) => !channel.is_archived)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_private: channel.is_private,
            is_member: channel.is_member,
          })),
        nextCursor: answer.response_metadata?.next_cursor || null,
      };
    },

    async setStatus(botToken, input) {
      await call(
        SLACK_SET_STATUS_METHOD,
        {
          token: botToken,
          body: {
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            status: input.status,
          },
        },
        z.object({}),
      );
    },

    async permalink(botToken, input) {
      const answer = await call(
        "chat.getPermalink",
        {
          token: botToken,
          body: new URLSearchParams({
            channel: input.channelId,
            message_ts: input.ts,
          }),
        },
        permalinkAnswer,
      );
      return answer.permalink;
    },

    async updateMessage(botToken, input) {
      await call(
        "chat.update",
        {
          token: botToken,
          body: {
            channel: input.channelId,
            ts: input.ts,
            text: input.text,
            blocks: input.blocks,
          },
        },
        z.object({}),
      );
    },

    async openView(botToken, input) {
      const { view } = await call(
        "views.open",
        {
          token: botToken,
          body: { trigger_id: input.triggerId, view: input.view },
        },
        z.object({ view: z.object({ id: z.string().min(1) }) }),
      );
      return { viewId: view.id };
    },

    async updateView(botToken, input) {
      await call(
        "views.update",
        { token: botToken, body: { view_id: input.viewId, view: input.view } },
        z.object({}),
      );
    },

    postMessage(botToken, input) {
      return send("chat.postMessage", botToken, {
        channel: input.channelId,
        ...(input.threadTs === "" ? {} : { thread_ts: input.threadTs }),
        text: input.text,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.iconUrl === undefined ? {} : { icon_url: input.iconUrl }),
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      });
    },

    async userImage(botToken, userId) {
      const { user } = await call(
        "users.info",
        { token: botToken, body: new URLSearchParams({ user: userId }) },
        userImageAnswer,
      );
      return user.profile?.image_48 ?? null;
    },

    async postEphemeral(botToken, input) {
      const answer = await send("chat.postEphemeral", botToken, {
        channel: input.channelId,
        user: input.userId,
        thread_ts: input.threadTs,
        text: input.text,
        link_names: false,
      });
      const body = answer.body as Record<string, unknown> | null;
      return body !== null && typeof body === "object" && "message_ts" in body
        ? { ...answer, body: { ...body, ts: body.message_ts } }
        : answer;
    },
  };
}
