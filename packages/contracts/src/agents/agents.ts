import { z } from "zod";

import {
  agentGitHubFeaturesSchema,
  GITHUB_AGENT_REF_PREFIX,
  githubFeaturesSchema,
  githubRefNamesAgentBranch,
  storedAgentGitHubFeaturesSchema,
  storedGitHubFeaturesSchema,
} from "../access-control/github-settings.ts";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  CARD_LEGACY_INSTRUCTIONS_MAX_LENGTH,
} from "../shared/agent-card.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  agentVersionIdSchema,
  canonicalJson,
  canonicalJsonOfJson,
  INT4_MAX,
  PAGE_LIMIT_MAX,
  pageSchema,
  paginationQuerySchema,
  privateChannelsPendingSchema,
  receiptIdSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { providerKindSchema } from "../shared/provider-kind.ts";
import { runtimeKindSchema } from "../shared/runtime-kind.ts";
import { cardEnvDeclarationSchema } from "./env-variables.ts";

export {
  AGENT_DESCRIPTION_MAX_LENGTH,
  CARD_LEGACY_INSTRUCTIONS_MAX_LENGTH,
} from "../shared/agent-card.ts";

export const AGENT_STATUS_VALUES = ["active", "paused", "archived"] as const;
export const agentStatusSchema = z.enum(AGENT_STATUS_VALUES);

/**
 * The language an agent answers in. `follow-user`, also the default for a
 * card that names none, adds no instruction: the model answers in the
 * person's language. The others add one that holds whatever the person writes.
 */
export const AGENT_CARD_LANGUAGE_VALUES = [
  "follow-user",
  "ko",
  "en",
  "ja",
] as const;
/** The languages that add an instruction; a release records only these or `follow-user`. */
export const RESPONSE_LANGUAGE_VALUES = ["ko", "en", "ja"] as const;
export const AGENT_RULE_SOURCE_VALUES = ["user", "correction"] as const;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const toolNameSchema = z.string().min(1).max(128);

/**
 * The name of a credential held outside Werft — a secret store entry, a
 * remote MCP server connection — never its value.
 */
export const CREDENTIAL_REF_PATTERN = "^[a-z0-9][a-z0-9._:/-]{0,127}$";
export const credentialRefSchema = z
  .string()
  .regex(
    new RegExp(CREDENTIAL_REF_PATTERN),
    "must be a lowercase credential name, not a value",
  );
export const CREDENTIAL_BINDING_TARGET_VALUES = [
  "agent",
  "agent_identity",
] as const;

/** What happens when the agent calls a tool. The session runtime evaluates it per call. */
export const TOOL_POLICY_VALUES = ["allow", "ask", "deny"] as const;
export const toolPolicySchema = z.enum(TOOL_POLICY_VALUES);

/** Remote MCP server tools are named `mcp__<server>__<tool>` by the SDK. */
export const MCP_TOOL_PREFIX = "mcp__";

export const toolPolicyDefaultsSchema = z
  .object({ builtin: toolPolicySchema, mcp: toolPolicySchema })
  .strict();

/** Same defaults as Managed Agents. */
export const DEFAULT_TOOL_POLICY = {
  builtin: "allow",
  mcp: "ask",
} as const satisfies z.infer<typeof toolPolicyDefaultsSchema>;

const mcpToolNameSchema = toolNameSchema.refine(
  (name) => name.startsWith(MCP_TOOL_PREFIX),
  `must be an ${MCP_TOOL_PREFIX} tool name`,
);

/**
 * A card's say over the MCP tools it calls. Built-in tools are the runtime's
 * and have no entry here.
 */
export const cardToolPolicySchema = z
  .object({ per_tool: z.record(mcpToolNameSchema, toolPolicySchema) })
  .strict();

export const agentRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(2_000),
    source: z.enum(AGENT_RULE_SOURCE_VALUES),
  })
  .strict();

/** Its tools are `mcp__<id>__<tool>`, so the id holds no `__`. */
export const MCP_SERVER_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$";
export const mcpServerIdSchema = z
  .string()
  .regex(new RegExp(MCP_SERVER_ID_PATTERN), "must be a catalog MCP server id");
/**
 * Names no workspace MCP server holds, as the database checks them: the
 * built-in server and one kept for a future built-in.
 */
export const MCP_RESERVED_SERVER_NAMES = ["github", "browser"] as const;
/**
 * The built-in MCP server every session has, whatever its agent or workspace
 * says: the agent reads how Werft works and what it is connected to through
 * it. Nothing turns it off, and no other MCP server takes its name.
 */
export const WERFT_MCP_SERVER = "werft";
/** Shown wherever an installation catalog MCP entry is refused. */
export const RETIRED_CATALOG_MCP_MESSAGE =
  "설치 카탈로그 MCP는 없어졌다. 워크스페이스 MCP 서버로 등록해 고른다";

/**
 * The installation catalog server a stored card names, or null. The one
 * reader of `capabilities.mcp[0].server`: a session leaves that server, its
 * tools, pins and credential name out, and only a restore brings it back.
 */
export function retiredCatalogServerOf(card: unknown): string | null {
  const capabilities =
    typeof card === "object" && card !== null
      ? (card as { capabilities?: unknown }).capabilities
      : undefined;
  const mcp =
    typeof capabilities === "object" && capabilities !== null
      ? (capabilities as { mcp?: unknown }).mcp
      : undefined;
  const first: unknown = Array.isArray(mcp) ? mcp[0] : undefined;
  const server =
    typeof first === "object" && first !== null
      ? (first as { server?: unknown }).server
      : undefined;
  return typeof server === "string" ? server : null;
}

export const cardMcpServerSchema = z
  .object({ server: mcpServerIdSchema })
  .strict();

/**
 * An agent's MCP settings as a session starts with them (`sessions.mcp_start`).
 * Not strict, so a later field does not make an older image refuse the
 * snapshot; one that does not parse closes the session's MCP.
 */
export const mcpStartSchema = z.object({
  server: mcpServerIdSchema.nullable(),
  allowed_tools: z.array(toolNameSchema),
  credential_refs: z.array(credentialRefSchema),
  /** `agent_mcp_settings.revision` the snapshot was taken from. */
  revision: z.number().int().positive(),
});
export type McpStart = z.infer<typeof mcpStartSchema>;

export const AGENT_WORKSPACE_MCP_SERVERS_MAX = 8;

/**
 * The workspace MCP servers an agent had on as a session starts
 * (`sessions.workspace_mcp_start`), each with its URL and the tools stored
 * then. The session calls the tools still stored that are in this list, so
 * a change narrows at once and widens only the next session; a server moved
 * to another URL since is refused. Not strict, as `mcpStartSchema`.
 */
export const workspaceMcpStartSchema = z.object({
  servers: z
    .array(
      z.object({
        id: z.uuid(),
        name: mcpServerIdSchema,
        // Absent in a snapshot taken before the URL was kept.
        url: z.url().optional(),
        tools: z.array(mcpToolNameSchema),
      }),
    )
    .max(AGENT_WORKSPACE_MCP_SERVERS_MAX),
});
export type WorkspaceMcpStart = z.infer<typeof workspaceMcpStartSchema>;

