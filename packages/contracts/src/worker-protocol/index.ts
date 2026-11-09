import { z } from "zod";
import {
  postSessionAnswerRequestSchema,
  rememberRuleSchema,
} from "../api/answer.ts";
import { sessionEventVariants } from "../api/event.ts";
import { repositoryAttachFailureSchema } from "../api/github-mcp.ts";
import { pendingQuestionSchema } from "../api/pending.ts";
import {
  PERMISSION_RULE_MAX_LENGTH,
  PERMISSION_RULES_MAX,
} from "../api/permission-rules.ts";
import {
  attemptStateSchema,
  permissionModeSchema,
  sessionRuntimeSchema,
  terminalTurnStatusSchema,
} from "../api/session.ts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  mcpServerIdSchema,
} from "../kollegium/agents.ts";
import { runtimeEnvSchema } from "../kollegium/env-variables.ts";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "../shared/agent-card.ts";
import { workspaceEnforceSchema } from "../shared/execution.ts";
import {
  attemptIdSchema,
  epochSchema,
  executionIdSchema,
  INT4_MAX,
  opaqueCursorSchema,
  requestIdSchema,
  requiredUnknownSchema,
  revisionSchema,
  sessionIdSchema,
  sha256HexSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";

// Every post-claim call carries the fenced identity the gateway verifies in
// the same transaction as the write.
export const workerScopeSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  attempt_id: attemptIdSchema,
  lease_epoch: epochSchema,
  execution_generation: epochSchema,
  auth_revision: epochSchema,
});

// An object store version id (S3 VersionId): opaque UTF-8, at most 1024
// bytes. "null" is S3's name for the replaceable unversioned slot, so it
// never counts as a pinned version. Same rules as the manifest codec's.
export const objectVersionSchema = z
  .string()
  .min(1)
  .refine((version) => version !== "null", {
    message: 'version "null" is not an immutable version',
  })
  .refine((version) => new TextEncoder().encode(version).byteLength <= 1024, {
    message: "a version id is at most 1024 bytes of UTF-8",
  });

export const checkpointRefSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // The version `putImmutable` answered for the manifest. The server verifies
  // that version, records it on the pointer and restores from it; a server
  // that requires versions refuses a checkpoint without one.
  manifest_version: objectVersionSchema.optional(),
});

// What this worker's image can do beyond the protocol's first version, sent
// on the calls whose answer the server shapes by it (the claim and the
// pending-control poll). The server never stores it: the worker that is
// asking is the one that has to parse the answer. Each key is a promise to
// parse a field an older worker's strict schemas refuse.
//   approval_remember: a permission answer may carry `remember`
//   platform_tool_trust: an `mcp_servers` entry may carry `platform` and
//     `trusted`, and the worker lets the named tools past the engine's
//     permission stage
//   user_env: `runtime_config` may carry `env`, the user variables the engine
//     process is started with
//   permission_rules: `runtime_config` may carry `disallowed_tools`, the deny
//     rules the engine is started with in every permission mode
//   engine_settings: `runtime_config` may carry `engine_settings`, the
//     merged permission and auto mode rules the engine's settings are
//     extended with
// A server older than a key refuses the body as a 400 whose `details.issues`
// names it; the worker sends once more without the refused key, so neither
// side has to deploy first.
export const workerCapabilitiesSchema = z
  .object({
    approval_remember: z.literal(true).optional(),
    platform_tool_trust: z.literal(true).optional(),
    user_env: z.literal(true).optional(),
    permission_rules: z.literal(true).optional(),
    engine_settings: z.literal(true).optional(),
  })
  .strict();

export const bootstrapClaimRequestSchema = z
  .object({
    capabilities: workerCapabilitiesSchema.optional(),
    execution_id: executionIdSchema,
    execution_generation: epochSchema,
    credential: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("launch_nonce"), nonce: z.string().min(1) }),
      z.object({
        kind: z.literal("workload_identity"),
        job_uid: z.string().min(1),
      }),
    ]),
    // The worker image's own combination (`imageFingerprint()`). The claim is
    // refused when it is not the one the launch was reserved under. Absent
    // from workers that predate it.
    image_runtime: z
      .object({
        engine: z.string().min(1),
        sdk_version: z.string().min(1),
        cli_version: z.string().min(1),
        profile_digest_scheme: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
// Retrying bootstrapClaim issues a new credential and revokes the previous
// one, so two retries in flight at once can leave a worker holding the token
// that lost. Before its first accepted call a worker that is answered 401
// claims again: while the attempt has not used a token, the same binding
// comes back with a working credential.

// A capability for one of the egress proxy's credential routes
// never an upstream credential: the proxy asks the gateway what it stands
// for on every request and injects the provider key or repository
// credential itself. It lives exactly as long as the attempt's session
// credential and authorizes nothing on the gateway.
export const egressTokenAuthSchema = z
  .object({ kind: z.literal("egress_token"), token: z.string().min(1) })
  .strict();

// What the session was created against. It is copied from the session row,
// not looked up in the catalog at claim time, so a repository that has since
// left the catalog still describes the workspace this session lives in.
export const workspaceRepositorySchema = z
  .object({
    // Catalog key at creation; null for rows that predate the catalog.
    id: z.string().min(1).nullable(),
    // As the session row holds it. The catalog refuses a URL that carries a
    // credential, but a row from before it may still hold one, so
    // the worker never stores this in a checkout unstripped.
    url: z.string().min(1),
    branch: z.string().min(1),
    // How the worker reaches the repository over the network: an
    // attempt-scoped token for the egress proxy's read-only repository
    // route, which injects the upstream credential the worker never sees.
    // Absent when the URL is not http(s), which only tests use.
    access: egressTokenAuthSchema.optional(),
  })
  .strict();
// Another catalog repository the session's release lets it work on
// (session-multi-repository.md decision 2): a git remote named `id` in the
// workspace, its `branch` fetched through the egress route for `id`.
export const additionalWorkspaceRepositorySchema = workspaceRepositorySchema
  .extend({ id: z.string().min(1) })
  .strict();

// Null for a session accepted without a repository. `additional_repositories`
// is sent only when there is one.
export const workspaceDescriptorSchema = z
  .object({
    repository: workspaceRepositorySchema.nullable(),
    additional_repositories: z
      .array(additionalWorkspaceRepositorySchema)
      .optional(),
  })
  .strict();

// Who the session acts for: its owner partition (`AuthorizationContext.
// owner_scope`), copied from the session row. The worker hashes it into the
// checkpoint fingerprint, which is what keeps two partitions on one
// shared provider endpoint from resuming each other's checkpoints. It is an
// identifier, never a credential, and it names a partition rather than the
// caller of the moment so another member of the same partition can resume.
export const claimPrincipalSchema = z
  .object({ owner_scope: z.string().min(1) })
  .strict();

// `endpoint` is the upstream the proxy will call, not where the worker sends
// its requests: it names the provider for the checkpoint fingerprint and
// the adapter's allowlist, while the traffic goes to the proxy's route.
export const runtimeProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.url(),
      auth: egressTokenAuthSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.url(),
      auth: egressTokenAuthSchema,
    })
    .strict(),
]);
// Which of the checked-out repository's own Claude project settings the run
// takes in. Only its root CLAUDE.md can be let in, as text the worker reads
// itself; the repository's settings.json never loads, because it can carry
// hooks that run commands no permission callback sees, `env` that points the
// engine (and the provider credential) at another endpoint, and permission
// rules that pre-approve tools — and that surface grows with every CLI
// release. There is deliberately no `hooks` switch: the strict object refuses
// one. It becomes a field when an operator-reviewed repository has to run its
// hooks, which also needs a sandbox for what they execute.
//
// Absent on the wire means off, and the gateway leaves it out when it is off:
// a worker built before the field refuses unknown keys, and off is what that
// worker already does. When it is on, such a worker refuses the claim — the
// right answer from a worker that could not honour it.
export const projectSettingsSchema = z
  .object({ claude_md: z.boolean() })
  .strict();

