import { z } from "zod";

import {
  surfaceCeilingSchema,
  surfaceChannelKindSchema,
  surfaceKindSchema,
} from "../kollegium/surfaces.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  grantIdSchema,
  installationIdSchema,
  opaqueIdSchema,
  ownerScopeSchema,
  revisionSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Scopes and roles
// ---------------------------------------------------------------------------

// API keys and users share this scope vocabulary; users derive it from a role
// so one ceiling check covers both authentication paths.
export const SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
] as const;
export const sessionScopeSchema = z.enum(SESSION_SCOPE_VALUES);

export const WORKSPACE_ROLE_VALUES = ["owner", "admin", "member"] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLE_VALUES);

export type SessionScope = z.infer<typeof sessionScopeSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

// Owner gets everything; admin and member everything but recovery
// (admin's session rights are a member's).
const MEMBER_SCOPES = SESSION_SCOPE_VALUES.filter(
  (scope) => scope !== "sessions:recover",
);

export function scopesForRole(role: WorkspaceRole): readonly SessionScope[] {
  return role === "owner" ? SESSION_SCOPE_VALUES : MEMBER_SCOPES;
}

/**
 * The scopes in `held` that `ceiling` does not allow. Every schema that
 * carries a scope list next to the thing that bounds it — a role, a
 * principal — checks itself with this, so no response can describe an
 * authority its own ceiling refuses.
 */
export function scopesExceeding(
  held: readonly SessionScope[],
  ceiling: readonly SessionScope[],
): SessionScope[] {
  const allowed = new Set(ceiling);
  return held.filter((scope) => !allowed.has(scope));
}

// ---------------------------------------------------------------------------
// Principal and authorization context
// ---------------------------------------------------------------------------

export const PRINCIPAL_KIND_VALUES = [
  "api_key",
  "user",
  "installation",
] as const;
export const principalKindSchema = z.enum(PRINCIPAL_KIND_VALUES);

/**
 * A chat installation's ceiling. Recovery is an operator power and a chat
 * app is not an operator, so it is not in the vocabulary an installation
 * can even name.
 */
export const INSTALLATION_SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
] as const;
export const installationSessionScopeSchema = z.enum(
  INSTALLATION_SESSION_SCOPE_VALUES,
);

/**
 * Just enough to name who is acting; the full principal carries the ceiling.
 * The id is uncapped because each kind mints its own: a legacy api key is
 * named by the owner partition, which is unconstrained `text`. A ref narrower
 * than the thing it names would reject an existing tenant outright.
 */
export const principalRefSchema = z
  .object({ kind: principalKindSchema, id: z.string().min(1) })
  .strict();

export const ACTOR_KIND_VALUES = ["user", "service"] as const;
export const actorKindSchema = z.enum(ACTOR_KIND_VALUES);
export const actorRefSchema = z
  .object({ kind: actorKindSchema, id: opaqueIdSchema })
  .strict();
// Where a field means one or the other and swapping them would move
// authority, name which one it is rather than accept either.
export const humanActorSchema = actorRefSchema.extend({
  kind: z.literal("user"),
});
export const serviceActorSchema = actorRefSchema.extend({
  kind: z.literal("service"),
});