export const agentCapabilitiesSchema = z
  .object({
    /**
     * The remote MCP server the agent calls, by the operator catalog's id
     * (`mcp_servers.<id>`), which fixes its URL, credential and workspaces.
     * Null for none, so a card written before it keeps its content hash.
     */
    mcp: z.array(cardMcpServerSchema).min(1).max(1).nullable(),
    /** MCP tools the release must not allow. */
    forbidden: z.array(mcpToolNameSchema).default([]),
    /**
     * Optional, with no default, so a card written before it existed keeps
     * its content hash. Changing it makes a new version, hence a new release.
     */
    tool_policy: cardToolPolicySchema.optional(),
    /**
     * The credentials the agent runs with, by name. Optional for the same
     * reason as `tool_policy`. Each must be bound to the agent before a
     * release of this version activates or starts a session.
     */
    credential_refs: z
      .array(credentialRefSchema)
      .max(32)
      .refine(
        (refs) => new Set(refs).size === refs.length,
        "credential_refs must not repeat a name",
      )
      .optional(),
    /**
     * The variable names the release takes as input; only these reach a
     * session. Optional for the same reason as `tool_policy`.
     */
    env: cardEnvDeclarationSchema.optional(),
  })
  .strict();

/**
 * A card as read: model and capability range. `name` and
 * `description` live on the agent row, not here, so editing them does not
 * mint a new immutable version.
 *
 * `role` and `instructions` never reach a run: new cards leave them out and
 * older ones keep theirs. What steers an agent is the repository's
 * CLAUDE.md / AGENTS.md, never a card field.
 *
 * `.strict()` is what enforces "a card holds no secrets": there is
 * structurally nowhere to put one, and a credential field is rejected rather
 * than silently stored. Credentials stay with the provider connection.
 */
export const agentCardSchema = z
  .object({
    role: z.string().min(1).max(200).optional(),
    instructions: z
      .string()
      .min(1)
      .max(CARD_LEGACY_INSTRUCTIONS_MAX_LENGTH)
      .optional(),
    language: z.enum(AGENT_CARD_LANGUAGE_VALUES).default("follow-user"),
    /** Must be one of the models the release's connection offers. */
    model: z.string().min(1).max(128),
    /**
     * The model the agent's conversation judgments and channel summary folds
     * call, on the release's connection. Absent: `model`. Must be one of the
     * models the connection offers. Not the workspace's decision model.
     */
    judgment_model: z.string().min(1).max(128).optional(),
    capabilities: agentCapabilitiesSchema,
    rules: z.array(agentRuleSchema).default([]),
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMcpTool = (name: unknown) =>
  typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX);

/**
 * Capabilities as an older client or an older stored card wrote them, without
 * what no longer exists: `tools`, built-in names in `forbidden` and in
 * `tool_policy.per_tool`, and `tool_policy.default`. The runtime decides
 * built-in tools, and these were already ignored when a release is made, so
 * they are dropped rather than refused. MCP entries pass through.
 */
function withoutRetiredToolFields(capabilities: unknown): unknown {
  if (!isRecord(capabilities)) return capabilities;
  const {
    tools: _tools,
    forbidden,
    tool_policy: policy,
    ...rest
  } = capabilities;
  return {
    ...rest,
    ...(forbidden === undefined
      ? {}
      : {
          forbidden: Array.isArray(forbidden)
            ? forbidden.filter(isMcpTool)
            : forbidden,
        }),
    ...(policy === undefined ? {} : withoutRetiredPolicy(policy)),
  };
}

/**
 * Only the retired `default` and the built-in `per_tool` names go; any other
 * key stays, so a misspelled one is still refused by the strict schema.
 */
function withoutRetiredPolicy(policy: unknown): { tool_policy?: unknown } {
  if (!isRecord(policy)) return { tool_policy: policy };
  const { default: _default, per_tool: perTool, ...others } = policy;
  const mcp = isRecord(perTool)
    ? Object.fromEntries(
        Object.entries(perTool).filter(([tool]) => isMcpTool(tool)),
      )
    : perTool;
  const kept = {
    ...others,
    ...(mcp === undefined || (isRecord(mcp) && Object.keys(mcp).length === 0)
      ? {}
      : { per_tool: mcp }),
  };
  return Object.keys(kept).length === 0 ? {} : { tool_policy: kept };
}

// The card's `agent_instructions` key is retired: cards saved while it existed
// still hold it, and an older client may still send it. It is dropped, never
// refused, and never reaches a run.
function withoutRetiredCardFields(card: unknown): unknown {
  if (!isRecord(card)) return card;
  const { agent_instructions: _retired, ...rest } = card;
  return { ...rest, capabilities: withoutRetiredToolFields(card.capabilities) };
}

/**
 * The card a request may write: the shape it is read in, so an edit can send
 * back the stored card it started from. A request from before the card lost
 * its built-in tool fields is still accepted; see `withoutRetiredToolFields`.
 * Its documented shape is `agentCardSchema`.
 */
export const agentCardRequestSchema = z.preprocess(
  withoutRetiredCardFields,
  agentCardSchema,
);

/** `capabilities` of a stored card, read by the agent list's summaries. */
export const storedAgentCapabilitiesSchema = z.preprocess(
  withoutRetiredToolFields,
  agentCapabilitiesSchema,
);

/**
 * A card as stored. Cards written before `tone` was dropped still
 * hold it, and cards from before the built-in tool fields were dropped
 * hold those; they are accepted and left out of what is read. The version's
 * `content_sha256` and its releases' `card_sha256` keep hashing the stored
 * card, so nothing re-hashes what this returns.
 */
export const storedAgentCardSchema = z
  .preprocess(
    withoutRetiredCardFields,
    agentCardSchema.extend({ tone: z.string().optional() }),
  )
  .transform(({ tone: _dropped, ...card }): AgentCard => card);

// Postgres text cannot store NUL, so it is refused here rather than at insert.
export const agentDescriptionSchema = z
  .string()
  .max(AGENT_DESCRIPTION_MAX_LENGTH)
  .refine(
    (description) => !description.includes("\u0000"),
    "description must not contain NUL",
  );
/** A description a client sends: the ends trimmed, and empty meaning none. */
const agentDescriptionInputSchema = z
  .string()
  .trim()
  .max(AGENT_DESCRIPTION_MAX_LENGTH)
  .refine(
    (description) => !description.includes("\u0000"),
    "description must not contain NUL",
  )
  .transform((description) => description || null);

export const AGENT_NAME_MAX_LENGTH = 120;
/** A name a client sends: the ends trimmed, whitespace alone refused. */
export const agentNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_NAME_MAX_LENGTH);

/** `-1` until the first activation, which is why it is not a `revision`. */
export const activationRevisionSchema = z.number().int().min(-1).max(INT4_MAX);

