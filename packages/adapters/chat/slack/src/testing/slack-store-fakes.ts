/**
 * In-memory stand-ins for the Slack app stores and the App Configuration
 * API, for unit and route tests. They keep the stores' contracts (the lease,
 * `creating` before the call, secrets sealed with the record) so a test of
 * the service exercises the same outcomes the Postgres stores give.
 */
import { randomBytes } from "node:crypto";
import {
  BOT_SCOPES,
  type SlackAppSecretPurpose,
  type SlackInboundDropReason,
  type SlackInboundEventStatus,
} from "@werft-ai/contracts";
import {
  type AgentIdentityRecord,
  type AgentIdentityStore,
  type ConfigTokenSummary,
  type CreatedSlackApp,
  lastFour,
  type RotatedConfigToken,
  type SecretAudit,
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  type SlackAppAgent,
  type SlackAppRecord,
  type SlackAppStore,
  type SlackConfigTokenStore,
  type SlackInboundClaim,
  type SlackInboundEventInput,
  type SlackInboundEventStore,
  type SlackInboundFence,
  type SlackInstallState,
  type SlackInstallStore,
  secretOwnerRef,
} from "@werft-ai/platform";
import {
  SlackApiError,
  type SlackConfigApi,
  type SlackInstallApi,
  type SlackInstallGrant,
} from "../slack-config-api.ts";

/** Token-shaped values are made per run, never written into a file. */
export function fakeSlackValue(prefix: string): string {
  return `${prefix}-${randomBytes(20).toString("hex")}`;
}

const STAMP = new Date("2026-10-23T00:00:00.000Z");

export function createMemorySecretStore() {
  const values = new Map<string, { value: string; summary: SecretSummary }>();
  const receipts: { id: string; purpose: string; last4: string }[] = [];
  const slotKey = (slot: SecretSlot) =>
    `${slot.workspaceId}|${secretOwnerRef(slot.owner)}|${slot.purpose}`;
  const write = (slot: SecretSlot, value: string, audit?: SecretAudit) => {
    const previous = values.get(slotKey(slot));
    const summary: SecretSummary = {
      last4: lastFour(value),
      secretVersion: (previous?.summary.secretVersion ?? 0) + 1,
      updatedAt: STAMP,
      updatedBy: audit
        ? { userId: audit.principal.actor?.userId ?? "", displayName: "Owner" }
        : null,
    };
    values.set(slotKey(slot), { value, summary });
    if (audit) {
      receipts.push({
        id: audit.receiptId,
        purpose: slot.purpose,
        last4: summary.last4,
      });
    }
    return summary;
  };
  const store: SecretStore = {
    describe: async (slot) => values.get(slotKey(slot))?.summary ?? null,
    get: async (slot) => values.get(slotKey(slot))?.value ?? null,
    put: async (slot, value, options) => ({
      outcome: "stored",
      summary: write(slot, value, options?.audit),
    }),
    delete: async (slot, options) => {
      const previous = values.get(slotKey(slot));
      if (!previous) return { outcome: "not_found" };
      values.delete(slotKey(slot));
      if (options?.audit) {
        receipts.push({
          id: options.audit.receiptId,
          purpose: slot.purpose,
          last4: previous.summary.last4,
        });
      }
      return { outcome: "deleted", last4: previous.summary.last4 };
    },
  };
  return { store, values, receipts, write, slotKey };
}

export type MemorySecrets = ReturnType<typeof createMemorySecretStore>;

type TokenMeta = {
  state: "active" | "needs_reentry";
  accessExpiresAt: Date | null;
  issuerUserId: string | null;
  issuerTeamId: string | null;
  lease: { id: string; until: Date } | null;
};

const configSlot = (workspaceId: string): SecretSlot => ({
  workspaceId,
  owner: { kind: "workspace" },
  purpose: "slack_config_token",
});

/** Sealed as one value, as the Postgres store does. */
export const encodeConfigTokenPair = (access: string, refresh: string) =>
  `${access}\n${refresh}`;