export const principalSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("api_key"),
        // Uncapped for the reason principalRefSchema gives.
        id: z.string().min(1),
        owner_id: ownerScopeSchema,
        // Legacy keys predate workspaces and stay unmapped until an explicit
        // owner_workspace_map row exists.
        workspace_id: workspaceIdSchema.nullable(),
        scopes: z.array(sessionScopeSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("user"),
        id: userIdSchema,
        workspace_id: workspaceIdSchema,
        role: workspaceRoleSchema,
        scopes: z.array(sessionScopeSchema),
      })
      .strict(),
    // A signed chat webhook carries no bearer key, so what authenticated is
    // the installation, not the person who typed. The human stays
    // the actor: the app's authority is never inherited by them, and theirs is
    // never lent to the app. A Slack user with no internal mapping still
    // produces a representable context — it simply has no `actor_user_id`, and
    // admission fails on identity rather than on a malformed principal.
    z
      .object({
        kind: z.literal("installation"),
        id: installationIdSchema,
        /** The workspace's server-issued service owner, never the chat team id. */
        owner_id: ownerScopeSchema,
        workspace_id: workspaceIdSchema,
        scopes: z.array(installationSessionScopeSchema),
      })
      .strict(),
  ])
  .superRefine((principal, ctx) => {
    if (principal.kind !== "user") return;
    // The role is the ceiling, not a label beside it: a membership may hand a
    // user fewer scopes than the role allows, never more. Without this a
    // `member` row carrying `sessions:recover` would walk straight into
    // owner-only recovery.
    for (const scope of scopesExceeding(
      principal.scopes,
      scopesForRole(principal.role),
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `${principal.role} cannot hold ${scope}`,
      });
    }
  });

/**
 * What every route hands to a domain service.
 *
 * `owner_scope` is alpha's partition key: every legacy consumer authorizes on
 * it alone, so an API key request keeps behaving exactly as it did before
 * workspaces existed.
 */
export const authorizationContextSchema = z
  .object({
    principal: principalRefSchema,
    /** The human behind the request when the principal is not itself one. */
    actor_user_id: userIdSchema.optional(),
    /**
     * The installation or app carrying the request. It lends no authority of
     * its own; a grant match compares it, so a context assembled without it
     * cannot ask about a grant that names one.
     */
    service_principal: serviceActorSchema.optional(),
    owner_scope: ownerScopeSchema,
    workspace_id: workspaceIdSchema.optional(),
    /** The ceiling carried with the context, never re-derived downstream. */
    scopes: z.array(sessionScopeSchema),
  })
  .strict()
  .superRefine((ctx_, ctx) => {
    // Middleware assembles a context by hand, so the relationships between
    // its parts are stated here. What a schema cannot check is whether the
    // user really belongs to that workspace or whether the scopes match their
    // role — the context carries no role, and membership is a row. It can
    // check that the parts agree with each other, which is
    // what stops a hand-built context from authorizing against another
    // tenant's partition.
    if (ctx_.principal.kind === "installation") {
      // What this cannot reach: whether `owner_scope` and `workspace_id` are
      // the ones the authenticated installation actually belongs to. Unlike a
      // user — whose partition IS its workspace, so the two must agree — an
      // installation's owner is a separate service owner, and no relation
      // between the three is checkable from the context alone. Closing it
      // means carrying the whole principal here instead of a ref, which is a
      // different contract from this schema.
      //
      // What authenticated is also what acts for the human, so a context
      // claiming installation A must not match grants naming service B.
      if (ctx_.service_principal?.id !== ctx_.principal.id) {
        ctx.addIssue({
          code: "custom",
          path: ["service_principal"],
          message: "an installation is its own service principal",
        });
      }
      if (ctx_.workspace_id === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace_id"],
          message: "an installation always has a workspace",
        });
      }
      // The context's `scopes` is the general vocabulary, so the ceiling
      // `principalSchema` puts on an installation has to be repeated where a
      // context is validated directly — otherwise middleware hands a chat app
      // operator-only recovery and nothing objects.
      for (const scope of scopesExceeding(
        ctx_.scopes,
        INSTALLATION_SESSION_SCOPE_VALUES,
      )) {
        ctx.addIssue({
          code: "custom",
          path: ["scopes"],
          message: `an installation cannot hold ${scope}`,
        });
      }
      return;
    }
    if (ctx_.principal.kind !== "user") return;
    if (ctx_.actor_user_id !== ctx_.principal.id) {
      ctx.addIssue({
        code: "custom",
        path: ["actor_user_id"],
        message: "a user principal acts as itself",
      });
    }
    if (ctx_.workspace_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace_id"],
        message: "a user principal always has a workspace",
      });
      return;
    }
    if (ctx_.owner_scope !== ctx_.workspace_id) {
      ctx.addIssue({
        code: "custom",
        path: ["owner_scope"],
        message: "a user's owner partition is their workspace",
      });
    }
  });