export const agentSchema = z
  .object({
    id: agentIdSchema,
    workspace_id: workspaceIdSchema,
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    /**
     * What the agent is for. With `name`, a new session snapshots it into
     * its platform prompt, so a change reaches the sessions started after it.
     */
    description: agentDescriptionSchema.nullable(),
    /**
     * The team whose leads administer the agent and whose members work with
     * it. Every agent has one.
     */
    managing_team_id: z.uuid(),
    /** The managing team's name, for whoever reads the row, team member or not. */
    managing_team_name: z.string().min(1),
    status: agentStatusSchema,
    active_release_id: agentReleaseIdSchema.nullable(),
    activation_revision: activationRevisionSchema,
    /**
     * Off: nothing moves the agent to the next model of its series when its
     * model leaves its connection's list, neither its release, nor its sessions
     * at their next turn, nor a new session.
     */
    auto_model_migration: z.boolean(),
    /**
     * The last automatic model move that failed, while the activation it
     * tried to move from is still the current one; null otherwise. `reason` is the code a
     * failed save reports. The move is tried again after
     * `MODEL_MIGRATION_RETRY_MINUTES`.
     */
    model_migration_failure: z
      .object({
        reason: z.string().min(1).max(128),
        failed_at: timestampSchema,
      })
      .strict()
      .nullable(),
    /**
     * No one live administers the agent now: no admin of its own, no live
     * member of an admin team, no lead of its managing team. Workspace owners
     * and admins do not count.
     */
    ownerless: z.boolean(),
    /**
     * When the agent was first seen with no one to administer it, cleared
     * once someone is. Can lag `ownerless` by one reconciler pass. From this
     * plus `AGENT_OWNERLESS_GRACE_DAYS`, a new session of an agent still
     * ownerless is refused with `AGENT_NOT_RUNNABLE` (`agent_ownerless`).
     */
    ownerless_since: timestampSchema.nullable(),
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

/** Minutes before a failed automatic model move is tried again. */
export const MODEL_MIGRATION_RETRY_MINUTES = 15;

/** Days an ownerless agent keeps starting new sessions. */
export const AGENT_OWNERLESS_GRACE_DAYS = 14;

/** Insert-only. `content_sha256` is sha256 over the canonical JSON of the card. */
export const agentVersionSchema = z
  .object({
    id: agentVersionIdSchema,
    agent_id: agentIdSchema,
    version_no: z.number().int().positive(),
    card: agentCardSchema,
    content_sha256: sha256HexSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const effectiveToolsSchema = z
  .object({
    tools: z.array(toolNameSchema),
    mcp: z.array(toolNameSchema),
  })
  .strict();

// A structural guard at the trust boundary, not secret detection: the
// repository's own `ClaudeRuntimeConfig` carries the live key at
// `provider.auth.value`, so handing a resolved config straight to this schema
// used to persist it. Rejecting the key names that hold a credential makes
// that mistake fail loudly at the parse instead of quietly in the database.
//
// The match is on a *word* inside the key, not on the whole key, because the
// names that actually appear are compound: `client_secret`, `signing_secret`,
// `botToken`, `secretAccessKey`. A credential travels as a reference —
// `api_key_ref: "env:ANTHROPIC_API_KEY"` — so a key whose last word is `ref`
// is allowed, and that is the only exemption.
//
// It errs wide on purpose: a false positive is a parse error the author fixes
// by renaming or by storing a reference, a false negative is a live key in an
// immutable row.
//
// `auth`, `env` and `headers` are rejected as whole keys rather than by word.
// They are containers of resolved values — `mcpServers.notion.env.NOTION_API`
// is a live credential under a name no word list can recognise — and a release
// snapshot has no business holding a resolved environment at all: the runtime
// resolves it at launch from `env_ref`. `auth_kind` and `header_order` name
// one of these without holding it, which is why the match is on the whole key.
//
// What this cannot see: a credential under a name that says nothing, at the
// top level (`notion: "live-value"`). The guard is structural — whoever builds
// the release is still the one responsible for not putting it there.
const CREDENTIAL_WORD =
  /^(key|keys|token|tokens|secret|secrets|password|passphrase|credential|credentials)$/i;
const CREDENTIAL_KEY = /^(auth|authorization|env|environment|headers)$/i;

// `signingSecret` → [signing, Secret]; `client_secret` → [client, secret];
// `APIKey` → [API, Key]. Without the second boundary an acronym swallows the
// word after it and `JWTToken` reads as one unknown word.
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
}

// `env:ANTHROPIC_API_KEY`, `secret:[REDACTED]`, `vault:kv/data/x#field`. A
// reference names where the value lives; it is not the value.
const REFERENCE_VALUE = /^[a-z][a-z0-9+.-]*:.+$/;

function namesReference(key: string): boolean {
  const last = keyWords(key).at(-1);
  return last !== undefined && /^refs?$/i.test(last);
}

function holdsCredential(key: string): boolean {
  if (CREDENTIAL_KEY.test(key)) return true;
  if (namesReference(key)) return false;
  return keyWords(key).some((word) => CREDENTIAL_WORD.test(word));
}

function assertCredentialFree(
  value: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCredentialFree(item, [...path, index], ctx);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (holdsCredential(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `${key} may not travel in a release snapshot; store a reference instead`,
      });
      continue;
    }
    // The `_ref` suffix buys an exemption from the word scan, so the value
    // has to earn it: a key named like a reference holding a literal
    // credential would otherwise be the easiest way through this guard.
    if (
      namesReference(key) &&
      !(typeof nested === "string" && REFERENCE_VALUE.test(nested))
    ) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `${key} must be a reference such as env:NAME, not a value`,
      });
      continue;
    }
    assertCredentialFree(nested, [...path, key], ctx);
  }
}

/** The resolved runtime config, with every credential left behind. */
export const runtimeConfigSnapshotSchema = z
  .record(z.string(), z.unknown())
  .superRefine((snapshot, ctx) => {
    // The release id is a hash of this, so a snapshot `canonicalJson` cannot
    // represent — a Date, a Map, an undefined optional — is a release that
    // parses and then cannot be identified. Reuse the hash's own rule rather
    // than restate it.
    try {
      canonicalJson(snapshot);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `not canonically representable: ${(error as Error).message}`,
      });
      return;
    }
    assertCredentialFree(snapshot, [], ctx);
  });

/** Enforced on every path that turns a repository on, settings and pins alike. */
export const AGENT_GITHUB_REPOSITORIES_MAX = 32;
export const AGENT_GITHUB_ACTIONS_ALLOW_MAX = 32;

/**
 * What an agent's GitHub work may reach, pinned on its release. A release
 * without it runs as before: every repository the workspace ceiling allows, no
 * push approval, no optional permission.
 */
const agentGitHubFields = {
  /** Catalog repository ids. */
  repositories: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(AGENT_GITHUB_REPOSITORIES_MAX),
  push_approval: z.boolean(),
  features: githubFeaturesSchema,
  actions_allow: z
    .array(
      z
        .object({
          /** A file under `.github/workflows/`, never a path. */
          workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/),
          /** A branch, or a glob with `*` that stops at `/`; absent: the default branch. */
          ref: z.string().min(1).max(255).optional(),
        })
        .strict(),
    )
    .max(AGENT_GITHUB_ACTIONS_ALLOW_MAX),
};

export const agentGitHubSchema = z.object(agentGitHubFields).strict();

/**
 * A stored pin as it is read: `features` leaves out what this build does not
 * know (`storedGitHubFeaturesSchema`). Anything else unknown still fails the
 * read, since a key there may narrow (an allow-list entry's condition) and
 * dropping it would widen.
 */
export const storedAgentGitHubSchema = z
  .object({ ...agentGitHubFields, features: storedGitHubFeaturesSchema })
  .strict();

/**
 * A release's pin as its row holds it. The release id hashes the pin as
 * stored, so a boolean switch this build does not know is kept here; every
 * policy reader drops it (`storedAgentGitHubSchema`).
 */
export const releasePinGitHubSchema = z
  .object({
    ...agentGitHubFields,
    features: storedGitHubFeaturesSchema.catchall(z.boolean()),
  })
  .strict();

const settingsRepositories = z.array(z.string().min(1).max(128));

/**
 * The agent's own GitHub settings, not pinned on any release. Unlike a pin
 * the list may be empty (switched on, with no repository yet), and its
 * `features` may turn `merge` on.
 */
