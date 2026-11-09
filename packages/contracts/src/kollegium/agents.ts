import { z } from "zod";

import { githubFeaturesSchema } from "../musterrolle/github-settings.ts";
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
  receiptIdSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { cardEnvDeclarationSchema } from "./env-variables.ts";

export {
  AGENT_DESCRIPTION_MAX_LENGTH,
  CARD_LEGACY_INSTRUCTIONS_MAX_LENGTH,
} from "../shared/agent-card.ts";

export const AGENT_STATUS_VALUES = ["active", "paused", "archived"] as const;
export const agentStatusSchema = z.enum(AGENT_STATUS_VALUES);

export const AGENT_CARD_LANGUAGE_VALUES = ["ko", "en"] as const;
export const AGENT_RULE_SOURCE_VALUES = ["user", "correction"] as const;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const toolNameSchema = z.string().min(1).max(128);

/**
 * The name of a credential held outside Werft — a secret store entry, a
 * remote MCP server connection — never its value (design 4.4).
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

/** What happens when the agent calls a tool. Kiel evaluates it per call (D9). */
export const TOOL_POLICY_VALUES = ["allow", "ask", "deny"] as const;
export const toolPolicySchema = z.enum(TOOL_POLICY_VALUES);

/** Remote MCP server tools are named `mcp__<server>__<tool>` by the SDK. */
export const MCP_TOOL_PREFIX = "mcp__";

export const toolPolicyDefaultsSchema = z
  .object({ builtin: toolPolicySchema, mcp: toolPolicySchema })
  .strict();

/** Same defaults as Managed Agents (D12). */
export const DEFAULT_TOOL_POLICY = {
  builtin: "allow",
  mcp: "ask",
} as const satisfies z.infer<typeof toolPolicyDefaultsSchema>;

const mcpToolNameSchema = toolNameSchema.refine(
  (name) => name.startsWith(MCP_TOOL_PREFIX),
  `must be an ${MCP_TOOL_PREFIX} tool name`,
);

/**
 * A card's say over the MCP tools it calls. Built-in tools follow the runtime
 * profile and have no entry here.
 * TODO(94S-1373): removed with `mcp` when the MCP server moves to agent settings.
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

export const agentCapabilitiesSchema = z
  .object({
    /**
     * The remote MCP server the agent calls, by the operator catalog's id
     * (`mcp_servers.<id>`), which fixes its URL, credential and workspaces.
     * Null for none, so a card written before it keeps its content hash.
     */
    mcp: z.array(cardMcpServerSchema).min(1).max(1).nullable(),
    /** MCP tools the release must not allow. TODO(94S-1373): goes with `mcp`. */
    forbidden: z.array(mcpToolNameSchema).default([]),
    /**
     * Optional, with no default, so a card written before it existed keeps
     * its content hash. Changing it makes a new version, hence a new release.
     */
    tool_policy: cardToolPolicySchema.optional(),
    /**
     * The credentials the agent runs with, by name. Optional for the same
     * reason as `tool_policy`. Each must be bound to the agent before a
     * release of this version activates or starts a session (D11).
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
 * A card as read: model and capability range (03 §4.1). `name` and
 * `description` live on the agent row, not here, so editing them does not
 * mint a new immutable version.
 *
 * `role` and `instructions` never reach a run: new cards leave them out and
 * older ones keep theirs. What steers an agent is the repository's
 * CLAUDE.md / AGENTS.md, never a card field.
 *
 * `.strict()` is what enforces "a card holds no secrets": there is
 * structurally nowhere to put one, and a credential field is rejected rather
 * than silently stored. Credentials stay in the runtime profile.
 */