export function createMemoryConfigTokenStore(secrets: MemorySecrets) {
  const meta = new Map<string, TokenMeta>();
  /** Throw from `complete` this many more times. */
  const faults = { complete: 0 };
  const pair = (workspaceId: string) => {
    const raw = secrets.values.get(secrets.slotKey(configSlot(workspaceId)));
    if (!raw) return null;
    const [access_token = "", refresh_token = ""] = raw.value.split("\n");
    return { access_token, refresh_token };
  };
  const summaryOf = (workspaceId: string): ConfigTokenSummary => {
    const row = meta.get(workspaceId);
    const secret =
      secrets.values.get(secrets.slotKey(configSlot(workspaceId)))?.summary ??
      null;
    if (!row || (row.issuerUserId === null && secret === null)) {
      return { state: "unset", secret: null, expiresAt: null, issuer: null };
    }
    return {
      state: row.state,
      secret,
      expiresAt: row?.state === "active" ? row.accessExpiresAt : null,
      issuer:
        row?.state === "active" && row.issuerUserId && row.issuerTeamId
          ? { userId: row.issuerUserId, teamId: row.issuerTeamId }
          : null,
    };
  };
  const invalidate = (workspaceId: string) => {
    const row = meta.get(workspaceId);
    if (row) Object.assign(row, { state: "needs_reentry", lease: null });
    secrets.values.delete(secrets.slotKey(configSlot(workspaceId)));
  };

  const store: SlackConfigTokenStore = {
    async claim(workspaceId, clock) {
      const row = meta.get(workspaceId);
      if (!row) return { outcome: "not_set" };
      if (row.state === "needs_reentry") return { outcome: "needs_reentry" };
      const current = pair(workspaceId);
      if (!current) return { outcome: "not_set" };
      if (
        row.accessExpiresAt !== null &&
        row.issuerUserId !== null &&
        row.accessExpiresAt > clock.freshUntil
      ) {
        return {
          outcome: "fresh",
          accessToken: current.access_token,
          issuerUserId: row.issuerUserId,
        };
      }
      if (row.lease !== null) {
        if (row.lease.until > clock.now) {
          return { outcome: "busy", until: row.lease.until };
        }
        invalidate(workspaceId);
        return { outcome: "needs_reentry" };
      }
      row.lease = { id: crypto.randomUUID(), until: clock.leaseUntil };
      return {
        outcome: "claimed",
        leaseId: row.lease.id,
        refreshToken: current.refresh_token,
      };
    },
    async claimForReplace(workspaceId, clock) {
      const row = meta.get(workspaceId) ?? {
        state: "needs_reentry",
        accessExpiresAt: null,
        issuerUserId: null,
        issuerTeamId: null,
        lease: null,
      };
      meta.set(workspaceId, row);
      if (row.lease !== null && row.lease.until > clock.now) {
        return { outcome: "busy", until: row.lease.until };
      }
      row.lease = { id: crypto.randomUUID(), until: clock.leaseUntil };
      return { outcome: "claimed", leaseId: row.lease.id };
    },
    async complete(workspaceId, leaseId, rotated, audit) {
      if (faults.complete > 0) {
        faults.complete -= 1;
        throw new Error("injected write failure");
      }
      const row = meta.get(workspaceId);
      if (!row || row.lease?.id !== leaseId) return { outcome: "lease_lost" };
      const previous = row.issuerUserId;
      secrets.write(
        configSlot(workspaceId),
        encodeConfigTokenPair(rotated.accessToken, rotated.refreshToken),
        audit,
      );
      Object.assign(row, {
        state: "active",
        accessExpiresAt: rotated.expiresAt,
        issuerUserId: rotated.issuerUserId,
        issuerTeamId: rotated.issuerTeamId,
        lease: null,
      });
      return {
        outcome: "stored",
        summary: summaryOf(workspaceId),
        previousIssuerUserId:
          previous !== null && previous !== rotated.issuerUserId
            ? previous
            : null,
      };
    },
    async release(workspaceId, leaseId) {
      const row = meta.get(workspaceId);
      if (row?.lease?.id === leaseId) row.lease = null;
    },
    async invalidate(workspaceId, leaseId) {
      const row = meta.get(workspaceId);
      if (leaseId !== null && row?.lease?.id !== leaseId) return;
      invalidate(workspaceId);
    },
    async expireAccess(workspaceId, now) {
      const row = meta.get(workspaceId);
      if (row) row.accessExpiresAt = now;
    },
    describe: async (workspaceId) => summaryOf(workspaceId),
    async delete(workspaceId, audit) {
      meta.delete(workspaceId);
      return secrets.store.delete(configSlot(workspaceId), { audit });
    },
  };
  return { store, meta, faults, pair };
}