export const agentGitHubSettingsSchema = agentGitHubSchema.extend({
  repositories: settingsRepositories,
  features: agentGitHubFeaturesSchema,
});

/** A stored settings row or start snapshot as it is read, as for a pin. */
export const storedAgentGitHubSettingsSchema = storedAgentGitHubSchema.extend({
  repositories: settingsRepositories,
  features: storedAgentGitHubFeaturesSchema,
});

/**
 * What a client may save into `actions_allow`: no entry twice, and no `ref`
 * that can match an `agent/` branch, which a dispatch never runs. A stored
 * list reads without these, so one saved earlier still applies.
 */
function checkActionsAllow(
  allow: AgentGitHub["actions_allow"],
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, entry] of allow.entries()) {
    if (entry.ref !== undefined && githubRefNamesAgentBranch(entry.ref)) {
      ctx.addIssue({
        code: "custom",
        path: ["actions_allow", index, "ref"],
        message: `must not match a ${GITHUB_AGENT_REF_PREFIX} branch`,
      });
    }
    const key = JSON.stringify([entry.workflow, entry.ref ?? null]);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["actions_allow", index],
        message: "lists this workflow and ref twice",
      });
    }
    seen.add(key);
  }
}

/** A release pin a client sends. */
export const agentGitHubInputSchema = agentGitHubSchema.superRefine(
  (github, ctx) => checkActionsAllow(github.actions_allow, ctx),
);
/** Settings a client saves. */
export const agentGitHubSettingsInputSchema =
  agentGitHubSettingsSchema.superRefine((settings, ctx) =>
    checkActionsAllow(settings.actions_allow, ctx),
  );

/**
 * The bound `push_attached` puts on a push to any repository; the stricter of
 * it and `push_approval` applies (`pushDecisionOf`). Stored on
 * `agent_github_settings.push_attached`, never on a release pin. Where no
 * person chose one (a pin, no row, a null column) it is `allow`.
 */
export const PUSH_ATTACHED_VALUES = ["allow", "ask", "deny"] as const;
export const pushAttachedSchema = z.enum(PUSH_ATTACHED_VALUES);
export type PushAttached = z.infer<typeof pushAttachedSchema>;

const PUSH_ATTACHED_STRICTNESS: Record<PushAttached, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** The stricter of two values: `deny > ask > allow`. */
export function meetPushAttached(a: PushAttached, b: PushAttached) {
  return PUSH_ATTACHED_STRICTNESS[a] >= PUSH_ATTACHED_STRICTNESS[b] ? a : b;
}

/**
 * A stored value as it applies. A row saved before the column has none, and
 * nobody chose to be asked, so it allows (owner decision, Orchestrator item
 * 147); a value this image does not know is refused, never guessed at.
 */
export function pushAttachedOf(stored: unknown): PushAttached {
  if (stored === null || stored === undefined) return "allow";
  const parsed = pushAttachedSchema.safeParse(stored);
  return parsed.success ? parsed.data : "deny";
}

/**
 * What a push to any repository needs: `allow` pushes without a person, `ask`
 * waits for one, `deny` refuses. One rule for every repository, the stricter
 * of `push_approval` and `push_attached`. No settings at all (`null`: no row
 * and no pin) is nobody asking for a person, so only `push_attached` applies;
 * `settings` that cannot be read ask. A caller reads this at run time, so a push intent made under an older
 * rule (its stored class is audit only) is judged again by this one.
 */
export function pushDecisionOf(policy: {
  settings: AgentGitHub | "invalid" | null;
  pushAttached: PushAttached;
}): PushAttached {
  const { settings } = policy;
  if (settings === "invalid")
    return meetPushAttached("ask", policy.pushAttached);
  const approval: PushAttached = settings?.push_approval ? "ask" : "allow";
  return meetPushAttached(approval, policy.pushAttached);
}

/**
 * The agent's settings as a session read them when it started
 * (`sessions.github_policy_start`). The envelope is not strict so a later
 * image may add a field; `settings` is but for its `features`
 * (`storedAgentGitHubSettingsSchema`), so a list this image cannot read
 * closes the session instead of being guessed at.
 */
export const githubPolicyStartSchema = z.object({
  /** `agents.github_enabled` at start: off then stays off for the session. */
  enabled: z.boolean(),
  /** `agent_github_settings.revision` the snapshot was taken from. */
  revision: z.number().int(),
  settings: storedAgentGitHubSettingsSchema,
  /**
   * `push_attached` at start. On the envelope, not in `settings`, so an image
   * from before it still reads the snapshot. Absent: `allow`, as a null
   * column reads.
   */
  push_attached: pushAttachedSchema.optional(),
});
export type GitHubPolicyStart = z.infer<typeof githubPolicyStartSchema>;

/**
 * What a session may do when it started under `start` and the settings are
 * `current` now. Only narrows, per field: the repository lists intersect, a
 * push needs approval if either asks for it, a feature needs both (`merge`
 * too, which a pin never has: a session on a release's pin does not merge).
 * `actions_allow` holds globs and branch meanings, so it is not intersected:
 * the result keeps the current list and the caller also checks the start's.
 */
export function meetGitHubSettings(
  start: AgentGitHubSettings,
  current: AgentGitHubSettings,
): AgentGitHubSettings {
  const kept = new Set(current.repositories);
  return {
    repositories: start.repositories.filter((id) => kept.has(id)),
    push_approval: start.push_approval || current.push_approval,
    features: {
      workflows: start.features.workflows && current.features.workflows,
      actions: start.features.actions && current.features.actions,
      checks: start.features.checks && current.features.checks,
      issues: start.features.issues && current.features.issues,
      review: start.features.review && current.features.review,
      ...(start.features.merge && current.features.merge
        ? { merge: true }
        : {}),
    },
    actions_allow: current.actions_allow,
  };
}

/** Whose GitHub policy a session runs on, fixed when it starts. */
export const GITHUB_POLICY_SOURCE_VALUES = ["release", "agent"] as const;
export type GitHubPolicySource = (typeof GITHUB_POLICY_SOURCE_VALUES)[number];

/** A stored source. One this image does not know reads as `agent`, closed. */
export function githubPolicySourceOf(stored: unknown): GitHubPolicySource {
  return stored === "release" ? "release" : "agent";
}

/** An `agent_github_settings` row; the jsonb columns as read, unparsed. */
export type AgentGitHubSettingsRow = {
  repositories: unknown;
  pushApproval: boolean;
  features: unknown;
  actionsAllow: unknown;
  startRepositoryId: string | null;
  /** Null on a row saved before the column; reads as `ask`. */
  pushAttached: string | null;
  revision: number;
  /**
   * Who saved the row; null for a row a migration wrote. Required so a read
   * path that forgets to project it fails the type check.
   */
  updatedBy: string | null;
};

/**
 * What an agent session reads when it has no row: nothing reachable. Push
 * approval is off, as for any agent nobody chose it for.
 */
export const GITHUB_POLICY_CLOSED: AgentGitHub = {
  repositories: [],
  push_approval: false,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
};