// Everything the engine needs beyond the identity in `runtime`: resolved by
// the server from the profile the session was created with. The provider
// key does not ride here: the egress proxy injects it, and what the
// worker holds is a token that is worthless off the worker network and dies
// with the attempt. That token is still a secret for as long as it lives, so
// nothing here may reach an event, a manifest or a log — see
// `loggableBootstrapClaim`.
// The remote MCP server the session's agent release names. Like the
// provider, `endpoint` is the upstream the proxy calls, named for the
// checkpoint fingerprint, and `binding` is what the token was issued
// against (server, URL and credential name), which the fingerprint names in
// place of the token. The worker calls the proxy's `/mcp/<name>` route from
// its own process and never hands the token to the engine.
//
// Absent when the release names none: a worker built before the field
// refuses unknown keys, which is the right answer from a worker that could
// not call it.
//
// `platform` marks the built-in server and `trusted` names the tools of it
// the server judges itself (push, pull request, repository read), which the
// worker lets past the engine's permission stage. Both are left out for a
// worker that did not announce `platform_tool_trust`: its strict schema
// refuses them, and without them the engine asks as it always did.
export const runtimeMcpServerSchema = z
  .object({
    name: mcpServerIdSchema,
    endpoint: z.url(),
    binding: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    access: egressTokenAuthSchema,
    platform: z.literal(true).optional(),
    trusted: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

// `owner/repo`, the name people know a GitHub repository by; a catalog URL
// with any other path names no repository here.
export const githubRepositoryNameSchema = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export const PLATFORM_PROMPT_SURFACE_VALUES = [
  "slack_channel",
  "slack_dm",
  "console",
  "api",
] as const;

// What the worker renders the platform's paragraph of the system prompt
// from: who the agent is, where the session started and its repository, as
// the session was created. It is part of the checkpoint fingerprint, so the
// platform stores it on the session once and never re-reads the agent or the
// catalog for it. Whether GitHub is set up changes while a session runs, so
// it is not here: the GitHub tools answer it. A new revision is a new
// literal next to this one.
export const platformPromptSchema = z
  .object({
    // 2 differs from 1 only in how the worker words `request_push`: this
    // turn's commit is pushed (AGENT_ACTION_FLOWS on at session creation).
    // 3 adds to 2 that the pull request is scheduled in the same turn and
    // that a push carries one repository's commit per turn. 4 and 5 are 1 and
    // 3 with the paragraph for a session that starts without a repository;
    // nothing creates them yet, and an older worker refuses them, so they are
    // turned on only after every worker knows them. 6 pushes each repository
    // from its own local branch in the one reply. A session keeps the
    // revision it was created with: the wording is in its fingerprint.
    prompt_revision: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    agent_identity: z
      .object({
        name: z.string().min(1).max(120),
        description: z
          .string()
          .min(1)
          .max(AGENT_DESCRIPTION_MAX_LENGTH)
          .nullable(),
      })
      .strict(),
    origin_surface: z.enum(PLATFORM_PROMPT_SURFACE_VALUES),
    language: z.enum(AGENT_CARD_LANGUAGE_VALUES),
    // The session's own repository.
    repository: githubRepositoryNameSchema.nullable(),
  })
  .strict();

export const runtimeExtensionSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    scope: z.enum(["profile", "workspace", "agent", "session"]),
  })
  .strict();

// The settings the platform merged for one claim: the workspace's and the
// agent's permission rules, and the auto mode classifier's rules in that
// order. The worker appends them after its own baseline rules; it never
// replaces the baseline and never reorders what the platform merged.
// `permissions.deny` takes the pattern form (`Bash(rm:*)`); a rule that names
// a whole tool or an MCP server goes in `disallowed_tools`.
const ENGINE_SETTINGS_RULES_MAX = 128;
// Classifier rules are sentences, not patterns.
const ENGINE_CLASSIFIER_RULES_MAX = 64;
const ENGINE_CLASSIFIER_RULE_MAX_LENGTH = 1024;
const settingsRuleListSchema = z
  .array(z.string().min(1).max(PERMISSION_RULE_MAX_LENGTH))
  .min(1)
  .max(ENGINE_SETTINGS_RULES_MAX);
const classifierRuleListSchema = z
  .array(z.string().min(1).max(ENGINE_CLASSIFIER_RULE_MAX_LENGTH))
  .min(1)
  .max(ENGINE_CLASSIFIER_RULES_MAX);

export const engineSettingsSchema = z
  .object({
    permissions: z
      .object({
        allow: settingsRuleListSchema.optional(),
        ask: settingsRuleListSchema.optional(),
        deny: settingsRuleListSchema.optional(),
      })
      .strict()
      .refine((rules) => Object.keys(rules).length > 0, {
        message: "must not be empty",
      })
      .optional(),
    autoMode: z
      .object({
        allow: classifierRuleListSchema.optional(),
        soft_deny: classifierRuleListSchema.optional(),
        // A rule in the classifier's prompt, not a deterministic permission
        // rule: what must hold goes in `permissions.deny`.
        hard_deny: classifierRuleListSchema.optional(),
        environment: classifierRuleListSchema.optional(),
      })
      .strict()
      .refine((rules) => Object.keys(rules).length > 0, {
        message: "must not be empty",
      })
      .optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "must not be empty",
  });