export type PrincipalRef = z.infer<typeof principalRefSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>;

// ---------------------------------------------------------------------------
// Actors, resources and audiences
// ---------------------------------------------------------------------------

// The resource vocabulary the receipt target union and Grant share.
export const RESOURCE_KIND_VALUES = [
  "workspace",
  "session",
  "invite",
  "agent",
  "agent_release",
  "surface_binding",
  "session_link",
  "dispatch",
  "memory",
  "routine",
  "artifact",
  // Receipt targets only: no action is granted on a key or a team.
  "api_key",
  "team",
  // Receipt targets only: a stored extension bundle.
  "extension_bundle",
] as const;
export const resourceKindSchema = z.enum(RESOURCE_KIND_VALUES);
export const resourceRefSchema = z
  .object({ kind: resourceKindSchema, id: z.string().min(1).max(512) })
  .strict();

export const AUDIENCE_KIND_VALUES = [
  "workspace",
  "surface_binding",
  "session_link",
  "session",
] as const;
export const audienceKindSchema = z.enum(AUDIENCE_KIND_VALUES);
export const audienceRefSchema = z
  .object({ kind: audienceKindSchema, id: z.string().min(1).max(512) })
  .strict();

export const AUTHORIZATION_ACTION_VALUES = [
  "workspace.read",
  "workspace.manage",
  // Owner-only, unlike the rest of the workspace settings.
  "audit_retention.manage",
  // Invites, roles, offboarding and taking over what a member leaves behind.
  "member.manage",
  "team.manage",
  // Issuing and revoking agent keys: on the workspace, any agent's; on an
  // agent, that agent's.
  "api_key.manage",
  // Issuing and revoking the caller's own personal keys.
  "api_key.manage_own",
  // Linking and unlinking the caller's own account on another service.
  "account.link",
  // Any member may create an agent and becomes its admin.
  "agent.create",
  // An agent's information (name, slug, description, managing team, status,
  // active release id): its list row. On the workspace, listing at all.
  "agent.read",
  // An agent's settings (card, versions, releases, admins, credential
  // bindings, GitHub, Slack) read without changing them (agent-rbac (b)).
  "agent.settings_read",
  "agent.manage",
  // Bringing an archived agent back is the owner's alone.
  "agent.restore",
  "agent.admin.manage",
  // Who may use an agent: its scope and teams.
  "agent.usage.manage",
  "credential.bind",
  // User variables (E-41): a workspace's own, and one agent's.
  "variable.workspace.manage",
  "variable.agent.manage",
  "binding.manage",
  "binding.approve",
  "routine.manage",
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
  "session.recover",
  // Changing who sees a session: its creator, or for a key's session the
  // workspace's managers and the agent's admins.
  "session.share",
  // Renaming a session: whoever answers its requests and nobody
  // who only sees it through its share.
  "session.rename",
  // Reading a session outside its share, read-only and with a reason.
  "session.audit_read",
  // Every session's metadata, none of its content.
  "session.admin_list",
  // Figures summed over every owner: GET /v1/limits and the installation
  // usage summary (the owner's alone).
  "usage.installation_read",
  // One agent's summed usage: its workspace's managers and its admins,
  // recorded under its own name rather than agent.manage.
  "usage.agent_read",
  // The installation's connections, repositories and remote MCP servers,
  // and the settings document that exports and imports them: the owner
  // (docs/contributing/decisions/settings-replace-file-catalog.md §3).
  "installation.settings.manage",
  // Achievement categories, types, rules and the judge settings
  // (docs/contributing/decisions/achievement-rules.md §5).
  "achievement_rule.manage",
  // Confirming or rejecting an achievement: managers and its agent's admins.
  "achievement.review",
  "memory.read",
  "memory.write",
  "artifact.read",
  "delivery.send",
] as const;
export const authorizationActionSchema = z.enum(AUTHORIZATION_ACTION_VALUES);