export type EffectiveGitHubPolicy = {
  source: GitHubPolicySource;
  /**
   * Null only on a release from before GitHub settings: no list applies and
   * a person approves each push. Closed is GITHUB_POLICY_CLOSED, never null.
   * Once a session has a start to compare with (its pin, or its snapshot)
   * this is the meet of that start and the agent's settings now.
   */
  settings: AgentGitHubSettings | "invalid" | null;
  /** Kept for compatibility, not read to start a session; a release's is `repository_id`. */
  startRepositoryId: string | null;
  agentSettingsRevision: number | null;
  /**
   * A `release` session with no pin whose agent has a person-saved row: the
   * row's list. `settings` stays null (no list applies, as before) but the
   * repositories the person took off stop being reachable.
   */
  currentRepositories: string[] | null;
  /**
   * The `actions_allow` the session started with. It cannot be intersected
   * with the current one, so a workflow must be allowed by both lists.
   */
  startActionsAllow: AgentGitHub["actions_allow"] | null;
  /** False when GitHub was off for the agent as the session started. */
  enabledAtStart: boolean;
  /**
   * Whether a push to an attached repository needs a person. Like the other
   * fields it only narrows after the session starts. A release pin has no
   * value of its own and means `allow`; a row a person saved sets it.
   */
  pushAttached: PushAttached;
};

/**
 * A release has no value and allows; the row a person saved sets it. A row a
 * migration wrote (no `updatedBy`) changes nothing.
 */
function releasePushAttached(row: AgentGitHubSettingsRow): PushAttached {
  return row.updatedBy === null ? "allow" : pushAttachedOf(row.pushAttached);
}

const UNSET = {
  pushAttached: "allow" as PushAttached,
  startRepositoryId: null,
  agentSettingsRevision: null,
  currentRepositories: null,
  startActionsAllow: null,
  enabledAtStart: true,
} as const;

/**
 * A release pin where no person saved the agent's switches (94S-2406). Its
 * `actions` once also read CI, so it turns on workflow edits and CI reads as
 * the migration did for saved rows; it never runs workflows directly, which
 * only a saved row turns on.
 */
export function pinUnderSwitches<T extends AgentGitHub>(pin: T): T {
  const { features } = pin;
  return {
    ...pin,
    features: {
      ...features,
      workflows: features.workflows || features.actions,
      checks: features.checks || features.actions,
      actions: false,
    },
    actions_allow: [],
  };
}

/**
 * The one answer to what GitHub work a session may do (design
 * github 4.2). Everything that judges a session's GitHub work reads
 * this. A value this image cannot read is "invalid", which every reader
 * refuses.
 *
 * - `release`: the pin it started on, under `pinUnderSwitches`. A row a
 *   person saved narrows it further (meet; with no pin only
 *   `currentRepositories`). A row a migration wrote (`updatedBy` null) and
 *   no row change nothing.
 * - `agent`: the agent's row now, met with the settings the session started
 *   under (`start`), except that a session with its own attached list
 *   (`attachedRepositoryIds` an array) reads the repository list from the row
 *   alone. A session with no snapshot reads the row alone.
 */
export function effectiveGitHubPolicy(input: {
  /** `sessions.github_policy_source`. */
  source: unknown;
  /** `policy_pins -> 'github'`. */
  releasePin: unknown;
  agentRow: AgentGitHubSettingsRow | null;
  /** `sessions.github_policy_start`; null when the session has none. */
  start?: unknown;
  /**
   * `sessions.attached_repository_ids`. An array (even an empty one) marks a
   * session whose attached list is its own, so a repository the agent turned
   * on after the session started can be attached; null or absent keeps the
   * session's start list as the ceiling.
   */
  attachedRepositoryIds?: readonly string[] | null;
}): EffectiveGitHubPolicy {
  const { agentRow } = input;
  const current =
    agentRow === null
      ? null
      : storedAgentGitHubSettingsSchema.safeParse({
          repositories: agentRow.repositories,
          push_approval: agentRow.pushApproval,
          features: agentRow.features,
          actions_allow: agentRow.actionsAllow,
        });
  // Unreadable settings never widen: every reader of these asks or refuses.
  const invalid = (source: GitHubPolicySource): EffectiveGitHubPolicy => ({
    ...UNSET,
    pushAttached: "ask",
    source,
    settings: "invalid",
    agentSettingsRevision: agentRow?.revision ?? null,
  });
  if (input.source === "release") {
    const hasPin = input.releasePin !== null && input.releasePin !== undefined;
    const pin = hasPin
      ? storedAgentGitHubSchema.safeParse(input.releasePin)
      : null;
    if (agentRow === null || current === null) {
      if (pin === null) return { ...UNSET, source: "release", settings: null };
      if (!pin.success) return invalid("release");
      return {
        ...UNSET,
        source: "release",
        settings: pinUnderSwitches(pin.data),
      };
    }
    // A row this image cannot read closes the session whoever wrote it.
    if (
      !current.success ||
      (agentRow.updatedBy !== null && typeof agentRow.updatedBy !== "string")
    ) {
      return invalid("release");
    }
    if (pin !== null && !pin.success) return invalid("release");
    if (agentRow.updatedBy === null) {
      // A migration's row must not narrow a session that started before it.
      return {
        ...UNSET,
        source: "release",
        settings: pin === null ? null : pinUnderSwitches(pin.data),
      };
    }
    if (pin === null) {
      return {
        ...UNSET,
        source: "release",
        settings: null,
        agentSettingsRevision: agentRow.revision,
        currentRepositories: current.data.repositories,
        // With no pin the settings stay the release's, but approval a person
        // turned on after the start still asks.
        pushAttached: meetPushAttached(
          releasePushAttached(agentRow),
          current.data.push_approval ? "ask" : "allow",
        ),
      };
    }
    const started = pinUnderSwitches(pin.data);
    return {
      ...UNSET,
      source: "release",
      settings: meetGitHubSettings(started, current.data),
      agentSettingsRevision: agentRow.revision,
      startActionsAllow: started.actions_allow,
      pushAttached: releasePushAttached(agentRow),
    };
  }
  if (input.source !== "agent") {
    return {
      ...UNSET,
      pushAttached: "ask",
      source: "agent",
      settings: "invalid",
    };
  }
  if (agentRow === null || current === null) {
    return { ...UNSET, source: "agent", settings: GITHUB_POLICY_CLOSED };
  }
  if (!current.success) return invalid("agent");
  const base = {
    ...UNSET,
    source: "agent" as const,
    startRepositoryId: agentRow.startRepositoryId,
    agentSettingsRevision: agentRow.revision,
  };
  if (input.start === null || input.start === undefined) {
    return {
      ...base,
      settings: current.data,
      // A session with no snapshot reads the row as it is now.
      pushAttached: pushAttachedOf(agentRow.pushAttached),
    };
  }
  const start = githubPolicyStartSchema.safeParse(input.start);
  if (!start.success) return invalid("agent");
  const met = meetGitHubSettings(start.data.settings, current.data);
  return {
    ...base,
    // Only the repository list is released from the start snapshot, and only
    // for a session that keeps its own attached list. Features, push approval
    // and the Actions allow-list stay capped at what the session started with.
    settings: Array.isArray(input.attachedRepositoryIds)
      ? { ...met, repositories: current.data.repositories }
      : met,
    pushAttached: meetPushAttached(
      pushAttachedOf(start.data.push_attached),
      pushAttachedOf(agentRow.pushAttached),
    ),
    startActionsAllow: start.data.settings.actions_allow,
    enabledAtStart: start.data.enabled,
  };
}

/** The policy a session started now would run on: the agent's row, if any. */
export function newSessionGitHubPolicy(
  agentRow: AgentGitHubSettingsRow | null,
  releasePin: unknown,
): EffectiveGitHubPolicy {
  return effectiveGitHubPolicy({
    source: agentRow === null ? "release" : "agent",
    releasePin,
    agentRow,
  });
}