export const runtimeConfigSchema = z
  .object({
    model: z.string().min(1),
    // With an MCP server, also its `mcp__<name>__<tool>` names the release
    // allows.
    tools: z.array(z.string().min(1)),
    // Deny rules in the engine's spelling, organization and profile merged
    // by the platform. The engine gets them as `disallowedTools`, which holds
    // in every permission mode. Absent when nothing is denied, so a claim
    // without rules stays what it was. In the strict claim config, so a
    // worker that does not know the field refuses the claim instead of
    // running without the rules. Not part of any fingerprint.
    disallowed_tools: z
      .array(z.string().min(1).max(PERMISSION_RULE_MAX_LENGTH))
      .min(1)
      .max(PERMISSION_RULES_MAX)
      .optional(),
    // Workspace and agent settings merged for this claim. Absent when
    // neither sets any, so a claim without them stays what it was. In the
    // strict claim config, so a worker that does not know the field refuses
    // the claim instead of running without a deny. Not part of any
    // fingerprint: the workspace's settings can change between claims.
    engine_settings: engineSettingsSchema.optional(),
    permission_mode: permissionModeSchema,
    provider: runtimeProviderSchema,
    project_settings: projectSettingsSchema.optional(),
    // At most a catalog server and the built-in `github`.
    mcp_servers: z
      .array(runtimeMcpServerSchema)
      .min(1)
      .max(2)
      .refine(
        (servers) =>
          new Set(servers.map((s) => s.name)).size === servers.length,
        { message: "must not repeat a server" },
      )
      .optional(),
    // Here and not at the claim's top level, where an older worker would
    // drop it and run without it: such a worker refuses the claim instead.
    // Absent for a session created without it (revision 0), so its claims
    // and fingerprints stay what they were.
    platform_prompt: platformPromptSchema.optional(),
    // The user variables the session's engine process starts with. Only sent
    // to a worker that announced `user_env`, and absent when there are none,
    // so a session without variables claims exactly as before. Not part of
    // any fingerprint: changing a value must not break a running session.
    env: runtimeEnvSchema.optional(),
    // In the strict claim config, so a worker that does not know the field
    // refuses the claim instead of running without a required bundle.
    extensions: z
      .array(runtimeExtensionSchema)
      .min(1)
      .refine(
        (bundles) =>
          new Set(bundles.map((b) => b.name)).size === bundles.length,
        { message: "must not repeat a bundle name" },
      )
      .optional(),
  })
  .strict();

// The catalog's name for the settings in `runtime_config`: a hash
// of the profile without its credential. The settings still ride in full —
// the engine needs them — and this is what a log line or a later
// comparison can hold instead.
export const profileFingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>");

// The lease as the worker may track it: what was left of it on the
// database clock at an instant after the request was sent. Counted from its
// own send time on a monotonic clock, it can only end early, never late,
// whatever either side's wall clock says. `lease_expires_at` is that same
// deadline as the database clock names it, for logs; no worker judges by it.
export const leaseRemainingMsSchema = z.number().int().nonnegative();

// The worker's lease clock when the launcher sets neither
// WORKER_HEARTBEAT_INTERVAL_SEC nor WORKER_LEASE_SAFETY_MARGIN_SEC, which no
// launcher does. The API refuses a HEARTBEAT_TTL_SEC that cannot cover both:
// with less, every attempt gives its lease up at or near its first beat.
// A beat that cannot renew — its session row held by another transaction —
// costs the next one a whole interval, so the default lease's 20s budget
// rides out a stall of that budget less one interval: 15s here.
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_LEASE_SAFETY_MARGIN_MS = 10_000;

// The worker's exit status once it stopped owning its session, so whoever
// reclaims the execution can record that without reading its output.
export const WORKER_EXIT_LEASE_LOST = 75;

// How many earlier profiles a claim offers for a restore: one per change the
// checkpoints still reachable from the pointer went through, at most.
export const MAX_RESTORE_PROFILES = 16;

// What a restore plan request may list: for the claim's config and each earlier
// profile, the digest of its current form, of the form an older session was
// stamped with, and of each of those under the one earlier digest scheme an
// image still resumes. Platform deploys before worker, so a gateway that
// reads this limit is up before a worker sends past the old one.
export const MAX_RESTORE_ALTERNATES = 4 * (MAX_RESTORE_PROFILES + 1);

export const permissionGrantSchema = z
  .object({
    request_id: requestIdSchema,
    turn_id: turnIdSchema,
    tool: z.string().min(1),
    input_hash: sha256HexSchema,
    // The rules the person agreed to keep allowing for the session. Present
    // only for a worker that announced `approval_remember`; the resumed
    // engine asks again, and installs a rule only if it offers exactly these.
    remember_offer: z.array(rememberRuleSchema).min(1).optional(),
  })
  .strict();

// No CR, LF or NUL: each value becomes one trailer line.
const trailerValueSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\r\n\0]+$/);

export const claimGitSchema = z
  .object({
    co_author: z
      .object({ name: trailerValueSchema, email: trailerValueSchema })
      .strict()
      .nullable(),
    session_url: trailerValueSchema.nullable(),
  })
  .strict();

export const claimGitAuthorSchema = z
  .object({ name: trailerValueSchema, email: trailerValueSchema })
  .strict();

/**
 * The emails of the co-author lines engines add on their own, which no
 * session commit keeps (decision github-agent.md D1). The one list: claims
 * hand it to the worker's hook, and the push check reads it here. A list only
 * grows while an image that still adds a removed email may run.
 */
export const ENGINE_COAUTHOR_EMAILS = ["noreply@anthropic.com"] as const;

/**
 * The author and committer of a worker image's commits when a claim names no
 * App bot (apps/worker/Dockerfile sets the same pair in the image's git
 * config). A push expects it for such a claim.
 */
export const IMAGE_GIT_AUTHOR = {
  name: "Werft",
  email: "noreply@werft.invalid",
} as const;

export const claimGitStripSchema = z
  .array(
    z
      .string()
      .min(3)
      .max(254)
      .regex(/^[^\s<>@]+@[^\s<>@]+$/),
  )
  .max(32);