export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type AuthorizationAction = z.infer<typeof authorizationActionSchema>;

// Ported from Kollegium v1 `core/src/schema.ts`: an action can only ever be
// granted on a resource type it makes sense for, so a `session.read` grant
// cannot be widened into workspace-wide reads by swapping the resource.
const ACTION_RESOURCE_KINDS: Record<
  AuthorizationAction,
  ReadonlySet<ResourceKind>
> = {
  "workspace.read": new Set(["workspace"]),
  "workspace.manage": new Set(["workspace"]),
  "audit_retention.manage": new Set(["workspace"]),
  "member.manage": new Set(["workspace", "session"]),
  "team.manage": new Set(["workspace"]),
  "api_key.manage": new Set(["workspace", "agent"]),
  "api_key.manage_own": new Set(["workspace"]),
  "account.link": new Set(["workspace"]),
  "agent.create": new Set(["workspace"]),
  "agent.read": new Set(["workspace", "agent"]),
  "agent.settings_read": new Set(["agent"]),
  "agent.manage": new Set(["workspace", "agent"]),
  "agent.restore": new Set(["agent"]),
  "agent.admin.manage": new Set(["agent"]),
  "agent.usage.manage": new Set(["agent"]),
  "credential.bind": new Set(["agent"]),
  "variable.workspace.manage": new Set(["workspace"]),
  "variable.agent.manage": new Set(["agent"]),
  "binding.manage": new Set(["workspace", "agent", "surface_binding"]),
  "binding.approve": new Set(["workspace", "agent", "surface_binding"]),
  "routine.manage": new Set(["workspace", "agent", "routine"]),
  "session.read": new Set(["session", "session_link"]),
  "session.submit": new Set(["session", "session_link", "surface_binding"]),
  "session.approve": new Set(["session", "session_link"]),
  "session.control": new Set(["session", "session_link"]),
  "session.recover": new Set(["session"]),
  "session.share": new Set(["session"]),
  "session.rename": new Set(["session"]),
  "session.audit_read": new Set(["session"]),
  "session.admin_list": new Set(["workspace"]),
  "usage.installation_read": new Set(["workspace"]),
  "usage.agent_read": new Set(["agent"]),
  "installation.settings.manage": new Set(["workspace"]),
  "achievement_rule.manage": new Set(["workspace"]),
  "achievement.review": new Set(["agent"]),
  "memory.read": new Set(["workspace", "agent", "memory"]),
  "memory.write": new Set(["workspace", "agent", "memory"]),
  "artifact.read": new Set(["artifact", "session"]),
  "delivery.send": new Set(["session", "session_link", "surface_binding"]),
};

export function actionAppliesTo(
  action: AuthorizationAction,
  kind: ResourceKind,
): boolean {
  return ACTION_RESOURCE_KINDS[action]?.has(kind) ?? false;
}

// ---------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------

export const grantSchema = z
  .object({
    grant_id: grantIdSchema,
    workspace_id: workspaceIdSchema,
    actor: actorRefSchema,
    /** The installation or app acting for the actor; null for direct use. */
    service_principal: serviceActorSchema.nullable(),
    actions: z.array(authorizationActionSchema).min(1),
    resource: resourceRefSchema,
    audience: audienceRefSchema,
    /** Never widens the key scope; it can only narrow it. */
    scopes: z.array(sessionScopeSchema),
    revision: revisionSchema,
    revoked_at: timestampSchema.nullable(),
    expires_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    for (const action of grant.actions) {
      if (!ACTION_RESOURCE_KINDS[action].has(grant.resource.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: `${action} cannot grant access to ${grant.resource.kind}`,
        });
      }
    }
    // A grant stored under workspace A must not name workspace B as what it
    // covers: a grant match compares the request's workspace against
    // `workspace_id`, so an inconsistent row plus a request carrying those
    // same B references would otherwise match across the boundary.
    for (const field of ["resource", "audience"] as const) {
      const ref = grant[field];
      if (ref.kind === "workspace" && ref.id !== grant.workspace_id) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "a grant cannot name another workspace",
        });
      }
    }
  });