/**
 * The repository a session starts on: the one the caller named, else none.
 * An agent with a settings row starts without a repository and attaches what
 * the task needs; `start_repository_id` stays on the row but no longer starts
 * anything. An agent with no row keeps its release's repository.
 */
export function startRepositoryOf(
  requested: string | null | undefined,
  policy: EffectiveGitHubPolicy,
  releaseRepositoryId: string | null | undefined,
): string | null {
  return (
    requested ??
    (policy.source === "release" ? releaseRepositoryId : null) ??
    null
  );
}

/**
 * The tool policy a release runs under, resolved: `per_tool` names every
 * effective tool, plus any MCP tool the card named. `default.mcp` covers the
 * MCP tools a remote server only reveals at run time.
 *
 * `tools` is absent only on a release stored before policies existed
 * (`{}`); every release created now carries it.
 */
export const policyPinsSchema = z
  .object({
    tools: z
      .object({
        default: toolPolicyDefaultsSchema,
        per_tool: z.record(toolNameSchema, toolPolicySchema),
      })
      .strict()
      .optional(),
    /**
     * Absent on every release made before it, and on one with no repository.
     * Read as stored: a switch a newer build pinned is kept, for the id.
     */
    github: releasePinGitHubSchema.optional(),
  })
  .strict();

/**
 * How people name a release: the second it was made in Asia/Seoul, as
 * `2026-10-30_14:30:28`. A release made later in the same second of the
 * same agent gets `-2`, `-3`, … in (created_at, id) order. The release id
 * stays the identifier.
 */
export const releaseLabelSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}(-([2-9]|[1-9]\d+))?$/);

/**
 * A version pinned to the runtime settings it was released against.
 *
 * The resolved config travels with the release so a connection or card
 * edit cannot change an in-flight session. Everything but `created_by`,
 * `approved_by`, `label` and the timestamps goes into the release id.
 */
/** How much of an agent's instruction file its conversation judgment reads. */
export const JUDGMENT_INSTRUCTIONS_MAX_BYTES = 4_096;

export const instructionsCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The repository's root instruction file as it was when the release was made,
 * chosen by the rules a session's worker reads it by. The conversation
 * judgment reads only this, never the repository: a push reaches it with
 * the next release. Sessions still read the whole file at their own commit.
 */
export const releaseInstructionsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_repository") }).strict(),
  z
    .object({
      kind: z.literal("absent"),
      repository_id: z.string().min(1).max(128),
      commit: instructionsCommitSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      repository_id: z.string().min(1).max(128),
      commit: instructionsCommitSchema,
      /** The file name the text was found under (an import's target). */
      file: z.string().min(1).max(4096),
      /** At most JUDGMENT_INSTRUCTIONS_MAX_BYTES UTF-8 bytes. */
      text: z
        .string()
        .refine((text) => utf8Bytes(text) <= JUDGMENT_INSTRUCTIONS_MAX_BYTES),
      /** The file's UTF-8 bytes before the cut. */
      bytes: z.number().int().nonnegative(),
      /** Only its start is kept: the file passed JUDGMENT_INSTRUCTIONS_MAX_BYTES. */
      truncated: z.boolean(),
    })
    .strict(),
  // The file is there and the rules refuse it, as a session's worker would.
  z
    .object({
      kind: z.literal("refused"),
      repository_id: z.string().min(1).max(128),
      commit: instructionsCommitSchema,
      reason: z.string().min(1).max(500),
    })
    .strict(),
  // Nothing was read; the release was made anyway.
  z
    .object({
      kind: z.literal("read_failed"),
      repository_id: z.string().min(1).max(128),
      reason: z.enum(["not_on_github", "branch_missing", "github_failed"]),
    })
    .strict(),
]);
export type ReleaseInstructions = z.infer<typeof releaseInstructionsSchema>;

/** The text a conversation judgment adds to its fixed criteria, or null. */
export function judgmentInstructionsOf(
  snapshot: ReleaseInstructions | null,
): string | null {
  return snapshot?.kind === "text" && snapshot.text.trim() !== ""
    ? snapshot.text
    : null;
}

export const agentReleaseSchema = z
  .object({
    id: agentReleaseIdSchema,
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card_sha256: sha256HexSchema,
    /** The provider connection the release's model is called through. */
    connection_id: z.string().min(1).max(128),
    /**
     * The catalog repository a session of the release starts on when it names
     * none and the agent has no GitHub settings; an agent with settings starts
     * without one. Null: none.
     */
    repository_id: z.string().min(1).max(128).nullable(),
    runtime_config_snapshot: runtimeConfigSnapshotSchema,
    effective_tools: effectiveToolsSchema,
    policy_pins: policyPinsSchema,
    /** Null on a release made before the snapshot was taken. */
    instructions_snapshot: releaseInstructionsSchema.nullable(),
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    /** Set by the first activation, never by creating the release. */
    approved_by: userIdSchema.nullable(),
    approved_at: timestampSchema.nullable(),
    label: releaseLabelSchema,
    /** Its latest activation, read from the activation history. */
    activated_at: timestampSchema.nullable(),
    /** When the next activation replaced it; null while it is active. */
    deactivated_at: timestampSchema.nullable(),
  })
  .strict();

/**
 * Why a stored release row does not read in this build: its `policy_pins`
 * (a key or a switch value a newer build wrote), or another column.
 */
export const UNREADABLE_RELEASE_REASON_VALUES = [
  "policy_pins_unreadable",
  "row_unreadable",
] as const;
export const unreadableReleaseReasonSchema = z.enum(
  UNREADABLE_RELEASE_REASON_VALUES,
);

/**
 * A release row of the agent this build cannot read. It carries no stored
 * value, only which row and why, so nothing a newer build pinned is echoed.
 */
export const unreadableReleaseSchema = z
  .object({
    id: agentReleaseIdSchema,
    reason_code: unreadableReleaseReasonSchema,
  })
  .strict();

export const agentIdParamsSchema = z.object({ id: agentIdSchema });

/**
 * What a card does when it runs: the card without the fields no run reads
 * (`role`, `instructions`), with `model` set to the model it runs as. Two
 * saves with the same key change nothing a session sees, whichever card
 * version they were saved as.
 */
export function behaviorKey(
  card: AgentCard,
  model: string,
  connectionId: string,
): string {
  const { role: _role, instructions: _instructions, ...behavior } = card;
  const { tool_policy: policy, ...capabilities } = behavior.capabilities;
  return canonicalJsonOfJson({
    card: {
      ...behavior,
      capabilities: {
        ...capabilities,
        per_tool: policy?.per_tool ?? {},
      },
      model,
    },
    connection_id: connectionId,
  });
}

/**
 * A saved card and connection that is not the active release yet: waiting
 * for its release (`failure` null) or refused (`failure` set).
 */
export const agentDraftSchema = z
  .object({
    version_id: agentVersionIdSchema,
    connection_id: z.string().min(1).max(128),
    failure: z.string().min(1).max(128).nullable(),
  })
  .strict();

/** What a session started now runs with, or would once the draft applies. */
export const behaviorValuesSchema = z
  .object({
    connection_id: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
  })
  .strict();

export const effectiveBehaviorSchema = z
  .object({
    /** Null before the first release. */
    applied: behaviorValuesSchema.nullable(),
    /** Null when nothing is waiting or refused. */
    draft: behaviorValuesSchema.nullable(),
  })
  .strict();