export const bootstrapClaimResponseSchema = workerScopeSchema.extend({
  session_credential: z.string().min(1),
  lease_expires_at: timestampSchema,
  lease_remaining_ms: leaseRemainingMsSchema,
  runtime: sessionRuntimeSchema,
  profile_fingerprint: profileFingerprintSchema,
  runtime_config: runtimeConfigSchema,
  workspace: workspaceDescriptorSchema,
  // The object store route's capability: the worker holds no
  // object store credential, only this token, which reaches its session's
  // prefix for as long as the attempt owns the session.
  object_store: z.object({ access: egressTokenAuthSchema }).strict(),
  // The packages route's capability: public package registries, read
  // through the egress proxy with no credential. Absent from an older API;
  // a worker then points no package manager at the route.
  // `github` names the GitHub Packages owners the workspace allows, so the
  // worker can point their npm scopes and gem sources at the route; whether
  // a request is allowed is still the authorizer's to decide.
  packages: z
    .object({
      access: egressTokenAuthSchema,
      github: z
        .object({
          npm: z.array(z.string().min(1).max(39)).max(200),
          rubygems: z.array(z.string().min(1).max(39)).max(200),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  principal: claimPrincipalSchema,
  restore: checkpointRefSchema.nullable(),
  // Present when the session's checkpoints up to `restore` were committed
  // under other profiles than the one it runs now (its profile was changed):
  // the checkpoint restored, the pointer's or a fallback's, may be checked
  // against any of these configs. The engine runs on runtime_config.
  restore_runtime_configs: z
    .array(runtimeConfigSchema)
    .min(1)
    .max(MAX_RESTORE_PROFILES)
    .optional(),
  // SESSION_COST_LIMIT_USD less what the session had spent at the claim: the
  // most this attempt's engine may spend before it ends the turn in flight
  // . A second line only; the gate stays the stored sum against the
  // limit, checked before every turn. Null when the session's profile
  // declared `billing: none`: no dollar limit applies to it.
  remaining_budget_usd: z.number().nonnegative().nullable(),
  // Applied at claim time; older workers drop this top-level field.
  workspace_enforce: workspaceEnforceSchema.optional(),
  // The answers the turn this attempt resumes was parked on, as allows it
  // may apply once each: a permission request of that turn whose tool and
  // input hash match a grant is answered allow_once without asking, and the
  // grant is spent. `request_id` is the parked request the grant answers.
  // Absent when there are none; a worker older than the field drops it and
  // asks again.
  grants: z.array(permissionGrantSchema).min(1).optional(),
  // What the platform's commit-msg hook adds to each commit the session
  // makes, read fresh at every claim: the starter's GitHub co-author when
  // they linked one, and the session's console URL. Absent from an older
  // API; a worker then adds no trailer.
  git: claimGitSchema.optional(),
  // The author and committer of the session's commits: the bot user of the
  // workspace's author GitHub App, when the session's repository uses it.
  // Null or absent, the image's default stays. Beside `git`, not in it: an
  // older worker's strict `git` would refuse the whole claim over a new key,
  // where an unknown top-level key is dropped.
  git_author: claimGitAuthorSchema.nullable().optional(),
  // The emails whose Co-authored-by lines the hook removes from the
  // session's commits (ENGINE_COAUTHOR_EMAILS). Sent with `git`; top-level for
  // the reason `git_author` is.
  git_strip: claimGitStripSchema.optional(),
  // Every bundle the server's ledger holds for the session, so a restarted
  // worker judges commits by what the push check accepts and not by what it
  // remembers. Top-level for the reason `git_author` is.
  git_issued: z
    .array(
      z
        .object({
          author: claimGitAuthorSchema,
          co_author: claimGitAuthorSchema.nullable(),
          agent_session: trailerValueSchema.nullable(),
        })
        .strict(),
    )
    .max(5000)
    .optional(),
  // The attempt's repository route token, also when the claim names no
  // repository: a repository the agent attaches mid-session is fetched with
  // it (session-repository-attachment.md decision 3). Top-level so an older
  // worker drops it.
  repository_access: egressTokenAuthSchema.optional(),
});

// The claim as a log line may carry it: an allowlist of identifiers, never
// the whole response minus the secrets. The session token, the egress tokens
// and the repository URL (which may embed a credential) are what a leak would
// consist of.
export function loggableBootstrapClaim(response: BootstrapClaimResponse) {
  return {
    session_id: response.session_id,
    attempt_id: response.attempt_id,
    lease_epoch: response.lease_epoch,
    execution_generation: response.execution_generation,
    auth_revision: response.auth_revision,
    lease_expires_at: response.lease_expires_at,
    lease_remaining_ms: response.lease_remaining_ms,
    runtime: response.runtime,
    profile_fingerprint: response.profile_fingerprint,
    model: response.runtime_config.model,
    permission_mode: response.runtime_config.permission_mode,
    provider_kind: response.runtime_config.provider.kind,
    claude_md: response.runtime_config.project_settings?.claude_md === true,
    repository_id: response.workspace.repository?.id ?? null,
    branch: response.workspace.repository?.branch ?? null,
    owner_scope: response.principal.owner_scope,
    restore_revision: response.restore?.revision ?? null,
    restore_models:
      response.restore_runtime_configs?.map((config) => config.model) ?? [],
    remaining_budget_usd: response.remaining_budget_usd,
  };
}

export const nextInputRequestSchema = workerScopeSchema
  .extend({ wait_ms: z.number().int().nonnegative().optional() })
  .strict();
/**
 * The most one finalize may report a turn cost. Far above any real turn; the
 * worker clamps to it rather than send a terminal the gateway would refuse.
 */
export const MAX_TURN_COST_USD = 1_000_000;

export const nextInputResponseSchema = z.object({
  input: z
    .object({
      turn_id: turnIdSchema,
      input_id: z.string().min(1),
      message: z.string().min(1),
      delivery_started_at: timestampSchema,
      // The co-author this turn's commits name: the turn's requester, not the
      // session's starter. Absent from a control host that predates it (the
      // claim's value stands); null when the requester has no linked GitHub
      // account or there is no requester.
      co_author: z
        .object({ name: trailerValueSchema, email: trailerValueSchema })
        .strict()
        .nullable()
        .optional(),
    })
    .nullable(),
  lease_expires_at: timestampSchema,
  // Nothing more is coming to this attempt: release and exit rather than
  // hold the execution slot. `reason` says why when it is not the attempt's
  // own drain. Optional so older workers still parse it.
  draining: z.boolean().optional(),
  reason: z.enum(["BUDGET_EXCEEDED"]).optional(),
});

// Why a run refuses to be checkpointed right now, or why the publisher
// failed to (runtime-core CheckpointBlockReason, mirrored here so the wire
// schema is closed).
export const checkpointBlockReasonSchema = z.enum([
  "background_writer",
  "checkpoint_lease_held",
  "mirror_error",
  "no_engine_session",
  "publish_failed",
  "tool_in_flight",
  "transcript_part_too_large",
  "transcript_too_large",
  "turn_in_flight",
]);

// The worker's view of its transcript mirror, reported with each heartbeat.
// `persisted_at` is the last mirror write that succeeded; `mirror_error` is
// set while a batch has been dropped and the mirror no longer describes the
// engine session. The server records the error as the session's pending
// reason, which holds new turns and completed terminals back until a
// checkpoint that reads the whole transcript commits.
export const transcriptReportSchema = z
  .object({
    persisted_at: timestampSchema.nullable(),
    mirror_error: z.string().min(1).nullable(),
  })
  .strict();

export const heartbeatRequestSchema = workerScopeSchema
  .extend({
    attempt_state: attemptStateSchema,
    // Optional so a worker that does not mirror yet heartbeats unchanged.
    transcript: transcriptReportSchema.optional(),
  })
  .strict();
export const heartbeatResponseSchema = z.object({
  lease_expires_at: timestampSchema,
  lease_remaining_ms: leaseRemainingMsSchema,
  // Nothing reads it: the write is fenced on the request's auth_revision, so
  // this only echoes it. Optional so the server can stop sending it once no
  // worker image that requires it is still running.
  auth_revision: epochSchema.optional(),
  control_pending: z.boolean(),
});

const v = sessionEventVariants;
// Per attempt, source_sequence starts at 1 and increases by one. Subscribers
// read the stream back in the order it was stored, so an event whose
// predecessor is missing is refused rather than written out of order: the
// worker resends from the acknowledged prefix.
function sourced<V extends (typeof v)[keyof typeof v]>(variant: V) {
  return variant.extend({
    source_sequence: z.number().int().positive().max(INT4_MAX),
    occurred_at: timestampSchema,
  });
}
export const workerEventSchema = z.discriminatedUnion("event", [
  sourced(v.system),
  sourced(v.assistant),
  sourced(v.tool_use),
  sourced(v.tool_result),
  sourced(v.question),
  sourced(v.result),
  sourced(v.status),
  sourced(v.error),
]);
export const appendEventsRequestSchema = workerScopeSchema
  .extend({
    batch_key: z.string().min(1),
    events: z.array(workerEventSchema).min(1),
  })
  .strict();
export const appendEventsResponseSchema = z.object({
  // The attempt's durable prefix: 0 until sequence 1 is stored.
  accepted_through: z.number().int().nonnegative(),
  cursor: opaqueCursorSchema,
});

// A permission or question the attempt is holding a live callback for. The
// worker registers it before anyone is told about it, so every request a
// client can see is one an answer can reach. `input_hash` is taken over the
// callback's own arguments, before redaction: the display copy below is
// redacted, and two different arguments must never share an approval.
export const registerPendingRequestSchema = workerScopeSchema
  .extend({
    turn_id: turnIdSchema,
    request_id: requestIdSchema,
    input_hash: sha256HexSchema,
    request: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("permission"),
          tool: z.string().min(1),
          input: requiredUnknownSchema,
          // The rules the engine proposed to keep allowing for the session,
          // already filtered and redacted by the run. Stored with the row for
          // the card and for checking an answer's `remember`; never part of
          // what the API lists. An older worker leaves it out, and that
          // request offers nothing.
          remember_offer: z.array(rememberRuleSchema).min(1).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("question"),
          questions: z.array(pendingQuestionSchema).min(1),
        })
        .strict(),
    ]),
    // What the `question` event needs beyond the request. Present, it hands
    // the event to the control plane: the gateway writes it with the row, in
    // the same transaction as the status it opens, and the worker publishes
    // nothing. An older worker leaves it out and publishes the event itself.
    announce: z
      .object({ tool_use_id: z.string().min(1), tool: z.string().min(1) })
      .strict()
      .optional(),
    // The approval-wait checkpoint captured while the engine waits on this
    // request, committed with the row and never moved onto the session
    // pointer here. `answers_through` is the last answer sequence the worker
    // had applied when it captured: an answer delivered past it may have let
    // a tool run that the checkpoint does not hold. A server older than the
    // field refuses the body, so servers deploy first.
    checkpoint: checkpointRefSchema
      .extend({ answers_through: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
// `expires_in_ms` is what is left, measured on the server's clock: a replay
// never restarts the lifetime, and the worker needs no clock agreement to
// know how long answers are still accepted.
export const registerPendingResponseSchema = z.object({
  request_id: requestIdSchema,
  expires_at: timestampSchema,
  expires_in_ms: z.number().int().nonnegative(),
});

// How a registered request ended on the worker: `answered` once the callback
// got the delivered answer (a deny included), `expired` when nothing reached
// it in time, `cancelled` when the callback went away first.
//
// `reason` says why the worker cancelled it, so a cancel is never read as a
// person's deny. `answer_result` is what the run said of a delivered answer:
// `unknown` stays answered (the engine may have acted on it), `stale` never
// reached it. An older worker sends neither; a server older than them
// refuses the poll, so servers deploy first.
export const PENDING_CANCEL_REASON_VALUES = [
  "park",
  "shutdown",
  "interrupt",
  "refused",
] as const;
export const pendingSettlementSchema = z
  .object({
    request_id: requestIdSchema,
    outcome: z.enum(["answered", "expired", "cancelled"]),
    reason: z.enum(PENDING_CANCEL_REASON_VALUES).optional(),
    answer_result: z.enum(["applied", "stale", "unknown"]).optional(),
  })
  .strict()
  .superRefine((settlement, context) => {
    if (settlement.reason !== undefined && settlement.outcome !== "cancelled") {
      context.addIssue({
        code: "custom",
        message: "Only a cancelled request has a reason",
        path: ["reason"],
      });
    }
    const result = settlement.answer_result;
    if (
      result !== undefined &&
      settlement.outcome !== (result === "stale" ? "cancelled" : "answered")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A stale answer settles as cancelled, an applied or unknown one as answered",
        path: ["answer_result"],
      });
    }
  });

export const PENDING_SETTLEMENTS_MAX = 256;

// How the answer to a parked request reached the turn that resumed it, where
// no callback was left to take it: `input_delivered` once the turn's input
// carried it (a question's answer, a deny, an expiry), `grant_consumed` when
// an allow was spent on the matching call, `grant_unused` when the turn
// ended with that allow unspent.
export const parkedDeliverySchema = z
  .object({
    request_id: requestIdSchema,
    outcome: z.enum(["input_delivered", "grant_consumed", "grant_unused"]),
  })
  .strict();

// A repository the agent attached mid-session, for the worker to add as a
// remote and fetch with the claim's `repository_access`
// (session-repository-attachment.md decision 3). `receipt_id` names the
// request: a result settles only the request it echoes, so a resent result
// for an earlier one never settles a later request for the same repository.
export const repositoryAttachOrderSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1),
    branch: z.string().min(1),
    receipt_id: z.string().min(1),
  })
  .strict();