export function createMemorySlackAppStore(input: {
  secrets: MemorySecrets;
  agents: Map<string, SlackAppAgent & { workspaceId: string; active: boolean }>;
  /** Workspace names by id, for link apps. */
  workspaces?: Map<string, string>;
  now?: () => Date;
}) {
  const clock = input.now ?? (() => new Date());
  const rows = new Map<string, Omit<SlackAppRecord, "secrets">>();
  const settings = new Map<
    string,
    Parameters<SlackAppStore["putSettings"]>[0]["settings"]
  >();
  const faults = { finishCreate: 0 };
  const LIVE = new Set(["creating", "created", "deleting"]);
  const PURPOSES: SlackAppSecretPurpose[] = [
    "slack_signing_secret",
    "slack_client_secret",
    "slack_bot_token",
  ];
  const slot = (row: { workspaceId: string; id: string }, purpose: string) =>
    ({
      workspaceId: row.workspaceId,
      owner: { kind: "slack_app", id: row.id },
      purpose,
    }) as SecretSlot;
  const record = (row: Omit<SlackAppRecord, "secrets">): SlackAppRecord => ({
    ...row,
    secrets: Object.fromEntries(
      PURPOSES.map((purpose) => [
        purpose,
        input.secrets.values.get(input.secrets.slotKey(slot(row, purpose)))
          ?.summary ?? null,
      ]),
    ) as SlackAppRecord["secrets"],
  });
  const live = (workspaceId: string, agentId: string) =>
    [...rows.values()].find(
      (row) =>
        row.workspaceId === workspaceId &&
        row.agentId === agentId &&
        LIVE.has(row.state),
    );
  const touch = (row: Omit<SlackAppRecord, "secrets">, patch: object) =>
    Object.assign(row, patch, { updatedAt: clock() });

  const store: SlackAppStore = {
    async setEvents(workspaceId, slackAppId, events) {
      const row = rows.get(slackAppId);
      if (row?.workspaceId === workspaceId)
        touch(row, { events: { ...events, url: row.events?.url ?? null } });
    },
    async registerEventsUrl(workspaceId, slackAppId, url, checkedAt) {
      const row = rows.get(slackAppId);
      if (row?.workspaceId !== workspaceId || row.state !== "created") return;
      const events = row.events;
      const kept =
        events?.state === "verified" &&
        (events.url === null || events.url === url);
      touch(row, {
        events: kept
          ? { ...events, url }
          : { state: "pending", checked_at: checkedAt, url },
      });
    },
    async setEventsUnlessVerified(workspaceId, slackAppId, events) {
      const row = rows.get(slackAppId);
      if (
        row?.workspaceId === workspaceId &&
        row.state === "created" &&
        row.events?.state !== "verified"
      ) {
        touch(row, { events: { ...events, url: row.events?.url ?? null } });
      }
    },
    async getSettings(workspaceId, agentId) {
      const agent = input.agents.get(agentId);
      if (agent?.workspaceId !== workspaceId) return null;
      return settings.get(agentId) ?? { mention_only: true };
    },
    async putSettings(change) {
      const agent = input.agents.get(change.agentId);
      if (agent?.workspaceId !== change.workspaceId) return "not_found";
      settings.set(change.agentId, change.settings);
      return "saved";
    },
    async beginAgentApp(begin) {
      const agent = input.agents.get(begin.agentId);
      if (!agent || agent.workspaceId !== begin.workspaceId) {
        return { outcome: "agent_not_found" };
      }
      const existing = live(begin.workspaceId, begin.agentId);
      if (existing?.state === "created" || existing?.state === "deleting") {
        return { outcome: "exists", app: record(existing) };
      }
      if (existing?.state === "creating") {
        const uncertain = existing.createdAt < begin.staleBefore;
        if (!(uncertain && begin.replaceUncertain)) {
          return { outcome: "creating", app: record(existing), uncertain };
        }
        touch(existing, { state: "abandoned" });
      }
      if (!agent.active) return { outcome: "agent_not_active" };
      const now = clock();
      const row = {
        id: begin.newId,
        workspaceId: begin.workspaceId,
        kind: "agent" as const,
        agentId: begin.agentId,
        state: "creating" as const,
        appId: null,
        clientId: null,
        redirectUrl: begin.redirectUrl,
        createdByTokenUser: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return { outcome: "begun", app: record(row), agent };
    },
    async beginLinkApp(begin) {
      const workspaceName = input.workspaces?.get(begin.workspaceId);
      if (workspaceName === undefined) {
        return { outcome: "workspace_not_found" };
      }
      const existing = [...rows.values()].find(
        (row) =>
          row.workspaceId === begin.workspaceId &&
          row.kind === "link" &&
          LIVE.has(row.state),
      );
      if (existing?.state === "created" || existing?.state === "deleting") {
        return { outcome: "exists", app: record(existing) };
      }
      if (existing?.state === "creating") {
        const uncertain = existing.createdAt < begin.staleBefore;
        if (!(uncertain && begin.replaceUncertain)) {
          return { outcome: "creating", app: record(existing), uncertain };
        }
        touch(existing, { state: "abandoned" });
      }
      const now = clock();
      const row = {
        id: begin.newId,
        workspaceId: begin.workspaceId,
        kind: "link" as const,
        agentId: null,
        state: "creating" as const,
        appId: null,
        clientId: null,
        redirectUrl: begin.redirectUrl,
        createdByTokenUser: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return { outcome: "begun", app: record(row), workspaceName };
    },
    async finishCreate(finish) {
      if (faults.finishCreate > 0) {
        faults.finishCreate -= 1;
        throw new Error("injected write failure");
      }
      const row = rows.get(finish.slackAppId);
      if (!row) throw new Error("no such Slack app");
      input.secrets.write(
        slot(row, "slack_signing_secret"),
        finish.created.signingSecret,
      );
      input.secrets.write(
        slot(row, "slack_client_secret"),
        finish.created.clientSecret,
      );
      touch(row, {
        state: "created",
        appId: finish.created.appId,
        clientId: finish.created.clientId,
        createdByTokenUser: finish.tokenUserId,
      });
      return record(row);
    },
    async storeBotToken({ workspaceId, slackAppId, botToken }) {
      const row = rows.get(slackAppId);
      if (!row || row.workspaceId !== workspaceId || row.state !== "created") {
        return null;
      }
      input.secrets.write(slot(row, "slack_bot_token"), botToken);
      touch(row, {});
      return record(row);
    },
    async failCreate(_workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      if (row?.state === "creating") touch(row, { state: "failed" });
    },
    async find(workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      return row && row.workspaceId === workspaceId ? record(row) : null;
    },
    async findAgentApp(agentId) {
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.agentId === agentId &&
          candidate.state === "created",
      );
      return row ? record(row) : null;
    },
    async manifestAgent(workspaceId, agentId) {
      const agent = input.agents.get(agentId);
      if (!agent || agent.workspaceId !== workspaceId) return null;
      return {
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        role: agent.role,
      };
    },
    async findForAgent(workspaceId, agentId) {
      const row = live(workspaceId, agentId);
      return row ? record(row) : null;
    },
    async linkAppClient(workspaceId) {
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.kind === "link" &&
          candidate.state === "created",
      );
      const clientSecret = row
        ? input.secrets.values.get(
            input.secrets.slotKey(slot(row, "slack_client_secret")),
          )?.value
        : undefined;
      return row && clientSecret !== undefined
        ? { app: record(row), clientSecret }
        : null;
    },
    async listMade(workspaceId) {
      // No identities here: a stored bot token stands for an install.
      const made = [...rows.values()]
        .filter(
          (row) =>
            row.workspaceId === workspaceId &&
            row.kind !== "manual" &&
            LIVE.has(row.state),
        )
        .map((row) => {
          const app = record(row);
          const agent = row.agentId ? input.agents.get(row.agentId) : undefined;
          return {
            app,
            agent: agent
              ? {
                  id: agent.id,
                  name: agent.name,
                  slug: agent.slug,
                  installed: app.secrets.slack_bot_token !== null,
                }
              : null,
          };
        });
      return made.sort(
        (a, b) =>
          Number(a.app.kind === "agent") - Number(b.app.kind === "agent") ||
          (a.agent?.name ?? "").localeCompare(b.agent?.name ?? "") ||
          a.app.createdAt.getTime() - b.app.createdAt.getTime(),
      );
    },
    async lastTokenUser(workspaceId) {
      const made = [...rows.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .filter((row) => row.createdByTokenUser !== null)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return made[0]?.createdByTokenUser ?? null;
    },
    async beginDelete({ workspaceId, slackAppId }) {
      const row = rows.get(slackAppId);
      if (!row || row.workspaceId !== workspaceId) {
        return { outcome: "not_found" };
      }
      if (row.state === "creating") {
        return { outcome: "creating", app: record(row) };
      }
      if (row.state !== "created" && row.state !== "deleting") {
        return { outcome: "settled", app: record(row) };
      }
      touch(row, { state: "deleting" });
      return { outcome: "begun", app: record(row) };
    },
    async finishDelete(workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      if (!row || row.workspaceId !== workspaceId) {
        throw new Error("no such Slack app");
      }
      for (const purpose of PURPOSES) {
        input.secrets.values.delete(input.secrets.slotKey(slot(row, purpose)));
      }
      touch(row, { state: "deleted" });
      return record(row);
    },
  };

  /** A row as a test needs it, e.g. a manual app. */
  function seed(row: Omit<SlackAppRecord, "secrets">) {
    rows.set(row.id, row);
  }
  return { store, rows, faults, seed };
}

type Behaviour<T> = (() => Promise<T>) | undefined;

/**
 * A Slack that answers the App Configuration API from memory. Each refresh
 * token is single-use, as Slack's are believed to be.
 */
export function createFakeSlackConfigApi(options?: {
  userId?: string;
  teamId?: string;
  now?: () => Date;
  /** Slack app ids are unique everywhere; fakes sharing a database differ here. */
  appIdPrefix?: string;
}) {
  const now = options?.now ?? (() => new Date());
  const appIdPrefix = options?.appIdPrefix ?? "A0FAKE";
  const state = {
    userId: options?.userId ?? "U0ISSUER",
    teamId: options?.teamId ?? "T0FAKE",
    /** Refresh tokens Slack will take, each once. */
    refreshTokens: new Set<string>(),
    accessTokens: new Set<string>(),
    apps: new Map<string, { manifest: object; clientId: string }>(),
    calls: [] as { method: string; appId?: string }[],
    /** What apps.manifest.update answers, as when a scope was added. */
    permissionsUpdated: false,
    /** Replace one call's outcome, e.g. to throw a lost answer. */
    next: {} as {
      rotate?: Behaviour<RotatedConfigToken>;
      create?: Behaviour<CreatedSlackApp>;
      delete?: Behaviour<void>;
      export?: Behaviour<void>;
    },
  };
  let appCounter = 0;
  const issueRefresh = () => {
    const refresh = fakeSlackValue("xoxe-1");
    state.refreshTokens.add(refresh);
    return refresh;
  };
  const requireAccess = (method: string, token: string) => {
    if (!state.accessTokens.has(token)) {
      throw new SlackApiError(method, "invalid_auth", true);
    }
  };

  const api: SlackConfigApi & SlackInstallApi = {
    async rotateConfigToken(refreshToken) {
      state.calls.push({ method: "tooling.tokens.rotate" });
      const behaviour = state.next.rotate;
      if (behaviour) {
        state.next.rotate = undefined;
        return behaviour();
      }
      if (!state.refreshTokens.delete(refreshToken)) {
        throw new SlackApiError(
          "tooling.tokens.rotate",
          "invalid_refresh_token",
          true,
        );
      }
      const accessToken = fakeSlackValue("xoxe.xoxp-1");
      state.accessTokens.add(accessToken);
      return {
        accessToken,
        refreshToken: issueRefresh(),
        expiresAt: new Date(now().getTime() + 12 * 3600_000),
        issuerUserId: state.userId,
        issuerTeamId: state.teamId,
      };
    },
    async createApp(token, manifest) {
      state.calls.push({ method: "apps.manifest.create" });
      requireAccess("apps.manifest.create", token);
      const behaviour = state.next.create;
      if (behaviour) {
        state.next.create = undefined;
        return behaviour();
      }
      appCounter += 1;
      const appId = `${appIdPrefix}${appCounter}`;
      const clientId = `1000.${appCounter}`;
      state.apps.set(appId, { manifest, clientId });
      return {
        appId,
        clientId,
        clientSecret: fakeSlackValue("client"),
        signingSecret: fakeSlackValue("signing"),
      };
    },
    async updateApp(token, appId, manifest) {
      state.calls.push({ method: "apps.manifest.update", appId });
      requireAccess("apps.manifest.update", token);
      const app = state.apps.get(appId);
      if (!app) {
        throw new SlackApiError("apps.manifest.update", "app_not_found", true);
      }
      app.manifest = manifest;
      return { permissionsUpdated: state.permissionsUpdated };
    },
    async deleteApp(token, appId) {
      state.calls.push({ method: "apps.manifest.delete", appId });
      requireAccess("apps.manifest.delete", token);
      const behaviour = state.next.delete;
      if (behaviour) {
        state.next.delete = undefined;
        return behaviour();
      }
      if (!state.apps.delete(appId)) {
        throw new SlackApiError("apps.manifest.delete", "app_not_found", true);
      }
    },
    async exportApp(token, appId) {
      state.calls.push({ method: "apps.manifest.export", appId });
      requireAccess("apps.manifest.export", token);
      const behaviour = state.next.export;
      if (behaviour) {
        state.next.export = undefined;
        return behaviour();
      }
      if (!state.apps.has(appId)) {
        throw new SlackApiError("apps.manifest.export", "app_not_found", true);
      }
    },
    async exchangeInstallCode(input) {
      state.calls.push({ method: "oauth.v2.access" });
      const pending = install.codes.get(input.code);
      install.codes.delete(input.code);
      const app = pending && state.apps.get(pending.appId);
      if (!pending || !app) {
        throw new SlackApiError("oauth.v2.access", "invalid_code", true);
      }
      if (
        input.clientId !== app.clientId ||
        input.redirectUri !== pending.redirectUri
      ) {
        throw new SlackApiError("oauth.v2.access", "bad_redirect_uri", true);
      }
      const behaviour = install.next.exchange;
      if (behaviour) {
        install.next.exchange = undefined;
        return behaviour();
      }
      const botToken = fakeSlackValue("xoxb");
      install.botTokens.set(botToken, pending.appId);
      return install.grant({
        botToken,
        appId: pending.appId,
        teamId: state.teamId,
        enterpriseInstall: false,
        scopes: [...BOT_SCOPES],
      });
    },
    async botIdentity(botToken) {
      state.calls.push({ method: "auth.test" });
      const appId = install.botTokens.get(botToken);
      if (appId === undefined) {
        throw new SlackApiError("auth.test", "invalid_auth", true);
      }
      state.calls.push({ method: "bots.info" });
      return { teamId: state.teamId, botUserId: `U${appId}BOT`, appId };
    },
  };

  const install = {
    codes: new Map<string, { appId: string; redirectUri: string }>(),
    /** Bot token to the app it was issued for. */
    botTokens: new Map<string, string>(),
    /** Rewrites each grant before it is returned, e.g. to drop a scope. */
    grant: (grant: SlackInstallGrant) => grant,
    next: {} as { exchange?: Behaviour<SlackInstallGrant> },
  };

  /** Follows an authorize URL as an approving admin would. */
  function authorize(authorizeUrl: string) {
    const query = new URL(authorizeUrl).searchParams;
    const found = [...state.apps.entries()].find(
      ([, app]) => app.clientId === query.get("client_id"),
    );
    const redirectUri = query.get("redirect_uri");
    if (!found || !redirectUri) throw new Error("unknown app or no redirect");
    const code = fakeSlackValue("code");
    install.codes.set(code, { appId: found[0], redirectUri });
    return { code, state: query.get("state") ?? "" };
  }

  return { api, state, issueRefresh, install, authorize };
}

/** Install links and installs, as the Postgres store keeps them. */
export function createMemorySlackInstallStore(
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const states = new Map<string, SlackInstallState>();
  const installations = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      status: "pending" | "verified" | "revoked";
      botUserId: string | null;
      verifiedAt: Date | null;
    }
  >();
  const hex = (hash: Uint8Array) => Buffer.from(hash).toString("hex");
  const store: SlackInstallStore = {
    async issueState(stateHash, state, now) {
      for (const [key, row] of states) {
        if (row.expiresAt < now) states.delete(key);
      }
      states.set(hex(stateHash), state);
    },
    async consumeState(stateHash) {
      const row = states.get(hex(stateHash)) ?? null;
      states.delete(hex(stateHash));
      return row;
    },
    async recordInstallation(input) {
      const key = `${input.appId}|${input.teamId}`;
      const existing = installations.get(key);
      if (existing && existing.workspaceId !== input.workspaceId) {
        return { outcome: "workspace_conflict" };
      }
      const row = existing ?? {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        status: "pending" as const,
        botUserId: null,
        verifiedAt: null,
      };
      Object.assign(row, {
        status: "verified",
        botUserId: input.botUserId,
        verifiedAt: now(),
      });
      installations.set(key, row);
      return { outcome: "verified", installationId: row.id };
    },
    async revokeInstallation(key, sentAt) {
      const row = installations.get(`${key.appId}|${key.teamId}`);
      if (!row) return "not_found";
      if (
        sentAt &&
        row.verifiedAt &&
        row.verifiedAt.getTime() >= sentAt.getTime() + 1000
      ) {
        return "superseded";
      }
      row.status = "revoked";
      return "revoked";
    },
  };
  return { store, states, installations };
}