export const agentDetailSchema = z
  .object({
    agent: agentSchema,
    versions: z.array(agentVersionSchema),
    /** The rows this build reads; the rest are in `unreadable_releases`. */
    releases: z.array(agentReleaseSchema),
    /** Null also while the active release is one of `unreadable_releases`. */
    active_release: agentReleaseSchema.nullable(),
    unreadable_releases: z.array(unreadableReleaseSchema),
    /** Bumped by every intent to change what the agent does. */
    behavior_revision: z.number().int().min(0).max(INT4_MAX),
    draft: agentDraftSchema.nullable(),
    effective_behavior: effectiveBehaviorSchema,
  })
  .strict();

export const RELEASE_STATUS_VALUES = [
  "applied",
  "saved",
  "failed",
  "unchanged",
  "superseded",
] as const;
export const releaseStatusSchema = z.enum(RELEASE_STATUS_VALUES);

/**
 * How a save ended for the release it asked for. `superseded` is not a
 * failure: a newer save took over and this one changed nothing. `saved` is
 * a save sent with `activate: false`: its release was made and not activated,
 * and the agent's draft holds it.
 */
export const saveReleaseSchema = z
  .object({
    status: releaseStatusSchema,
    reason: z.string().min(1).max(128).nullable(),
    release_id: agentReleaseIdSchema.nullable(),
    /** The version this save wrote or resolved to; null when it sent no card. */
    version_id: agentVersionIdSchema.nullable(),
  })
  .strict();

export const saveAgentResponseSchema = agentDetailSchema
  .extend({ release: saveReleaseSchema })
  .strict();

export const deleteAgentResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();
export type DeleteAgentResponse = z.infer<typeof deleteAgentResponseSchema>;
/** How much of a version's instructions a list summary carries. */
export const AGENT_SUMMARY_INSTRUCTIONS_MAX = 300;
export const AGENT_SLACK_ACTION_VALUES = [
  "events_failed",
  "events_unverified",
  "install",
  "reinstall",
  "home_unset",
] as const;
export type AgentSlackAction = (typeof AGENT_SLACK_ACTION_VALUES)[number];

/** Where people reach an agent, as the agent list shows it. */
export const AGENT_CHANNEL_VALUES = ["slack", "github"] as const;
export type AgentChannel = (typeof AGENT_CHANNEL_VALUES)[number];

/**
 * What a list shows of an agent beyond its row, read in one go for the page
 * so a list of cards does not ask once per agent. Only with
 * `include=summary`; without it the items are `agentSchema` and `activation`.
 */
export const agentSummarySchema = z
  .object({
    /** The version people talk to, or the newest draft before any release. */
    version: z
      .object({
        version_no: z.number().int().positive(),
        /** Null for a card without one; the agent's `description` replaces it. */
        role: z.string().min(1).max(200).nullable(),
        /** The first AGENT_SUMMARY_INSTRUCTIONS_MAX characters, or null. */
        instructions: z
          .string()
          .min(1)
          .max(AGENT_SUMMARY_INSTRUCTIONS_MAX)
          .nullable(),
        mcp_servers: z.array(mcpServerIdSchema),
        credential_refs: z.array(credentialRefSchema),
      })
      .strict(),
    /** The active release's connection, or null before any activation. */
    connection_id: z.string().min(1).max(128).nullable(),
    /** The active release's, or null before any activation. */
    release_label: releaseLabelSchema.nullable(),
    /**
     * The model the active release runs, or null before any activation. A
     * screen compares it with its connection's model list to warn when the
     * model has left it.
     */
    release_model: z.string().min(1).nullable(),
    /** Names with a live binding on the agent. */
    bound_credential_refs: z.array(credentialRefSchema),
    /** Admins by display name (email when unset), then admin teams by name. */
    admins: z.array(z.string()),
    /**
     * The agent's sessions the caller can see, by the status
     * GET /v1/sessions shows them in.
     */
    needs_input_count: z.number().int().nonnegative(),
    running_count: z.number().int().nonnegative(),
    /**
     * The first thing the agent's Slack tab asks a person to do, or null
     * when it asks nothing (no app, or one that is set up). Not installed:
     * the app was made but never installed, or its bot was disconnected or
     * uninstalled. Installed, in order: Slack has not checked the events
     * Request URL sent, the bot has no home channel, Slack refused the URL.
     */
    slack_action: z.enum(AGENT_SLACK_ACTION_VALUES).nullable(),
    /**
     * The runtime the active release runs (Claude or Codex), or null before
     * any activation.
     */
    engine: runtimeKindSchema.nullable(),
    /**
     * Where people reach the agent, in this order: `slack` once its Slack app
     * is installed (setup steps may remain; `slack_action` names them),
     * `github` while its GitHub switch is on and it has a repository.
     */
    channels: z.array(z.enum(AGENT_CHANNEL_VALUES)),
  })
  .strict();

/**
 * Which `GET /v1/agents/counts` bucket the agent is in: `active` (status
 * `active` with an `active_release_id`: people can talk to it), `draft`
 * (not archived, no `active_release_id` yet), or `inactive` (everything
 * else: paused with a release, or archived). Clients read a value they do
 * not know as not switched on.
 */
export const AGENT_ACTIVATION_INACTIVE = "inactive";
export const AGENT_ACTIVATION_VALUES = [
  "draft",
  "active",
  AGENT_ACTIVATION_INACTIVE,
] as const;
export const agentActivationSchema = z.enum(AGENT_ACTIVATION_VALUES);
export type AgentActivation = z.infer<typeof agentActivationSchema>;

export function agentActivationOf(
  agent: Pick<Agent, "status" | "active_release_id">,
): AgentActivation {
  if (agent.status === "active" && agent.active_release_id !== null)
    return "active";
  if (agent.status !== "archived" && agent.active_release_id === null)
    return "draft";
  return AGENT_ACTIVATION_INACTIVE;
}

export const agentListItemSchema = agentSchema
  .extend({
    status: agentStatusSchema.meta({
      description:
        "The record's state, as before: a draft that was never switched on is `active` too. Do not read it as switched on; read `activation`.",
    }),
    activation: agentActivationSchema.meta({
      description:
        "Whether people can talk to the agent, by the buckets of `GET /v1/agents/counts`: `active` once a release is active and the agent is not paused (counted in `active`), `draft` before any release (counted in `draft`), `inactive` for a paused agent that has a release or an archived one (counted in neither). More values may come within v1: read a value you do not know as not switched on.",
    }),
    summary: agentSummarySchema.optional(),
  })
  .strict();