export const repositoryAttachResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      repository_id: z.string().min(1),
      receipt_id: z.string().min(1),
      status: z.literal("attached"),
      commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    })
    .strict(),
  z
    .object({
      repository_id: z.string().min(1),
      receipt_id: z.string().min(1),
      status: z.literal("failed"),
      failure: repositoryAttachFailureSchema,
    })
    .strict(),
]);

// Answers are redelivered until the worker advances answers_after, so a crash
// between applying an answer and the next poll replays the same sequence.
// Settlements ride along and are resent until a call carrying them succeeds;
// they are independent of the cursor, which only says what was seen.
export const pendingControlRequestSchema = workerScopeSchema
  .extend({
    // The poller is the one that parses the answers it gets back, so it
    // declares here what it parses (see `workerCapabilitiesSchema`).
    capabilities: workerCapabilitiesSchema.optional(),
    answers_after: z.number().int().nonnegative(),
    settled: z
      .array(pendingSettlementSchema)
      .max(PENDING_SETTLEMENTS_MAX)
      .optional(),
    // Resent like `settled`. Sent only by a turn resumed from a park, which
    // only a server that parks hands out.
    delivered: z
      .array(parkedDeliverySchema)
      .min(1)
      .max(PENDING_SETTLEMENTS_MAX)
      .optional(),
    // The fetches of `attachments` this worker ran, resent like `settled`.
    // Sent only for attachments a server handed out.
    attached: z
      .array(repositoryAttachResultSchema)
      .min(1)
      .max(PENDING_SETTLEMENTS_MAX)
      .optional(),
  })
  .strict();