/**
 * Links agents to installs the way the Postgres store does, minus the
 * caller's role re-read; the other methods are not needed by its users.
 */
export function createMemoryAgentIdentityStore(
  installations: ReturnType<
    typeof createMemorySlackInstallStore
  >["installations"],
) {
  const identities: AgentIdentityRecord[] = [];
  /** Agents archived since the caller's right was checked. */
  const archived = new Set<string>();
  const receipts: { id: string; identityId: string }[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not in the memory agent identity store");
  };
  const store: AgentIdentityStore = {
    async link(input) {
      if (archived.has(input.agentId)) return { outcome: "agent_not_found" };
      const installation = installations.get(
        `${input.key.appId}|${input.key.teamId}`,
      );
      if (
        !installation ||
        installation.workspaceId !== input.workspaceId ||
        installation.status !== "verified" ||
        installation.botUserId === null
      ) {
        return { outcome: "not_installed" };
      }
      const holder = identities.find(
        (identity) =>
          identity.installationId === installation.id &&
          identity.status === "active",
      );
      if (holder) {
        return holder.agentId === input.agentId
          ? { outcome: "exists", identity: holder }
          : { outcome: "taken" };
      }
      const identity: AgentIdentityRecord = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        provider: "slack_bot",
        installationId: installation.id,
        appId: input.key.appId,
        teamId: input.key.teamId,
        externalPrincipalId: installation.botUserId,
        credentialRef: input.credentialRef,
        status: "active",
        revision: 1,
        createdBy: input.principal.actor?.userId ?? null,
        createdAt: STAMP,
        revokedAt: null,
      };
      identities.push(identity);
      const receiptId = crypto.randomUUID();
      receipts.push({ id: receiptId, identityId: identity.id });
      return { outcome: "linked", identity, receiptId };
    },
    revoke: unused,
    list: unused,
    // The Postgres store's checks, in its order.
    async resolveSlackEvent(key) {
      const installation = installations.get(`${key.appId}|${key.teamId}`);
      if (!installation) return { status: "dropped", reason: "not_installed" };
      if (installation.status === "revoked") {
        return { status: "dropped", reason: "installation_revoked" };
      }
      if (installation.status !== "verified") {
        return { status: "dropped", reason: "installation_unverified" };
      }
      const identity =
        identities.find(
          (row) =>
            row.installationId === installation.id && row.status === "active",
        ) ??
        [...identities]
          .reverse()
          .find((row) => row.installationId === installation.id);
      if (!identity) return { status: "dropped", reason: "unidentified" };
      if (identity.status !== "active") {
        return { status: "dropped", reason: "identity_revoked" };
      }
      if (identity.externalPrincipalId !== installation.botUserId) {
        return { status: "dropped", reason: "bot_mismatch" };
      }
      if (archived.has(identity.agentId)) {
        return { status: "dropped", reason: "agent_archived" };
      }
      return {
        status: "resolved",
        workspaceId: identity.workspaceId,
        agentId: identity.agentId,
        identity: { id: identity.id, revision: identity.revision },
        installationId: installation.id,
        botUserId: identity.externalPrincipalId,
        credentialRef: identity.credentialRef,
      };
    },
  };
  return { store, identities, receipts, archived };
}