export type Grant = z.infer<typeof grantSchema>;

// ---------------------------------------------------------------------------
// Actor provenance
// ---------------------------------------------------------------------------

/** What `receipts.actor` stores: the principal plus the human behind it. */
export const receiptActorSchema = z
  .object({
    principal: principalRefSchema,
    actor_user_id: userIdSchema.nullable(),
    agent_id: agentIdSchema.nullable(),
  })
  .strict()
  .superRefine((actor, ctx) => {
    // A receipt is the audit record. A user principal acting as itself is
    // what the context already enforces; a receipt saying otherwise would be
    // provenance that contradicts the request it describes.
    if (
      actor.principal.kind === "user" &&
      actor.actor_user_id !== actor.principal.id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["actor_user_id"],
        message: "a user principal acts as itself",
      });
    }
  });

export type ReceiptActor = z.infer<typeof receiptActorSchema>;

// ---------------------------------------------------------------------------
// The authorize() decision
// ---------------------------------------------------------------------------

/** The partition every existing store reads and writes under. */
export function ownerScopeOf(principal: Principal): string {
  return principal.kind === "user"
    ? principal.workspace_id
    : principal.owner_id;
}

export const AUTHORIZATION_OUTCOME_VALUES = [
  "allow",
  "deny",
  "redact",
  "require_approval",
] as const;
export const authorizationOutcomeSchema = z.enum(AUTHORIZATION_OUTCOME_VALUES);

export const AUTHORIZATION_REASON_VALUES = [
  "ok",
  "not_found",
  "unlinked",
  // An agent starting work with no person or key asking: v1 has no
  // autonomous runs, so this is always a refusal.
  "no_requester",
  "role",
  "surface_ceiling",
  "agent_ceiling",
  // A private agent used by someone outside its teams, admins and managers.
  // A start is answered as a missing release instead.
  "agent_private",
  "caller_limited",
  "disabled",
  "stale_link",
  "credential_unbound",
  "guest_disabled",
  // A Slack Connect user from another organization, whatever the guest
  // setting says: they are no member of this workspace to link.
  "external_user",
  // An audit read, or a manager's action on a session outside its share,
  // that gave no reason.
  "justification_required",
  // An approval by the very key that started the session (GA-8).
  "self_approval",
  // Fail-closed: a throw, a storage error, a malformed request or an
  // action/resource pair the policy has no rule for.
  "error",
] as const;
export const authorizationReasonSchema = z.enum(AUTHORIZATION_REASON_VALUES);

export const SLACK_USER_KIND_VALUES = ["member", "guest", "external"] as const;
export const slackUserKindSchema = z.enum(SLACK_USER_KIND_VALUES);

/**
 * The fields of a Slack user object the decision reads.
 * Not strict: Slack sends many more, and they are dropped.
 */
export const slackUserSchema = z.object({
  id: opaqueIdSchema,
  team_id: opaqueIdSchema,
  is_restricted: z.boolean().optional(),
  is_ultra_restricted: z.boolean().optional(),
  is_stranger: z.boolean().optional(),
  is_external: z.boolean().optional(),
});

/**
 * Who a Slack user is to the workspace that installed the app in
 * `installedTeamId`. A Slack Connect user is not a guest — `is_restricted`
 * stays false for them — so they are told apart first, by the flags Slack
 * sets on strangers and by a team that is not the install's.
 */
export function slackUserKindOf(
  user: z.infer<typeof slackUserSchema>,
  installedTeamId: string,
): SlackUserKind {
  if (user.is_stranger || user.is_external || user.team_id !== installedTeamId)
    return "external";
  if (user.is_restricted || user.is_ultra_restricted) return "guest";
  return "member";
}