// `park` is a pause the platform asked for because the turn's requests went
// unanswered: unlike `pause` it does not wait for the turn to end. The worker
// cancels the open callbacks, interrupts the turn, finalizes it interrupted
// with TURN_INPUT_WAIT_PARKED_REASON and its checkpoint, and releases with
// `pause_control_id: control_id`; or it declines (parkDeclinedRequest) before
// it touches the turn. Only a server that parks sends it, and a worker older
// than the kind refuses the whole response, so workers deploy first.
export const controlIntentSchema = z.object({
  control_id: z.string().min(1),
  kind: z.enum(["interrupt", "pause", "park"]),
  target_turn_id: turnIdSchema.nullable(),
  issued_at: timestampSchema,
});
// In ascending sequence order.
export const pendingControlResponseSchema = z.object({
  control: controlIntentSchema.nullable(),
  answers: z.array(
    z.object({
      sequence: z.number().int().positive(),
      answer: postSessionAnswerRequestSchema,
      // The registered hash, so the worker applies the answer only to the
      // callback it was given for.
      input_hash: sha256HexSchema,
    }),
  ),
  // Repositories the agent attached that no worker has reported fetching
  // yet, handed out again until one does. Absent from an older server.
  attachments: z.array(repositoryAttachOrderSchema).optional(),
});

// The worker will not park after all, and says so before it has cancelled a
// callback or interrupted the turn: `answer_applied` when the wait the park
// was for is already gone (an answer the same poll brought and the worker
// applied, a request that expired, a turn that ended on its own),
// `checkpoint_unavailable` when it could not leave a checkpoint to park on.
// The server puts the session back to active only while the park is still
// the open pause; a person's pause that took it over stands.
export const PARK_DECLINED_REASON_VALUES = [
  "answer_applied",
  "checkpoint_unavailable",
] as const;
export const parkDeclinedRequestSchema = workerScopeSchema
  .extend({
    pause_control_id: z.string().min(1),
    reason: z.enum(PARK_DECLINED_REASON_VALUES),
  })
  .strict();
// `reverted` is false when the park was no longer the open pause: the worker
// then follows whatever control the next poll delivers.
export const parkDeclinedResponseSchema = z.object({ reverted: z.boolean() });

// The worker parks its own turn, which is about to run past its deadline
// with nothing left but unanswered requests: the server opens the same
// system pause a timed park would and names it, and only then may the
// worker interrupt, finalize and release under that id. A refusal is a 409;
// a server without the route answers 404, and the worker drains as before.
export const requestParkRequestSchema = workerScopeSchema
  .extend({ turn_id: turnIdSchema })
  .strict();
export const requestParkResponseSchema = z.object({
  pause_control_id: z.string().min(1),
});

// Sent before the engine admits a tool after an approval-wait checkpoint was
// committed: past this, that checkpoint no longer holds what the workspace
// will. `invalidated` is false only when no such checkpoint of this attempt
// exists; the worker admits the tool either way once the call succeeds.
export const invalidateApprovalCheckpointRequestSchema = workerScopeSchema
  .extend({ manifest_ref: z.string().min(1) })
  .strict();
export const invalidateApprovalCheckpointResponseSchema = z.object({
  invalidated: z.boolean(),
});

// Asks the server where the next checkpoint goes. The runtime's own verdict
// travels with it: the server decides which refusals outlive the turn and
// records those as the session's pending reason. The answer is authoritative —
// the revision and manifest key come from the committed pointer, never from
// the worker's memory of its restore point.
export const checkpointRequestSchema = workerScopeSchema
  .extend({
    preparation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready") }).strict(),
      z
        .object({
          status: z.literal("rejected"),
          reason: checkpointBlockReasonSchema,
          detail: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();
export const checkpointRequestResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    revision: revisionSchema,
    manifest_ref: z.string().min(1),
  }),
  z.object({
    status: z.literal("blocked"),
    reason: checkpointBlockReasonSchema,
    detail: z.string().min(1),
  }),
]);