type MemoryInboundRow = SlackInboundEventInput & {
  id: string;
  state: SlackInboundEventStatus;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  nextAttemptAt: number | null;
  dropped?: SlackInboundDropReason;
};

/**
 * Keyed by `app|event`, like the table. The claim side is a plain lease on
 * `now()`, in arrival order, without the table's per-thread ordering; the
 * PostgreSQL store's own tests hold that.
 */
export function createMemorySlackInboundEventStore(
  options: {
    now?: () => number;
    installationStatus?: () => SlackInboundClaim["installationStatus"];
  } = {},
) {
  const now = options.now ?? Date.now;
  const rows = new Map<string, SlackInboundEventInput>();
  const lease = new Map<string, MemoryInboundRow>();
  const calls = { seen: 0, record: 0 };
  const faults = { record: 0 };
  const held = (fence: SlackInboundFence) => {
    const row = [...lease.values()].find((r) => r.id === fence.id);
    return row !== undefined &&
      row.claimToken === fence.claimToken &&
      (row.leaseExpiresAt ?? 0) > now()
      ? row
      : undefined;
  };
  const release = (row: MemoryInboundRow, state: SlackInboundEventStatus) => {
    row.state = state;
    row.claimToken = null;
    row.leaseExpiresAt = null;
  };
  const store: SlackInboundEventStore = {
    async seen(appId, eventId) {
      calls.seen += 1;
      return rows.has(`${appId}|${eventId}`);
    },
    async record(event) {
      calls.record += 1;
      if (faults.record > 0) {
        faults.record -= 1;
        throw new Error("inbox write failed");
      }
      const key = `${event.appId}|${event.eventId}`;
      if (rows.has(key)) return "duplicate";
      rows.set(key, event);
      lease.set(key, {
        ...event,
        id: crypto.randomUUID(),
        state: event.status,
        claimToken: null,
        leaseExpiresAt: null,
        attempts: 0,
        nextAttemptAt: null,
      });
      return "recorded";
    },
    async claim({ limit, leaseMs, maxAttempts }) {
      const out: SlackInboundClaim[] = [];
      for (const row of lease.values()) {
        if (out.length >= limit) break;
        if (row.state !== "received" || row.status === "dropped") continue;
        if (row.claimToken !== null && (row.leaseExpiresAt ?? 0) > now()) {
          continue;
        }
        if (row.nextAttemptAt !== null && row.nextAttemptAt > now()) continue;
        if (row.attempts >= maxAttempts) {
          release(row, "failed");
          continue;
        }
        row.claimToken = crypto.randomUUID();
        row.leaseExpiresAt = now() + leaseMs;
        row.attempts += 1;
        out.push({
          id: row.id,
          claimToken: row.claimToken,
          attempts: row.attempts,
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          slackAppId: row.slackAppId,
          teamId: row.teamId,
          appId: row.appId,
          eventId: row.eventId,
          eventType: row.eventType,
          eventSubtype: row.eventSubtype,
          eventTime: row.eventTime,
          conversationKey: row.conversationKey,
          payload: row.payload,
          installationStatus: options.installationStatus?.() ?? "verified",
        });
      }
      return out;
    },
    async renew(fence, leaseMs) {
      const row = held(fence);
      if (row === undefined) return null;
      row.leaseExpiresAt = now() + leaseMs;
      return {
        installationStatus: options.installationStatus?.() ?? "verified",
      };
    },
    async complete(fence) {
      const row = held(fence);
      if (row) release(row, "processed");
      return row !== undefined;
    },
    async drop(fence, reason) {
      const row = held(fence);
      if (row) {
        release(row, "dropped");
        row.dropped = reason;
      }
      return row !== undefined;
    },
    async fail(fence, { retryInMs, maxAttempts }) {
      const row = held(fence);
      if (row === undefined) return "lost";
      const spent = row.attempts >= maxAttempts;
      release(row, spent ? "failed" : "received");
      row.nextAttemptAt = spent ? null : now() + retryInMs;
      return spent ? "failed" : "retry";
    },
  };
  return { store, rows, lease, calls, faults };
}