export const agentCardSchema = z
  .object({
    role: z.string().min(1).max(200).optional(),
    instructions: z
      .string()
      .min(1)
      .max(CARD_LEGACY_INSTRUCTIONS_MAX_LENGTH)
      .optional(),
    language: z.enum(AGENT_CARD_LANGUAGE_VALUES).default("ko"),
    /** Must sit inside the runtime profile's model allowlist. */
    model: z.string().min(1).max(128),
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
 * `tool_policy.per_tool`, and `tool_policy.default`. The profile decides
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
 * A card as stored. Cards written before `tone` was dropped (94S-761) still
 * hold it, and cards from before the built-in tool fields were dropped (94S-1371)
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
     * model leaves the profile's list, neither its release, nor its sessions
     * at their next turn, nor a new session.
     */
    auto_model_migration: z.boolean(),
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

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
// `profile.auth.value`, so handing a resolved config straight to this schema
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

// `env:ANTHROPIC_API_KEY`, `secret:slack/bot`, `vault:kv/data/x#field`. A
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

/** The resolved profile config, with every credential left behind. */
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

/**
 * What an agent's GitHub work may reach, pinned on its release. A release
 * without it runs as before: every repository its profile allows, a person
 * approving each push, no optional permission.
 */
export const agentGitHubSchema = z
  .object({
    /** Catalog repository ids. */
    repositories: z.array(z.string().min(1).max(128)).min(1).max(32),
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
      .max(32),
  })
  .strict();

/**
 * The agent's own GitHub settings, not pinned on any release. Unlike a pin
 * the list may be empty: switched on, with no repository yet.
 */
export const agentGitHubSettingsSchema = agentGitHubSchema.extend({
  repositories: z.array(z.string().min(1).max(128)),
});

/**
 * The bound `push_attached` puts on a push to any repository; the stricter of
 * it and `push_approval` applies (`pushDecisionOf`). Stored on
 * `agent_github_settings.push_attached`, never on a release pin: a pin means
 * `ask`.
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
 * A stored value as it applies. A row saved before the column has none and
 * keeps asking a person (the behavior before the column existed); a value
 * this image does not know is refused, never guessed at.
 */
export function pushAttachedOf(stored: unknown): PushAttached {
  if (stored === null || stored === undefined) return "ask";
  const parsed = pushAttachedSchema.safeParse(stored);
  return parsed.success ? parsed.data : "deny";
}

/**
 * What a push to any repository needs: `allow` pushes without a person, `ask`
 * waits for one, `deny` refuses. One rule for every repository, the stricter
 * of `push_approval` and `push_attached`; `settings` that cannot be applied
 * ask. A caller reads this at run time, so a push intent made under an older
 * rule (its stored class is audit only) is judged again by this one.
 */
export function pushDecisionOf(policy: {
  settings: AgentGitHub | "invalid" | null;
  pushAttached: PushAttached;
}): PushAttached {
  const { settings } = policy;
  const usable = settings !== null && settings !== "invalid";
  const approval: PushAttached =
    usable && !settings.push_approval ? "allow" : "ask";
  const attached = usable
    ? policy.pushAttached
    : meetPushAttached("ask", policy.pushAttached);
  return meetPushAttached(approval, attached);
}

/**
 * The agent's settings as a session read them when it started
 * (`sessions.github_policy_start`). The envelope is not strict so a later
 * image may add a field; `settings` is, so a list this image cannot read
 * closes the session instead of being guessed at.
 */
export const githubPolicyStartSchema = z.object({
  /** `agents.github_enabled` at start: off then stays off for the session. */
  enabled: z.boolean(),
  /** `agent_github_settings.revision` the snapshot was taken from. */
  revision: z.number().int(),
  settings: agentGitHubSettingsSchema,
  /**
   * `push_attached` at start. On the envelope, not in `settings`, so an image
   * from before it still reads the snapshot. Absent: `ask`.
   */
  push_attached: pushAttachedSchema.optional(),
});
export type GitHubPolicyStart = z.infer<typeof githubPolicyStartSchema>;

/**
 * What a session may do when it started under `start` and the settings are
 * `current` now. Only narrows, per field: the repository lists intersect, a
 * push needs approval if either asks for it, a feature needs both.
 * `actions_allow` holds globs and branch meanings, so it is not intersected:
 * the result keeps the current list and the caller also checks the start's.
 */
export function meetGitHubSettings(
  start: AgentGitHub,
  current: AgentGitHub,
): AgentGitHub {
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

/** Which ceiling judges a profile's repositories. */
export const REPOSITORY_SCOPE_VALUES = ["profile", "workspace"] as const;
export type RepositoryScope = (typeof REPOSITORY_SCOPE_VALUES)[number];

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

/** What an agent session reads when it has no row: nothing, a person asked. */
export const GITHUB_POLICY_CLOSED: AgentGitHub = {
  repositories: [],
  push_approval: true,
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
  settings: AgentGitHub | "invalid" | null;
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
   * value of its own and means `ask`; a row can take it to `deny`, never to
   * `allow`.
   */
  pushAttached: PushAttached;
};

/**
 * A release means `ask`; the row a person saved can only take that to `deny`.
 * A row a migration wrote (no `updatedBy`) changes nothing.
 */
function releasePushAttached(row: AgentGitHubSettingsRow): PushAttached {
  return row.updatedBy === null
    ? "ask"
    : meetPushAttached("ask", pushAttachedOf(row.pushAttached));
}

const UNSET = {
  pushAttached: "ask" as PushAttached,
  startRepositoryId: null,
  agentSettingsRevision: null,
  currentRepositories: null,
  startActionsAllow: null,
  enabledAtStart: true,
} as const;

/**
 * The one answer to what GitHub work a session may do (design
 * profile-github 4.2). Everything that judges a session's GitHub work reads
 * this. A value this image cannot read is "invalid", which every reader
 * refuses.
 *
 * - `release`: the pin it started on. A row a person saved narrows it
 *   further (meet with the pin; with no pin only `currentRepositories`). A
 *   row a migration wrote (`updatedBy` null) and no row change nothing.
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
      : agentGitHubSettingsSchema.safeParse({
          repositories: agentRow.repositories,
          push_approval: agentRow.pushApproval,
          features: agentRow.features,
          actions_allow: agentRow.actionsAllow,
        });
  const invalid = (source: GitHubPolicySource): EffectiveGitHubPolicy => ({
    ...UNSET,
    source,
    settings: "invalid",
    agentSettingsRevision: agentRow?.revision ?? null,
  });
  if (input.source === "release") {
    const hasPin = input.releasePin !== null && input.releasePin !== undefined;
    const pin = hasPin ? agentGitHubSchema.safeParse(input.releasePin) : null;
    if (agentRow === null || current === null) {
      if (pin === null) return { ...UNSET, source: "release", settings: null };
      return {
        ...UNSET,
        source: "release",
        settings: pin.success ? pin.data : "invalid",
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
        settings: pin === null ? null : pin.data,
      };
    }
    if (pin === null) {
      return {
        ...UNSET,
        source: "release",
        settings: null,
        agentSettingsRevision: agentRow.revision,
        currentRepositories: current.data.repositories,
        pushAttached: releasePushAttached(agentRow),
      };
    }
    return {
      ...UNSET,
      source: "release",
      settings: meetGitHubSettings(pin.data, current.data),
      agentSettingsRevision: agentRow.revision,
      startActionsAllow: pin.data.actions_allow,
      pushAttached: releasePushAttached(agentRow),
    };
  }
  if (input.source !== "agent") {
    return { ...UNSET, source: "agent", settings: "invalid" };
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
      // A session with no snapshot began before this setting existed, when
      // an attached push always needed a person: later saves only narrow it.
      pushAttached: meetPushAttached(
        "ask",
        pushAttachedOf(agentRow.pushAttached),
      ),
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
      start.data.push_attached ?? "ask",
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
  const policy = effectiveGitHubPolicy({
    source: agentRow === null ? "release" : "agent",
    releasePin,
    agentRow,
  });
  // No snapshot caps an existing session at `ask`; a new session's snapshot is
  // taken from this value, so it starts at the row's own.
  return agentRow !== null && policy.source === "agent"
    ? { ...policy, pushAttached: pushAttachedOf(agentRow.pushAttached) }
    : policy;
}

/**
 * The repository a session starts on: the one the caller named, else none.
 * An agent with a settings row starts without a repository and attaches what
 * the task needs; `start_repository_id` stays on the row but no longer starts
 * anything. An agent with no row keeps its release's repository, because a
 * profile that requires one cannot start without it.
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
    /** Absent on every release made before it, and on one with no repository. */
    github: agentGitHubSchema.optional(),
  })
  .strict();

export const RELEASE_NOTE_MAX_CODE_POINTS = 200;

// Counted in code points, as the column's char_length check counts them.
// Postgres text cannot store NUL, so it is refused here rather than at insert.
const releaseNoteSchema = z
  .string()
  .refine((note) => {
    const length = [...note].length;
    return length >= 1 && length <= RELEASE_NOTE_MAX_CODE_POINTS;
  }, `note must be 1 to ${RELEASE_NOTE_MAX_CODE_POINTS} characters`)
  .refine((note) => !note.includes("\u0000"), "note must not contain NUL");

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
 * The resolved config travels with the release so a profile edit cannot
 * change an in-flight session; a digest mismatch at start is refused and
 * asks for a re-release instead. Everything but `created_by`, `approved_by`,
 * `note`, `label` and the timestamps goes into the release id.
 */
export const agentReleaseSchema = z
  .object({
    id: agentReleaseIdSchema,
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card_sha256: sha256HexSchema,
    runtime_profile_id: z.string().min(1).max(128),
    /**
     * The catalog repository a session of the release starts on when it names
     * none and the agent has no GitHub settings; an agent with settings starts
     * without one. Null: none, as the profile allows.
     */
    repository_id: z.string().min(1).max(128).nullable(),
    profile_digest: z.string().min(1).max(128),
    runtime_config_snapshot: runtimeConfigSnapshotSchema,
    effective_tools: effectiveToolsSchema,
    policy_pins: policyPinsSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    /** Set by the first activation, never by creating the release. */
    approved_by: userIdSchema.nullable(),
    approved_at: timestampSchema.nullable(),
    /** What the person releasing it wrote; a re-release keeps the first. */
    note: releaseNoteSchema.nullable(),
    label: releaseLabelSchema,
    /** Its latest activation, read from the activation history. */
    activated_at: timestampSchema.nullable(),
    /** When the next activation replaced it; null while it is active. */
    deactivated_at: timestampSchema.nullable(),
  })
  .strict();

export const agentIdParamsSchema = z.object({ id: agentIdSchema });

/**
 * Where an agent's run model comes from. `profile`: the profile's default
 * model, followed when that changes. `fixed`: the model a person chose.
 */
export const MODEL_SOURCE_VALUES = ["fixed", "profile"] as const;
export const modelSourceSchema = z.enum(MODEL_SOURCE_VALUES);
export type ModelSource = z.infer<typeof modelSourceSchema>;

/**
 * What a card does when it runs: the card without the fields no run reads
 * (`role`, `instructions`), with `model` set to the model it runs as. Two
 * saves with the same key change nothing a session sees, whichever card
 * version they were saved as.
 */
export function behaviorKey(
  card: AgentCard,
  model: string,
  runtimeProfileId: string,
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
    runtime_profile_id: runtimeProfileId,
  });
}