// The commits the worker's attribution repair must never remake: the
// workspace commit of each of the session's recent confirmed checkpoints. A
// push request pins exactly such a commit, so what a request already holds,
// or a later one can, is inside. Newest first; the server bounds the list.
export const MAX_PROTECTED_COMMITS = 32;
export const protectedCommitsRequestSchema = workerScopeSchema.strict();
export const protectedCommitsResponseSchema = z
  .object({
    commits: z
      .array(z.string().regex(/^[0-9a-f]{40}$/))
      .max(MAX_PROTECTED_COMMITS),
  })
  .strict();

// What the worker runs, so the server can say whether the committed
// checkpoint can be resumed by it (runtime-core RuntimeFingerprint).
export const runtimeFingerprintSchema = z
  .object({
    engine: z.string().min(1),
    sdk_version: z.string().min(1),
    cli_version: z.string().min(1),
    profile_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const restorePlanRequestSchema = workerScopeSchema
  .extend({
    runtime: runtimeFingerprintSchema,
    // The profile digests of the claim's restore_runtime_configs: a manifest
    // stamped with one of them is as compatible as one stamped with
    // runtime's. Sent only when there are some, so an older gateway's strict
    // parse never sees the field.
    alternate_profile_sha256s: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(MAX_RESTORE_ALTERNATES)
      .optional(),
  })
  .strict();

// `version`, when present, is the only thing the worker may download: the
// key's current object can be a later write than the one the checkpoint
// verified.
const restoreObjectSchema = z.object({
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  version: objectVersionSchema.optional(),
});
export const restoreArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum([
      "transcript_root",
      "transcript_subagent",
      "workspace_bundle",
    ]),
    label: z.string(),
    objects: z.array(restoreObjectSchema),
  }),
  z.object({
    kind: z.literal("workspace_untracked"),
    label: z.string(),
    objects: z.array(
      restoreObjectSchema.extend({
        path: z.string().min(1),
        // Absent for a file restored without execute bits.
        executable: z.literal(true).exactOptional(),
      }),
    ),
  }),
]);
// Every revision tried and refused before the one restored, newest first,
// starting with the pointer's.
const restoreFallbackSchema = z.object({
  pointer_revision: revisionSchema,
  skipped: z
    .array(z.object({ revision: revisionSchema, reason: z.string().min(1) }))
    .min(1),
});
export const restorePlanSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  // What the restored revision's manifest must hash to. It equals the
  // claim's restore digest unless `fallback` says an earlier revision is
  // restored, and then only this names it.
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifest_version: objectVersionSchema.optional(),
  engine: z.string().min(1),
  resume: z.string().min(1),
  cwd: z.string().min(1),
  git_commit: z.string().regex(/^[0-9a-f]{40}$/),
  artifacts: z.array(restoreArtifactSchema),
  object_keys: z.array(z.string().min(1)),
  // Present only when the pointer's own checkpoint was damaged and the plan
  // restores an earlier revision (`revision` above) instead. The
  // resumed session is then older than the pointer says, so the worker must
  // not treat this as the checkpoint its claim named.
  fallback: restoreFallbackSchema.optional(),
});
// `none` is a new session. `unavailable` and `incompatible` are refusals the
// worker must fail its claim on: starting a fresh engine session on top of a
// session that has a checkpoint is exactly what the pointer exists to stop.
export const restorePlanResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("ready"), plan: restorePlanSchema }),
  z.object({
    status: z.literal("unavailable"),
    code: z.literal("CHECKPOINT_UNAVAILABLE"),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("incompatible"),
    code: z.literal("INCOMPATIBLE_CHECKPOINT"),
    mismatches: z.array(
      z.object({
        field: z.enum(["cliVersion", "engine", "profileSha256", "sdkVersion"]),
        expected: z.string(),
        found: z.string(),
      }),
    ),
    // Set when the pointer's checkpoint was damaged and it is the earlier
    // `revision` the runtime cannot resume.
    fallback: restoreFallbackSchema
      .extend({ revision: revisionSchema })
      .optional(),
  }),
]);

/**
 * The terminal reason of a turn the budget ended mid-turn: the engine ran out
 * of what the claim gave it (`remaining_budget_usd`), or finalize found the
 * session already spent when the engine reported a provider failure. Its
 * receipt fails with BUDGET_EXCEEDED rather than INTERNAL_ERROR.
 */
export const TURN_BUDGET_EXCEEDED_REASON = "budget_exceeded";

export const TURN_WORKSPACE_QUOTA_EXCEEDED_REASON = "workspace_quota_exceeded";

/**
 * The terminal reason of a turn interrupted to park it on unanswered
 * requests. Its requests stay open, and the checkpoint it commits is what an
 * answer resumes from, so it is only ever an `interrupted` turn with one.
 */
export const TURN_INPUT_WAIT_PARKED_REASON = "input_wait_parked";

export const finalizeRequestSchema = workerScopeSchema
  .extend({
    turn_id: turnIdSchema,
    finalize_key: z.string().min(1),
    // The last source_sequence this attempt produced before the terminal.
    // The turn only closes once the stream is durable through it, so a
    // finalize can never overtake its own event tail. Zero means
    // the attempt has written no events yet.
    final_source_sequence: z.number().int().nonnegative().max(INT4_MAX),
    terminal: z.object({
      status: terminalTurnStatusSchema.exclude(["cancelled"]),
      reason: z.string().min(1).nullable(),
      result: z.unknown().nullable(),
      usage: z.unknown().nullable(),
      // What the engine says this turn cost, in USD; an estimate, not a bill.
      // Kept on the turn; the session's spend is what the egress proxy
      // metered. Absent or null when it gave no usable figure: the
      // turn reads as unreported. A turn known to have cost
      // nothing sends 0.
      cost_usd: z
        .number()
        .nonnegative()
        .max(MAX_TURN_COST_USD)
        .nullable()
        .optional(),
    }),
    checkpoint: checkpointRefSchema.nullable(),
  })
  .strict()
  .refine(
    (request) =>
      request.terminal.reason !== TURN_INPUT_WAIT_PARKED_REASON ||
      (request.terminal.status === "interrupted" &&
        request.checkpoint !== null),
    {
      message: `${TURN_INPUT_WAIT_PARKED_REASON} is an interrupted turn with a checkpoint`,
      path: ["terminal", "reason"],
    },
  );