export const authorizationSurfaceSchema = z
  .object({
    kind: surfaceKindSchema,
    binding_id: surfaceBindingIdSchema.optional(),
    channel_kind: surfaceChannelKindSchema.optional(),
    slack_user_kind: slackUserKindSchema.optional(),
    // The channel's stored binding's ceiling. It can only narrow: a slack
    // request without one is refused.
    ceiling: surfaceCeilingSchema.optional(),
    // The agent whose Slack app received the input. An installation speaks
    // for that agent alone, so a slack request without one is refused.
    agent_id: agentIdSchema.optional(),
    channel_id: opaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((surface, ctx) => {
    if (surface.kind === "slack") return;
    for (const key of [
      "slack_user_kind",
      "ceiling",
      "agent_id",
      "channel_id",
    ] as const) {
      if (surface[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `only a slack surface carries ${key}`,
        });
      }
    }
  });

/**
 * Who is asking. The whole authenticated principal travels here rather than
 * a ref, so the policy judges the ceiling that authenticated instead of
 * one a caller restated. `null` is an autonomous run: no person or key
 * asked for it.
 */
export const authorizationSubjectSchema = z
  .object({
    principal: principalSchema.nullable(),
    actor_user_id: userIdSchema.optional(),
    linked_account: z
      .object({ id: opaqueIdSchema, revision: revisionSchema })
      .strict()
      .optional(),
    /** The agent acting for the requester, whose ceiling also applies. */
    agent: z
      .object({ agent_id: agentIdSchema, release_id: agentReleaseIdSchema })
      .strict()
      .optional(),
    surface: authorizationSurfaceSchema,
    justification: z.string().min(1).max(1000).optional(),
  })
  .strict();

/**
 * What the action is on. `id` is null for something not yet identified: a
 * session about to be created, a list, or a receipt whose session the store
 * has not read yet. `owner_scope` is the partition the resource lives in;
 * a subject from another partition is told it does not exist.
 */
export const authorizationResourceSchema = z
  .object({
    kind: resourceKindSchema,
    id: z.string().min(1).max(512).nullable(),
    owner_scope: ownerScopeSchema,
    /**
     * The agent a resource not yet identified will belong to: a session about
     * to be created on one of its releases. A resource that exists is read
     * for its agent instead, never told.
     */
    agent_id: agentIdSchema.optional(),
    /**
     * The release that session is to run, so the decision sees the
     * credentials it names are still bound. A stored binding
     * is identified and still starts one.
     */
    release_id: agentReleaseIdSchema.optional(),
  })
  .strict()
  .superRefine((resource, ctx) => {
    for (const key of ["agent_id", "release_id"] as const) {
      if (key === "release_id" && resource.kind === "surface_binding") {
        continue;
      }
      if (resource[key] !== undefined && resource.id !== null) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "an identified resource is read for its agent",
        });
      }
    }
  });

export const authorizationRequestSchema = z
  .object({
    subject: authorizationSubjectSchema,
    action: authorizationActionSchema,
    resource: authorizationResourceSchema,
    request_id: z.string().min(1).max(512),
  })
  .strict();

export const authorizationDecisionSchema = z
  .object({
    outcome: authorizationOutcomeSchema,
    reason_code: authorizationReasonSchema,
    effective_scopes: z.array(sessionScopeSchema),
    redact: z
      .object({ view: z.literal("summary") })
      .strict()
      .optional(),
    approval: z
      .object({ approvers: z.literal("session.approve") })
      .strict()
      .optional(),
    policy_version: z.string().min(1),
    decision_id: z.uuid(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const ok = decision.reason_code === "ok";
    if (
      decision.outcome === "allow" ? !ok : decision.outcome === "deny" && ok
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: `${decision.outcome} cannot carry ${decision.reason_code}`,
      });
    }
  });

export type AuthorizationReason = z.infer<typeof authorizationReasonSchema>;
export type AuthorizationSurface = z.infer<typeof authorizationSurfaceSchema>;
export type SlackUserKind = z.infer<typeof slackUserKindSchema>;
export type SlackUser = z.infer<typeof slackUserSchema>;
export type AuthorizationSubject = z.infer<typeof authorizationSubjectSchema>;
export type AuthorizationResource = z.infer<typeof authorizationResourceSchema>;
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;