/**
 * A saved card, profile and model source that is not the active release yet:
 * waiting for its release (`failure` null) or refused (`failure` set).
 */
export const agentDraftSchema = z
  .object({
    version_id: agentVersionIdSchema,
    runtime_profile_id: z.string().min(1).max(128),
    model_source: modelSourceSchema,
    failure: z.string().min(1).max(128).nullable(),
  })
  .strict();

/** What a session started now runs with, or would once the draft applies. */
export const behaviorValuesSchema = z
  .object({
    runtime_profile_id: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    model_source: modelSourceSchema,
    /** The profile's, for sessions' titles only; null when it has none. */
    title_model: z.string().min(1).max(128).nullable(),
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

export const profileTrackingSchema = z.enum(["follow", "pinned"]);

/**
 * An agent's open step of a profile rollout: `pending` waits for the
 * scheduler, `failed` stays until a person retries it (`reason` says why).
 */
export const profileRolloutStepSchema = z
  .object({
    status: z.enum(["pending", "failed"]),
    reason: z.string().min(1).max(128).nullable(),
    target_profile_id: z.string().min(1).max(200),
  })
  .strict();

export const agentDetailSchema = z
  .object({
    agent: agentSchema,
    versions: z.array(agentVersionSchema),
    releases: z.array(agentReleaseSchema),
    active_release: agentReleaseSchema.nullable(),
    /** Bumped by every intent to change what the agent does. */
    behavior_revision: z.number().int().min(0).max(INT4_MAX),
    /** Of the active release; the draft carries its own. */
    model_source: modelSourceSchema,
    draft: agentDraftSchema.nullable(),
    effective_behavior: effectiveBehaviorSchema,
    /**
     * Optional so a reader ahead of its server reads an agent without it.
     * `pinned`: a profile rollout leaves this agent on the profile version it
     * runs; `follow`: it moves to a new version of its profile.
     */
    profile_tracking: profileTrackingSchema.optional(),
    /** The profile rollout step still open for this agent, if any. */
    profile_rollout: profileRolloutStepSchema.nullable().optional(),
  })
  .strict();

export const RELEASE_STATUS_VALUES = [
  "applied",
  "failed",
  "unchanged",
  "superseded",
] as const;
export const releaseStatusSchema = z.enum(RELEASE_STATUS_VALUES);

/**
 * How a save ended for the release it asked for. `superseded` is not a
 * failure: a newer save took over and this one changed nothing.
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

/**
 * What a list shows of an agent beyond its row, read in one go for the page
 * so a list of cards does not ask once per agent. Only with
 * `include=summary`; without it the items are exactly `agentSchema`.
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
    /** The active release's, or null before any activation. */
    runtime_profile_id: z.string().min(1).max(128).nullable(),
    /** The active release's, or null before any activation. */
    release_label: releaseLabelSchema.nullable(),
    /**
     * The model the active release runs, or null before any activation. A
     * screen compares it with its profile's allowed list to warn when the
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
  })
  .strict();

export const agentListItemSchema = agentSchema
  .extend({ summary: agentSummarySchema.optional() })
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
  runtime_profile_id: z.string().min(1).max(128).optional().meta({
    description:
      "Keeps the agents whose active release runs on this runtime profile. An agent with no active release is left out, and so is one whose settings the caller does not read: the profile is one of them.",
  }),
});
export const listAgentsResponseSchema = pageSchema(agentListItemSchema);
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
    })
    .strict(),
});

/** Creates the agent and its first version; nothing is released. */
export const createAgentRequestSchema = z
  .object({
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    description: agentDescriptionSchema.optional(),
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
     * The profile the first release runs on. With it the save makes and
     * activates that release; without it the agent stays a draft.
     */
    runtime_profile_id: z.string().min(1).max(128).optional(),
    /** Absent: `fixed` (the card's model is kept as sent). */
    model_source: modelSourceSchema.optional(),
  })
  .strict();
/**
 * A `card` adds a version unless it equals one the agent already has;
 * `name` and `description` change the row only. A card, a profile or a model
 * source changes what the agent does: the save then makes a release of it and
 * activates it, unless it equals what the agent already runs (`unchanged`).
 * A profile or source alone re-saves the card the agent runs now.
 */
export const updateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: agentDescriptionSchema.nullable().optional(),
    /** Changes the row only, at once; no release is made. */
    auto_model_migration: z.boolean().optional(),
    card: agentCardRequestSchema.optional(),
    /** Absent: the profile the agent runs on, else the one its draft names. */
    runtime_profile_id: z.string().min(1).max(128).optional(),
    /**
     * Absent: the current source while the card's model is the one running,
     * else `fixed`. `profile` runs the profile's default model.
     */
    model_source: modelSourceSchema.optional(),
    /**
     * The agent follows its profile again and runs the newest version of it,
     * the way a profile rollout does. Alone: it names no other field.
     */
    follow_latest_profile: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "at least one field is required",
  )
  .refine(
    (patch) =>
      patch.follow_latest_profile === undefined ||
      Object.keys(patch).length === 1,
    "follow_latest_profile goes alone",
  );

/** One-line hiring: a small model fills the card, a person edits it. */
export const draftAgentRequestSchema = z
  .object({
    prompt: z.string().min(1).max(4_000),
    name: z.string().min(1).max(120).optional(),
  })
  .strict();
export const draftAgentResponseSchema = z
  .object({
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card: agentCardSchema,
  })
  .strict();

export const createAgentReleaseRequestSchema = z
  .object({
    version_id: agentVersionIdSchema,
    runtime_profile_id: z.string().min(1).max(128),
    /** Trimmed; blank is refused. Leaves an existing release's note as is. */
    note: z.string().trim().pipe(releaseNoteSchema).optional(),
    /** Required when the profile's `repository_mode` is `required`, refused when `none`. */
    repository_id: z.string().min(1).max(128).optional(),
    /** Absent: the active release's, unless this one has no repository. */
    github: agentGitHubSchema.optional(),
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

/** config, read-only, so a card can pick a model it is allowed to use. */
export const runtimeProfileSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    fingerprint: z.string().min(1).max(128),
    models: z.array(z.string().min(1).max(128)),
    tools: z.array(toolNameSchema).nullable(),
    mcp: z.array(toolNameSchema).nullable(),
  })
  .strict();

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentRule = z.infer<typeof agentRuleSchema>;
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;
export type AgentCardRequest = z.infer<typeof agentCardRequestSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentListItem = z.infer<typeof agentListItemSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export type EffectiveTools = z.infer<typeof effectiveToolsSchema>;
export type AgentRelease = z.infer<typeof agentReleaseSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type DraftAgentRequest = z.infer<typeof draftAgentRequestSchema>;
export type DraftAgentResponse = z.infer<typeof draftAgentResponseSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type AgentDraft = z.infer<typeof agentDraftSchema>;
export type ProfileTracking = z.infer<typeof profileTrackingSchema>;
export type ProfileRolloutStep = z.infer<typeof profileRolloutStepSchema>;
export type BehaviorValues = z.infer<typeof behaviorValuesSchema>;
export type EffectiveBehavior = z.infer<typeof effectiveBehaviorSchema>;
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;
export type SaveRelease = z.infer<typeof saveReleaseSchema>;
export type SaveAgentResponse = z.infer<typeof saveAgentResponseSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type CountAgentsResponse = z.infer<typeof countAgentsResponseSchema>;
export type PolicyPins = z.infer<typeof policyPinsSchema>;
export type AgentGitHub = z.infer<typeof agentGitHubSchema>;
export type AgentGitHubSettings = z.infer<typeof agentGitHubSettingsSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type CardToolPolicy = z.infer<typeof cardToolPolicySchema>;
export type CreateAgentReleaseRequest = z.infer<
  typeof createAgentReleaseRequestSchema
>;
export type CreateAgentReleaseResponse = z.infer<
  typeof createAgentReleaseResponseSchema
>;
export type ActivateAgentRequest = z.infer<typeof activateAgentRequestSchema>;
export type ActivateAgentResponse = z.infer<typeof activateAgentResponseSchema>;
export type RuntimeProfileSummary = z.infer<typeof runtimeProfileSummarySchema>;