export const finalizeResponseSchema = z.object({
  turn_id: turnIdSchema,
  status: terminalTurnStatusSchema,
  checkpoint_revision: revisionSchema.nullable(),
});

// `pause_control_id` makes the release the drained attempt's answer to that
// pause: the coordinator commits the pause with it or refuses it (409
// CHECKPOINT_UNAVAILABLE while no safe checkpoint covers the session, 409
// REQUEST_STALE once the pause is not the open one), and a refused attempt
// keeps its lease. Without it the release is unconditional.
// `stop_kind: "drain"` says the worker was asked to stop (SIGTERM), not that
// it failed: a startup it ends is not counted against the session.
// A gateway older than the field refuses it with BAD_REQUEST, and the worker
// then releases without it.
export const releaseRequestSchema = workerScopeSchema
  .extend({
    reason: z.string().min(1),
    pause_control_id: z.string().min(1).optional(),
    stop_kind: z.literal("drain").optional(),
  })
  .strict();
export const releaseResponseSchema = z.object({ released: z.boolean() });

// Sent once the attempt restored what its claim named and the engine has
// loaded that session, before the first input poll. A session resumed from
// `paused` waits on it: this report is what makes it active again and
// settles the resume receipt, so no queued input is handed out before the
// restore is proven. For any other session it changes nothing.
export const workerReadyRequestSchema = workerScopeSchema
  .extend({ restored_revision: revisionSchema.nullable() })
  .strict();
export const workerReadyResponseSchema = z.object({ activated: z.boolean() });

export type WorkerScope = z.infer<typeof workerScopeSchema>;
export type CheckpointRef = z.infer<typeof checkpointRefSchema>;
export type BootstrapClaimRequest = z.infer<typeof bootstrapClaimRequestSchema>;
export type BootstrapClaimResponse = z.infer<
  typeof bootstrapClaimResponseSchema
>;
export type ClaimGit = z.infer<typeof claimGitSchema>;
export type ClaimGitAuthor = z.infer<typeof claimGitAuthorSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
export type AdditionalWorkspaceRepository = z.infer<
  typeof additionalWorkspaceRepositorySchema
>;
export type ClaimPrincipal = z.infer<typeof claimPrincipalSchema>;
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type EngineSettings = z.infer<typeof engineSettingsSchema>;
export type RuntimeExtension = z.infer<typeof runtimeExtensionSchema>;
export type PlatformPrompt = z.infer<typeof platformPromptSchema>;
export type PlatformPromptSurface = PlatformPrompt["origin_surface"];
export type NextInputRequest = z.infer<typeof nextInputRequestSchema>;
export type NextInputResponse = z.infer<typeof nextInputResponseSchema>;
export type CheckpointBlockReason = z.infer<typeof checkpointBlockReasonSchema>;
export type TranscriptReport = z.infer<typeof transcriptReportSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type CheckpointRequest = z.infer<typeof checkpointRequestSchema>;
export type CheckpointRequestResponse = z.infer<
  typeof checkpointRequestResponseSchema
>;
export type ProtectedCommitsRequest = z.infer<
  typeof protectedCommitsRequestSchema
>;
export type ProtectedCommitsResponse = z.infer<
  typeof protectedCommitsResponseSchema
>;
export type RuntimeFingerprintWire = z.infer<typeof runtimeFingerprintSchema>;
export type RestorePlanRequest = z.infer<typeof restorePlanRequestSchema>;
export type RestorePlanWire = z.infer<typeof restorePlanSchema>;
export type RestorePlanResponse = z.infer<typeof restorePlanResponseSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type WorkerReadyRequest = z.infer<typeof workerReadyRequestSchema>;
export type WorkerReadyResponse = z.infer<typeof workerReadyResponseSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type AppendEventsRequest = z.infer<typeof appendEventsRequestSchema>;
export type AppendEventsResponse = z.infer<typeof appendEventsResponseSchema>;
export type RegisterPendingRequest = z.infer<
  typeof registerPendingRequestSchema
>;
export type RegisterPendingResponse = z.infer<
  typeof registerPendingResponseSchema
>;
export type PendingSettlement = z.infer<typeof pendingSettlementSchema>;
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;
export type PendingControlRequest = z.infer<typeof pendingControlRequestSchema>;
export type ControlIntent = z.infer<typeof controlIntentSchema>;
export type PendingControlResponse = z.infer<
  typeof pendingControlResponseSchema
>;
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;
export type ParkedDelivery = z.infer<typeof parkedDeliverySchema>;
export type RepositoryAttachOrder = z.infer<typeof repositoryAttachOrderSchema>;
export type RepositoryAttachResult = z.infer<
  typeof repositoryAttachResultSchema
>;
export type ParkDeclinedRequest = z.infer<typeof parkDeclinedRequestSchema>;
export type ParkDeclinedResponse = z.infer<typeof parkDeclinedResponseSchema>;
export type RequestParkRequest = z.infer<typeof requestParkRequestSchema>;
export type RequestParkResponse = z.infer<typeof requestParkResponseSchema>;
export type InvalidateApprovalCheckpointRequest = z.infer<
  typeof invalidateApprovalCheckpointRequestSchema
>;
export type InvalidateApprovalCheckpointResponse = z.infer<
  typeof invalidateApprovalCheckpointResponseSchema
>;

// What the engine made of the proxy's refusal: a 403 it calls an
// authentication failure, the refusal text, the last retry's status.
const PROVIDER_DIAGNOSIS = [
  "api_error_status",
  "provider_error",
  "last_retry_status",
  "result",
] as const;

/**
 * A provider failure on a session already spent, recorded as the budget
 * ending the turn. The caller decides from the session's spend; this only
 * rewrites, nulling the engine's diagnosis so the stored result does not
 * read as a credential fault.
 */
export function budgetEndedTerminal(
  terminal: FinalizeRequest["terminal"],
): FinalizeRequest["terminal"] {
  if (terminal.status !== "failed" || terminal.reason !== "api_error") {
    return terminal;
  }
  const { result } = terminal;
  return {
    ...terminal,
    reason: TURN_BUDGET_EXCEEDED_REASON,
    result:
      typeof result === "object" && result !== null
        ? {
            ...result,
            ...Object.fromEntries(
              PROVIDER_DIAGNOSIS.filter((key) => key in result).map((key) => [
                key,
                null,
              ]),
            ),
          }
        : result,
  };
}
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ReleaseResponse = z.infer<typeof releaseResponseSchema>;