export const AGENT_SEARCH_MAX_CHARS = 200;
export const AGENT_IDS_MAX = PAGE_LIMIT_MAX;
export const listAgentsQuerySchema = paginationQuerySchema.extend({
  include: z.literal("summary").optional(),
  q: z.string().trim().min(1).max(AGENT_SEARCH_MAX_CHARS).optional().meta({
    description:
      "Keeps the agents whose name or slug contains it, ignoring case. `%` and `_` match themselves.",
  }),
  ids: z
    .string()
    .min(1)
    .max(AGENT_IDS_MAX * 37)
    .transform((value) => value.split(","))
    .pipe(z.array(agentIdSchema).min(1).max(AGENT_IDS_MAX))
    .optional()
    .meta({
      description: `Comma-separated agent ids, at most ${AGENT_IDS_MAX}: keeps those of them in the workspace, in the list's order. An id of no agent there is left out.`,
    }),
  connection_id: z.string().min(1).max(128).optional().meta({
    description:
      "Keeps the agents whose active release runs on this provider connection. An agent with no active release is left out, and so is one whose settings the caller does not read: the connection is one of them.",
  }),
  ownerless: z.literal("true").optional().meta({
    description:
      "Keeps the agents no one live administers now (`ownerless` true).",
  }),
});
export const listAgentsResponseSchema = pageSchema(agentListItemSchema).extend(
  // Only with include=summary: the sessions the summaries count.
  { private_channels_pending: privateChannelsPendingSchema },
);
const agentCountSchema = z.number().int().nonnegative();
export const countAgentsResponseSchema = z.object({
  counts: z
    .object({
      all: agentCountSchema.meta({
        description:
          "How many agents GET /v1/agents lists, read to the last page.",
      }),
      administered: agentCountSchema.meta({
        description:
          "How many of those the caller administers now, directly or through a team.",
      }),
      active: agentCountSchema.meta({
        description:
          "How many of `all` are `active` with an `active_release_id`: the agents people can talk to.",
      }),
      draft: agentCountSchema.meta({
        description:
          "How many of `all` are not `archived` and have no `active_release_id` yet.",
      }),
      inactive: agentCountSchema.meta({
        description:
          "How many of `all` are in neither `active` nor `draft`: paused with an `active_release_id`, or archived. `active`, `draft` and `inactive` add up to `all`.",
      }),
      ownerless: agentCountSchema.meta({
        description:
          "How many of `all` no one live administers now (`ownerless` true).",
      }),
    })
    .strict(),
});

const saveActivateSchema = z.boolean().optional().meta({
  description:
    "Whether a save that changes what the agent does activates the release it makes. Omitted, true. With false the release is made but not activated (`release.status: saved`): the agent's draft keeps the change, a preview session (`POST /v1/sessions` with `preview: true`) can try it, and `POST /v1/agents/{id}/activate` publishes it. An agent with no active release is unpublished: only its admins and the workspace's owners and admins see it.",
});

/** Creates the agent and its first version; nothing is released. */
export const createAgentRequestSchema = z
  .object({
    slug: agentSlugSchema,
    name: agentNameInputSchema,
    description: agentDescriptionInputSchema
      .transform((description) => description ?? undefined)
      .optional(),
    /**
     * Owners and admins name any live team; anyone else only a team they are
     * in.
     */
    managing_team_id: z.uuid({
      error: (issue) =>
        issue.input === undefined ? "managing_team_id is required" : undefined,
    }),
    card: agentCardRequestSchema,
    /**
     * The provider connection the first release runs on. With it the save
     * makes and activates that release; without it the agent stays a draft.
     */
    connection_id: z.string().min(1).max(128).optional(),
    activate: saveActivateSchema,
  })
  .strict();
/**
 * A `card` adds a version unless it equals one the agent already has;
 * `name` and `description` change the row only. A card or a connection
 * changes what the agent does: the save then makes a release of it and
 * activates it, unless it equals what the agent already runs (`unchanged`).
 * A connection alone re-saves the card the agent runs now.
 */
export const updateAgentRequestSchema = z
  .object({
    name: agentNameInputSchema.optional(),
    description: agentDescriptionInputSchema.nullable().optional(),
    /** Changes the row only, at once; no release is made. */
    auto_model_migration: z.boolean().optional(),
    card: agentCardRequestSchema.optional(),
    /** Absent: the connection the agent's draft names, else the one it runs on. */
    connection_id: z.string().min(1).max(128).optional(),
    activate: saveActivateSchema,
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "at least one field is required",
  );

export const createAgentReleaseRequestSchema = z
  .object({
    version_id: agentVersionIdSchema,
    connection_id: z.string().min(1).max(128),
    repository_id: z.string().min(1).max(128).optional(),
    /** Absent: the active release's, unless this one has no repository. */
    github: agentGitHubInputSchema.optional(),
  })
  .strict();
/** `created: false` when the same content was released before. */
export const createAgentReleaseResponseSchema = z
  .object({ release: agentReleaseSchema, created: z.boolean() })
  .strict();

/** CAS: a stale `expected_revision` answers 409 REVISION_CONFLICT. */
export const activateAgentRequestSchema = z
  .object({
    release_id: agentReleaseIdSchema,
    expected_revision: activationRevisionSchema,
  })
  .strict();
/** `receipt_id` is null when the release was already active (a no-op). */
export const activateAgentResponseSchema = z
  .object({
    active_release_id: agentReleaseIdSchema,
    previous_release_id: agentReleaseIdSchema.nullable(),
    activation_revision: activationRevisionSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/**
 * GET /v1/connections: the provider connections an agent release may name,
 * with the models each offers. Only what an editor picks by: the endpoint
 * and the credential stay with the operator.
 */
export const connectionOptionSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: providerKindSchema,
    /** `none`: calls through it are not billed per token. */
    billing: z.enum(["metered", "none"]),
    models: z.array(z.string().min(1).max(128)),
    /**
     * Each model the connection dropped that has a successor, with the listed
     * model of the same series a session on it moves to at its next turn.
     */
    model_successors: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
export const listConnectionOptionsResponseSchema = z
  .object({ items: z.array(connectionOptionSchema) })
  .strict();

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;
export type AgentCardRequest = z.infer<typeof agentCardRequestSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentListItem = z.infer<typeof agentListItemSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export type EffectiveTools = z.infer<typeof effectiveToolsSchema>;
export type AgentRelease = z.infer<typeof agentReleaseSchema>;

// The model a release's sessions run unless they name another: its card's.
export function releaseModel(
  release: Pick<AgentRelease, "runtime_config_snapshot"> | null,
): string | undefined {
  const model = release?.runtime_config_snapshot.model;
  return typeof model === "string" ? model : undefined;
}

// The model a release's conversation judgments call: its card's judgment
// model, else its card's.
export function releaseJudgmentModel(
  release: Pick<AgentRelease, "runtime_config_snapshot"> | null,
): string | undefined {
  const model = release?.runtime_config_snapshot.judgment_model;
  return typeof model === "string" ? model : releaseModel(release);
}
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type UnreadableRelease = z.infer<typeof unreadableReleaseSchema>;
export type UnreadableReleaseReason = z.infer<
  typeof unreadableReleaseReasonSchema
>;
export type BehaviorValues = z.infer<typeof behaviorValuesSchema>;
export type SaveRelease = z.infer<typeof saveReleaseSchema>;
export type SaveAgentResponse = z.infer<typeof saveAgentResponseSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type CountAgentsResponse = z.infer<typeof countAgentsResponseSchema>;
export type PolicyPins = z.infer<typeof policyPinsSchema>;
export type AgentGitHub = z.infer<typeof agentGitHubSchema>;
export type AgentGitHubSettings = z.infer<typeof agentGitHubSettingsSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type CreateAgentReleaseRequest = z.infer<
  typeof createAgentReleaseRequestSchema
>;
export type CreateAgentReleaseResponse = z.infer<
  typeof createAgentReleaseResponseSchema
>;
export type ActivateAgentRequest = z.infer<typeof activateAgentRequestSchema>;
export type ActivateAgentResponse = z.infer<typeof activateAgentResponseSchema>;
export type ConnectionOption = z.infer<typeof connectionOptionSchema>;
export type ListConnectionOptionsResponse = z.infer<
  typeof listConnectionOptionsResponseSchema
>;
