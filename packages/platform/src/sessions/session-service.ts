import { createHash } from "node:crypto";
import type {
  AdmissionState,
  AgentGitHubSettingsRow,
  AgentRelease,
  ApiErrorCode,
  AuditReadResponse,
  AuthorizationAction,
  AuthorizationDecision,
  AuthorizationResource,
  CloseSessionRequest,
  ControlAcceptedResponse,
  CountSessionsQuery,
  CountSessionsResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  ListTurnsQuery,
  ListTurnsResponse,
  PauseSessionRequest,
  PostSessionMessageRequest,
  PostSessionMessageResponse,
  Receipt,
  RecoveryDecisionRequest,
  RepositoryCeiling,
  ResumeSessionRequest,
  SessionCredentialUnboundDetails,
  SessionDetail,
  SessionExtension,
  SessionRuntimeView,
  SlackMessageRef,
  SpecSource,
  TerminateSessionRequest,
  TerminateSessionResponse,
  TurnDetail,
  UpdateSessionRequest,
} from "@werft-ai/contracts";
import {
  CREDENTIAL_UNBOUND_GUIDANCE,
  newSessionGitHubPolicy,
  normalizeSessionTitle,
  startRepositoryOf,
} from "@werft-ai/contracts";
import { releaseModel } from "../agents/release-ids.ts";
import type { ExtensionRefusal } from "../extensions/resolve.ts";
import {
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "../extensions/session-extensions.ts";
import {
  budgetExceeded,
  type SessionSpend,
} from "../limits/installation-limits.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  scopeOf,
} from "../musterrolle/policy.ts";
import type { CredentialBindingStore } from "../ports/credential-binding-store.ts";
import type { SessionControl } from "../ports/session-control.ts";
import type { SessionViewer } from "../ports/session-share-store.ts";
import type {
  EventPage,
  InputAcceptance,
  InputLimitRefusal,
  InputLimits,
  ReadEventsQuery,
  SessionDetailRecord,
  SessionReader,
} from "../ports/session-unit-of-work.ts";
import { additionalRepositoryAllowed } from "./additional-repositories.ts";
import {
  connectionModels,
  connectionOf,
  modelSuccessor,
  repositoryInCeiling,
  runtimeVersionAccepted,
  type SessionCatalogView,
} from "./catalog.ts";
import { attachedRepositoriesOf } from "./session-repository.ts";
import { deriveSessionTitle } from "./session-title.ts";

export const viewerOf = (actor: Caller): SessionViewer => ({
  userId: actor.actor?.userId ?? null,
  apiKeyId: actor.actor?.apiKeyId ?? null,
  keyAgentId: actor.actor?.agentId ?? null,
});

export class SessionServiceError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retry?: { afterSeconds: number },
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

function extensionRefusalError(refusal: ExtensionRefusal): SessionServiceError {
  return new SessionServiceError(
    "UNSUPPORTED_CAPABILITY",
    refusal.message,
    undefined,
    { reason_code: refusal.code, bundle: refusal.name },
  );
}

export function selfApproval(error: unknown): boolean {
  return (
    error instanceof SessionServiceError &&
    (error.details as { reason_code?: unknown } | null)?.reason_code ===
      "self_approval"
  );
}

export function idempotencyConflict(): never {
  throw new SessionServiceError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency-Key was already used with a different payload",
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

// api.md: pausing/paused, resuming and closed each have their own code;
// stopped requires an explicit resume; recovery_required blocks all input.
const ADMISSION_REJECTIONS: Record<
  Exclude<AdmissionState, "active">,
  { code: ApiErrorCode; message: string }
> = {
  pausing: { code: "SESSION_PAUSED", message: "Session is pausing" },
  paused: { code: "SESSION_PAUSED", message: "Session is paused" },
  resuming: { code: "SESSION_RESUMING", message: "Session is resuming" },
  stopping: {
    code: "SESSION_STOPPED",
    message: "Session is stopping; resume it before sending messages",
  },
  stopped: {
    code: "SESSION_STOPPED",
    message: "Session is stopped; resume it before sending messages",
  },
  recovery_required: {
    code: "RECOVERY_REQUIRED",
    message: "Session requires an operator recovery decision",
  },
  closing: { code: "SESSION_CLOSING", message: "Session is closing" },
  closed: { code: "SESSION_CLOSED", message: "Session is closed" },
};

// Resume from a state with nothing to resume: an active session is running
// already, a resuming one is on its way.
const RESUME_REJECTIONS: Record<
  Exclude<
    AdmissionState,
    "stopped" | "stopping" | "recovery_required" | "paused" | "pausing"
  >,
  [ApiErrorCode, string]
> = {
  active: ["REQUEST_STALE", "Session is already active"],
  resuming: ["SESSION_RESUMING", "Session is already resuming"],
  closing: ["SESSION_CLOSING", "Session is closing"],
  closed: ["SESSION_CLOSED", "Session is closed"],
};

const PAUSE_REJECTIONS: Record<
  Exclude<AdmissionState, "active">,
  [ApiErrorCode, string]
> = {
  pausing: ["SESSION_PAUSED", "Session is already pausing"],
  paused: ["SESSION_PAUSED", "Session is already paused"],
  resuming: ["SESSION_RESUMING", "Session is resuming"],
  stopping: ["SESSION_STOPPED", "Session is stopping"],
  stopped: ["SESSION_STOPPED", "Session is stopped"],
  recovery_required: [
    "RECOVERY_REQUIRED",
    "Session requires an operator recovery decision",
  ],
  closing: ["SESSION_CLOSING", "Session is closing"],
  closed: ["SESSION_CLOSED", "Session is closed"],
};

// The states a close does not take, each with the step that comes first.
const CLOSE_REJECTIONS: Record<
  Exclude<
    AdmissionState,
    "active" | "paused" | "stopped" | "recovery_required"
  >,
  [ApiErrorCode, string]
> = {
  pausing: ["SESSION_PAUSED", "Session is pausing; close it once it is paused"],
  resuming: ["SESSION_RESUMING", "Session is resuming"],
  stopping: [
    "SESSION_STOPPED",
    "Session is stopping; close it once the terminate receipt has settled",
  ],
  closing: ["SESSION_CLOSING", "Session is already closing"],
  closed: ["SESSION_CLOSED", "Session is closed"],
};

// Not a prediction of when the queue drains — turns wait on approvals and run
// for minutes — only a floor that keeps clients from retrying in a tight loop.
export const QUEUE_FULL_RETRY_AFTER_SECONDS = 5;

function limitError(refusal: InputLimitRefusal): SessionServiceError {
  return refusal.outcome === "queue_full"
    ? new SessionServiceError(
        "RATE_LIMITED",
        "The session already holds its limit of queued messages",
        { afterSeconds: QUEUE_FULL_RETRY_AFTER_SECONDS },
      )
    : new SessionServiceError(
        "STORAGE_LIMIT_EXCEEDED",
        "The installation has no storage left for this message",
      );
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)), "utf8")
    .digest("hex");
}

/**
 * The agent whose settings a receipt records: a change to the agent itself
 * or to one of its Slack bindings, read as agent.settings_read
 * (agent-rbac (b)). Null for any other receipt. A start refused for unbound
 * credentials also targets the agent, but records only what its caller
 * asked for, so it stays readable as before.
 */
export function settingsAgentOf(receipt: Receipt): string | null {
  const target = receipt.target_ref;
  if (!("resource" in target) || receipt.operation === "create_session") {
    return null;
  }
  if (target.resource.kind === "agent") return target.resource.id;
  if (target.resource.kind !== "surface_binding") return null;
  const agentId = (receipt.result as { agent_id?: unknown } | null)?.agent_id;
  // Every binding receipt names its agent; one that does not is shown to
  // nobody rather than to everybody.
  if (typeof agentId !== "string") {
    throw new SessionServiceError("NOT_FOUND", "Resource not found");
  }
  return agentId;
}

// Service entries authorize before store calls, except receipt reads that
// must resolve their target before authorizing disclosure. Over HTTP the edge has
// already refused a missing scope, so only a caller without HTTP meets the
// FORBIDDEN here, with the same message. A decision that cannot be reached
// is a refusal.
export async function requirePermitted(
  authorization: AuthorizationPolicy,
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  justification?: string,
): Promise<void> {
  await requireAllowed(authorization, caller, action, resource, justification);
}

/** requirePermitted, for a caller that records which decision allowed it. */
export async function requireAllowed(
  authorization: AuthorizationPolicy,
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  // A manager's reason for acting outside a session's share; recorded with
  // the decision.
  justification?: string,
): Promise<AuthorizationDecision> {
  const decision = await authorization
    .authorize({
      subject:
        justification === undefined
          ? caller.subject
          : { ...caller.subject, justification },
      action,
      resource: { ...resource, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    })
    .catch(() => null);
  if (decision?.outcome === "allow") return decision;
  if (decision?.reason_code === "not_found") {
    throw new SessionServiceError("NOT_FOUND", "Resource not found");
  }
  if (decision?.reason_code === "justification_required") {
    throw new SessionServiceError(
      "FORBIDDEN",
      "This action on this session needs a justification",
      undefined,
      { reason_code: "justification_required" },
    );
  }
  if (decision?.reason_code === "self_approval") {
    throw new SessionServiceError(
      "FORBIDDEN",
      "The key that started this session cannot approve its requests; another key or a person approves them",
      undefined,
      { reason_code: "self_approval" },
    );
  }
  if (decision?.reason_code === "credential_unbound") {
    throw new SessionServiceError(
      "CREDENTIAL_UNBOUND",
      "A credential this agent's release uses is no longer bound to the agent",
      undefined,
      { reason_code: "credential_unbound" },
    );
  }
  const scope = scopeOf(action);
  throw new SessionServiceError(
    "FORBIDDEN",
    scope !== undefined && decision?.effective_scopes.includes(scope)
      ? `This principal holds ${scope} but may not use it on this session`
      : `This principal does not hold ${scope ?? action}`,
    undefined,
    // The policy's reason, so a screen can say why (design 3.3).
    { reason_code: decision?.reason_code ?? "error" },
  );
}

export function createSessionService(deps: {
  authorization: AuthorizationPolicy;
  inputs: InputAcceptance;
  controls: SessionControl;
  reader: SessionReader;
  catalog: SessionCatalogView;
  // Resolves a release a session pins; absent, no session may name one.
  releases?: {
    resolveRelease(
      workspaceId: string,
      releaseId: string,
    ): Promise<
      Pick<
        AgentRelease,
        | "id"
        | "agent_id"
        | "connection_id"
        | "repository_id"
        | "runtime_config_snapshot"
        | "effective_tools"
        | "policy_pins"
        | "approved_at"
      >
    >;
    // Why a new session cannot run the release (paused or archived agent,
    // release never approved), or null.
    notRunnableReason(
      workspaceId: string,
      release: Pick<AgentRelease, "agent_id" | "approved_at">,
    ): Promise<"agent_inactive" | "release_unapproved" | null>;
    // The variable names the release's card declares. Absent, no session
    // takes variables.
    envNames?(workspaceId: string, releaseId: string): Promise<string[]>;
    agentGitHubSettings(
      agentId: string,
    ): Promise<AgentGitHubSettingsRow | null>;
    // Null allows none.
    repositoryCeiling(workspaceId: string): Promise<RepositoryCeiling | null>;
  };
  extensions?: SessionExtensionsDeps;
  // Who a requester refused for an unbound credential is told to ask.
  credentials?: Pick<CredentialBindingStore, "contacts">;
  limits: InputLimits & {
    sessionCostLimitUsd: number;
    sessionTokenLimit: number | null;
  };
  now?: () => Date;
}) {
  const { authorization, inputs, controls, reader, catalog } = deps;
  const budget = {
    costUsd: deps.limits.sessionCostLimitUsd,
    tokens: deps.limits.sessionTokenLimit,
  };
  // Names only the limits reached: an unmetered session spends no dollars,
  // so its message never shows a dollar limit it cannot reach.
  function reachedLimits(spend: SessionSpend): string {
    const reached: string[] = [];
    if (spend.costUsd >= budget.costUsd) {
      reached.push(`${budget.costUsd} USD cost limit`);
    }
    if (budget.tokens !== null && spend.providerTokens >= budget.tokens) {
      reached.push(`${budget.tokens} token limit`);
    }
    return reached.join(" and its ");
  }
  const inputLimits: InputLimits = {
    queuedInputLimitPerSession: deps.limits.queuedInputLimitPerSession,
    storageLimitBytes: deps.limits.storageLimitBytes,
  };
  const now = deps.now ?? (() => new Date());

  /**
   * Whether a worker of this host would take the session: its connection
   * runs its model (or the next of its series, when the agent moves), its
   * runtime ships with the images, and its repository is still the one it
   * was created on.
   */
  function catalogAllows(record: SessionDetailRecord): boolean {
    const spec = record.spec;
    if (spec === null) return false;
    const connection = connectionOf(catalog, spec.connection.id);
    if (connection === undefined) return false;
    if (!runtimeVersionAccepted(catalog, spec.runtime.version)) return false;
    if (
      !connectionModels(connection).includes(spec.model) &&
      !(
        record.auto_model_migration &&
        modelSuccessor(connection, spec.model) !== null
      )
    ) {
      return false;
    }
    if (record.repository_mode === "none" || record.repository_id === null) {
      return true;
    }
    const repository = Object.hasOwn(catalog.repositories, record.repository_id)
      ? catalog.repositories[record.repository_id]
      : undefined;
    return (
      repository !== undefined &&
      repository.url === record.repo_url &&
      repository.branch === record.branch
    );
  }

  // Says which model left when that is what moved, so the reader can act on
  // it; any other mismatch keeps the general sentence.
  function mismatchReason(record: SessionDetailRecord): string {
    const spec = record.spec;
    if (spec === null) {
      return "This session has no spec to run; start a new session on the agent's current release";
    }
    const connection = connectionOf(catalog, spec.connection.id);
    if (connection === undefined) {
      return `Connection ${spec.connection.id}, which served model ${spec.model}, is disabled or no longer in this host's settings; messages will not run until an operator restores it, or you start a new session on another release`;
    }
    if (!connectionModels(connection).includes(spec.model)) {
      return `Model ${spec.model} was taken off the model list of connection ${spec.connection.id}; messages will not run until an operator adds it back, or you start a new session on another model`;
    }
    if (!runtimeVersionAccepted(catalog, spec.runtime.version)) {
      return `The session runs ${spec.runtime.kind} ${spec.runtime.version}, which the worker images no longer ship; start a new session on the agent's current release`;
    }
    return "The session's repository is no longer in this host's catalog as the session was created on it; messages will not run until an operator restores it";
  }

  function runtimeFor(spec: SpecSource | null): SessionRuntimeView | null {
    if (spec === null) return null;
    return {
      kind: spec.runtime.kind,
      version: spec.runtime.version,
      connection_id: spec.connection.id,
      model: spec.model,
      permission_mode: spec.permission_mode,
    };
  }

  function revisionConflict(currentRevision: number): never {
    throw new SessionServiceError(
      "REVISION_CONFLICT",
      `expected_revision does not match the current revision ${currentRevision}`,
    );
  }

  // 403 rather than a state conflict: no retry or later request by the
  // owner changes the answer, only the operator's restore does.
  function executionRevoked(): never {
    throw new SessionServiceError(
      "FORBIDDEN",
      "An operator revoked this session's execution authority; it cannot run again until the operator restores it",
    );
  }

  // Who can fix what a session lacks: the agent's administrators.
  async function adminContactsOf(workspaceId: string, agentId: string) {
    const admins = (
      (await deps.credentials?.contacts(workspaceId, agentId)) ?? []
    ).map((contact) => ({
      user_id: contact.userId,
      display_name: contact.displayName,
      email: contact.email,
    }));
    return {
      admins,
      admin_link:
        admins.length === 0
          ? null
          : `mailto:${admins.map((admin) => encodeURIComponent(admin.email)).join(",")}`,
    };
  }

  // The name that is missing is not in the answer: the requester is not the
  // administrator who can supply it.
  async function variableUnresolved(
    workspaceId: string,
    agentId: string,
    receiptId: string,
  ): Promise<SessionServiceError> {
    return new SessionServiceError(
      "VARIABLE_UNRESOLVED",
      "A variable this agent's card declares has no value for it; ask the agent's administrator",
      undefined,
      {
        reason_code: "variable_unresolved",
        agent_id: agentId,
        receipt_id: receiptId,
        ...(await adminContactsOf(workspaceId, agentId)),
      },
    );
  }

  async function credentialUnbound(
    workspaceId: string,
    agentId: string,
    receiptId: string,
  ): Promise<SessionServiceError> {
    const details: SessionCredentialUnboundDetails = {
      reason_code: "credential_unbound",
      guidance: CREDENTIAL_UNBOUND_GUIDANCE,
      agent_id: agentId,
      receipt_id: receiptId,
      ...(await adminContactsOf(workspaceId, agentId)),
    };
    return new SessionServiceError(
      "CREDENTIAL_UNBOUND",
      "A credential this agent's release uses is no longer bound to the agent",
      undefined,
      details,
    );
  }

  async function pinnedRelease(actor: Caller, body: CreateSessionRequest) {
    if (!deps.releases) {
      throw new SessionServiceError(
        "UNSUPPORTED_CAPABILITY",
        "This deployment does not pin sessions to agent releases",
      );
    }
    // A key from before workspaces has no agents to name.
    if ((actor.subject.principal?.workspace_id ?? null) === null) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
    return deps.releases.resolveRelease(actor.ownerId, body.agent_release_id);
  }

  function notRunnable(
    reason: "agent_inactive" | "release_unapproved",
    release: { id: string; agent_id: string },
  ) {
    return new SessionServiceError(
      "AGENT_NOT_RUNNABLE",
      reason === "agent_inactive"
        ? "This agent is paused or archived and starts no new session"
        : "This release was never approved; activate it before starting a session on it",
      undefined,
      {
        reason_code: reason,
        agent_id: release.agent_id,
        release_id: release.id,
      },
    );
  }

  async function detailOf(
    actor: Caller,
    sessionId: string,
  ): Promise<SessionDetail> {
    const record = await reader.getSession(actor.ownerId, sessionId);
    if (!record) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
    const {
      spec,
      cost_usd,
      provider_tokens,
      repo_url,
      branch,
      repository_mode,
      github_policy_source,
      ...detail
    } = record;
    const spend = { costUsd: cost_usd, providerTokens: provider_tokens };
    const attached = attachedRepositoriesOf(
      detail.attached_repository_ids,
      catalog.repositories,
    );
    return {
      ...detail,
      ...(attached === undefined ? {} : { attached_repositories: attached }),
      attention:
        detail.attention ??
        // The claim matches the same values (runnablePairOf), so this says
        // exactly when no worker of this host would take the session.
        (catalogAllows(record)
          ? null
          : {
              code: "CATALOG_MISMATCH",
              reason: mismatchReason(record),
            }) ??
        // Dispatch stops at the same predicate (nextInputAtomic), so what
        // this says and what the gateway does come from one comparison.
        (budgetExceeded(spend, budget)
          ? {
              code: "BUDGET_EXCEEDED",
              reason: `The session has reached its ${reachedLimits(spend)}; queued messages will not run and a pending resume will not launch`,
            }
          : null),
      runtime: runtimeFor(spec),
    };
  }

  return {
    async createSession(
      actor: Caller,
      input: {
        idempotencyKey: string;
        body: CreateSessionRequest;
        shareScope?: "private";
        slackMessage?: SlackMessageRef;
        traceContext?: string;
      },
    ): Promise<CreateSessionResponse> {
      const release = await pinnedRelease(actor, input.body);
      // Judged here but refused by the acceptance, after it finds no earlier
      // acceptance of this key: a retry of a session made before the agent
      // was paused still gets its original answer.
      const notRunnableReason = deps.releases
        ? await deps.releases.notRunnableReason(actor.ownerId, release)
        : null;
      // An unbound name refuses a new session but not the replay of one
      // accepted before the unbind, which only the acceptance can tell.
      const credentialsUnbound = await requirePermitted(
        authorization,
        actor,
        "session.submit",
        {
          kind: "session",
          id: null,
          agent_id: release.agent_id,
          release_id: release.id,
        },
      ).then(
        () => false,
        (error: unknown) => {
          if (
            error instanceof SessionServiceError &&
            error.code === "CREDENTIAL_UNBOUND"
          ) {
            return true;
          }
          throw error;
        },
      );
      const policy = newSessionGitHubPolicy(
        (await deps.releases?.agentGitHubSettings(release.agent_id)) ?? null,
        release.policy_pins.github,
      );
      const repositoryId = startRepositoryOf(
        input.body.repository_id,
        policy,
        release.repository_id,
      );
      // The gate would refuse its every token; refused here instead of at
      // the first clone.
      const notAllowed = (message: string) =>
        new SessionServiceError("GITHUB_REFUSED", message, undefined, {
          reason_code: "repository_not_allowed",
          receipt_id: null,
        });
      if (
        (policy.source === "agent" && policy.settings === "invalid") ||
        (repositoryId !== null &&
          policy.settings !== null &&
          (policy.settings === "invalid" ||
            !policy.settings.repositories.includes(repositoryId)))
      ) {
        throw notAllowed(
          "The agent's GitHub settings do not include this repository",
        );
      }
      const repositoryCeiling =
        (await deps.releases?.repositoryCeiling(actor.ownerId)) ?? null;
      if (
        repositoryId !== null &&
        !repositoryInCeiling(catalog, repositoryCeiling, repositoryId)
      ) {
        throw notAllowed("The workspace does not allow this repository");
      }
      const sent = input.body.attached_repository_ids;
      // Omitted, a session starts with none attached and attaches what it
      // needs (session-repository-attachment.md decision 2).
      const attached = sent ?? [];
      if (sent !== undefined) {
        // The switch is read at every use, not here, as for the session's
        // own repository above.
        const refused = sent.find(
          (id) =>
            additionalRepositoryAllowed(
              catalog,
              {
                repositoryId,
                attached: null,
                policySource: policy.source,
                github: policy.settings,
                repositoryCeiling,
                githubEnabled: true,
              },
              id,
            ) === null,
        );
        if (refused !== undefined) {
          throw notAllowed(
            `Repository ${refused} is the session's own, or not one the agent's GitHub settings and the workspace allow`,
          );
        }
      }
      // A model the connection does not offer, or a repository the catalog
      // no longer holds, is refused; a replay of an earlier acceptance still
      // succeeds.
      const connection = connectionOf(catalog, release.connection_id);
      const repository =
        repositoryId === null
          ? null
          : Object.hasOwn(catalog.repositories, repositoryId)
            ? catalog.repositories[repositoryId]
            : undefined;
      const wantedModel = input.body.model ?? releaseModel(release);
      const offered =
        connection !== undefined &&
        wantedModel !== undefined &&
        connectionModels(connection).includes(wantedModel);
      const successor =
        connection !== undefined &&
        input.body.model === undefined &&
        wantedModel !== undefined &&
        !offered
          ? modelSuccessor(connection, wantedModel)
          : null;
      const model = offered ? wantedModel : (successor ?? undefined);
      const runtime = release.runtime_config_snapshot.runtime as
        | { kind: SpecSource["runtime"]["kind"]; version: string }
        | undefined;
      const staleRuntime =
        runtime === undefined ||
        !runtimeVersionAccepted(catalog, runtime.version);
      const runnable =
        connection !== undefined &&
        model !== undefined &&
        repository !== undefined &&
        !staleRuntime;
      // What the card declares; the accept resolves them in its transaction.
      const envNames =
        (await deps.releases?.envNames?.(actor.ownerId, release.id)) ?? [];
      const selection = input.body.extensions;
      let extensions: SessionExtension[] | undefined;
      let extensionRefusal: SessionServiceError | null = null;
      if (deps.extensions && runtime !== undefined) {
        const resolved = await resolveSessionExtensions(deps.extensions, {
          workspaceId: actor.ownerId,
          agentId: release.agent_id,
          ...(selection === undefined ? {} : { selection }),
          runtimeKind: runtime.kind,
          tools: release.effective_tools.tools,
        });
        if (resolved.ok) {
          extensions = resolved.extensions.map((e) => ({
            bundle_id: e.bundleId,
            name: e.name,
            digest: e.digest,
            scope: e.scope,
          }));
        } else {
          extensionRefusal = extensionRefusalError(resolved.refusal);
        }
      } else if (selection !== undefined) {
        extensionRefusal = extensionRefusalError({
          code: "feature_unsupported",
          name: "",
          message: "This server does not offer extension bundles",
        });
      }
      const result = await inputs.acceptInputAtomic({
        principal: actor,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        ...(extensions === undefined ? {} : { extensions }),
        ...(extensionRefusal === null
          ? {}
          : { extensionsRefused: true as const }),
        channel: actor.subject.surface.kind,
        title:
          input.body.title === undefined
            ? deriveSessionTitle(input.body.message)
            : normalizeSessionTitle(input.body.title),
        titleSource: input.body.title === undefined ? "derived" : "user",
        repository: !runnable
          ? null
          : repository === null || repositoryId === null
            ? "none"
            : {
                id: repositoryId,
                url: repository.url,
                branch: repository.branch,
              },
        attachedRepositoryIds: attached,
        ...(runnable
          ? {
              // A session asked for no model runs the release's own; one
              // whose model left the list starts on the next of its series.
              model:
                successor === null || wantedModel === undefined
                  ? model
                  : wantedModel,
              unmetered: connection.provider.billing === "none",
            }
          : {}),
        agentReleaseId: release.id,
        githubPolicySource: policy.source,
        ...(policy.source === "agent"
          ? { captureGitHubPolicyStart: true as const }
          : {}),
        ...(credentialsUnbound ? { credentialsUnbound: true as const } : {}),
        ...(notRunnableReason === null ? {} : { notRunnableReason }),
        ...(envNames.length === 0 ? {} : { envNames }),
        ...(input.shareScope === undefined
          ? {}
          : { shareScope: input.shareScope }),
        ...(input.slackMessage === undefined
          ? {}
          : { slackMessage: input.slackMessage }),
        ...(input.traceContext === undefined
          ? {}
          : { traceContext: input.traceContext }),
        ...(input.body.permission_wait === undefined
          ? {}
          : { permissionWait: input.body.permission_wait }),
        message: input.body.message,
        limits: inputLimits,
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_runnable":
          throw notRunnable(result.reason, release);
        case "credential_unbound":
          throw await credentialUnbound(
            actor.ownerId,
            release.agent_id,
            result.receiptId,
          );
        case "variables_refused":
          throw await variableUnresolved(
            actor.ownerId,
            release.agent_id,
            result.receiptId,
          );
        case "queue_full":
        case "storage_exhausted":
          throw limitError(result);
        case "unsupported":
          throw (
            extensionRefusal ??
            new SessionServiceError(
              "UNSUPPORTED_CAPABILITY",
              connection === undefined
                ? `Connection ${release.connection_id} of this release is disabled or not in this host's settings`
                : staleRuntime
                  ? `The release runs ${runtime?.kind ?? "an unknown runtime"} ${runtime?.version ?? ""}, which the current worker images do not ship; release the agent again`
                  : model === undefined
                    ? `Model ${wantedModel} is not on the model list of connection ${release.connection_id}; ${input.body.model === undefined ? "release the agent again on a model the connection offers" : "name a model the connection offers"}`
                    : `Repository ${repositoryId} is not in this host's catalog`,
            )
          );
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
        // The policy allowed the start, then the workspace setting or the
        // agent's team changed before the write: the same refusal it gives.
        case "agent_use_refused":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal holds sessions:write but may not use it on this session",
            undefined,
            { reason_code: "role" },
          );
        default:
          return result.response;
      }
    },

    async appendMessage(
      actor: Caller,
      sessionId: string,
      input: {
        idempotencyKey: string;
        body: PostSessionMessageRequest;
        slackMessage?: SlackMessageRef;
        traceContext?: string;
      },
    ): Promise<PostSessionMessageResponse> {
      await requirePermitted(authorization, actor, "session.submit", {
        kind: "session",
        id: sessionId,
      });
      const result = await inputs.appendInputAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        message: input.body.message,
        limits: inputLimits,
        channel: actor.subject.surface.kind,
        ...(input.slackMessage === undefined
          ? {}
          : { slackMessage: input.slackMessage }),
        ...(input.traceContext === undefined
          ? {}
          : { traceContext: input.traceContext }),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            `Session cannot be checkpointed: ${result.reason}`,
          );
        case "awaiting_takeover":
          throw new SessionServiceError(
            "TAKEOVER_REQUIRED",
            "The person who asked for this session has left; it takes no messages until an owner takes it over",
          );
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
        case "credential_unbound":
          throw await credentialUnbound(
            actor.ownerId,
            result.agentId,
            result.receiptId,
          );
        case "pin_required":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session has no runtime spec pinned on its own model, so it takes no more input; create a new session",
          );
        case "queue_full":
        case "storage_exhausted":
          throw limitError(result);
        default:
          return result.response;
      }
    },

    async terminateSession(
      actor: Caller,
      sessionId: string,
      input: {
        idempotencyKey: string;
        body: TerminateSessionRequest;
        // An owner or admin stopping a session outside its share; the
        // reason then also becomes the stop reason.
        justification?: string;
      },
    ): Promise<TerminateSessionResponse> {
      // A stop with a reason is a manager's, whoever else sees the session.
      if (input.justification !== undefined) {
        await requirePermitted(authorization, actor, "session.admin_list", {
          kind: "workspace",
          id: actor.ownerId,
        });
      }
      await requirePermitted(
        authorization,
        actor,
        "session.control",
        { kind: "session", id: sessionId },
        input.justification,
      );
      const result = await controls.terminateAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        // The reason becomes the stop reason, so it is part of the request.
        payloadHash: payloadHash(
          input.justification === undefined
            ? input.body
            : { ...input.body, justification: input.justification },
        ),
        expectedRevision: input.body.expected_revision,
        reason: input.body.reason ?? input.justification ?? null,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be force-terminated",
          );
        default:
          return { ...result.response, external_effects_reverted: false };
      }
    },

    async pauseSession(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: PauseSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      await requirePermitted(authorization, actor, "session.control", {
        kind: "session",
        id: sessionId,
      });
      const result = await controls.pauseAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        reason: input.body.reason ?? null,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected":
          throw new SessionServiceError(
            ...PAUSE_REJECTIONS[result.admissionState],
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No trusted committed checkpoint covers the last turn that ran, so a pause would have nothing to restore from; terminate instead",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be paused",
          );
        default:
          return result.response;
      }
    },

    async closeSession(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: CloseSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      await requirePermitted(authorization, actor, "session.control", {
        kind: "session",
        id: sessionId,
      });
      const result = await controls.closeAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        reason: input.body.reason ?? null,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected":
          throw new SessionServiceError(
            ...CLOSE_REJECTIONS[result.admissionState],
          );
        case "recovery_required":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            "The session needs a recovery decision, not a close; end it with a recovery close (decision: close)",
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No trusted committed checkpoint covers the last turn that ran, so the session cannot be closed on its work; terminate it and use a recovery close instead",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be closed",
          );
        default:
          return result.response;
      }
    },

    async renameSession(
      actor: Caller,
      sessionId: string,
      body: UpdateSessionRequest,
    ): Promise<SessionDetail> {
      // The answer is the detail, which reading the session gives. Rename
      // first, so a refusal is kept under what was asked.
      for (const action of ["session.rename", "session.read"] as const) {
        await requirePermitted(authorization, actor, action, {
          kind: "session",
          id: sessionId,
        });
      }
      const result = await controls.renameAtomic({
        principal: actor,
        sessionId,
        title: normalizeSessionTitle(body.title),
        now: now(),
      });
      if (result.outcome === "not_found") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (result.outcome === "actor_inactive") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "This principal is no longer a member of the workspace",
        );
      }
      return detailOf(actor, sessionId);
    },

    async decideRecovery(
      actor: Caller,
      sessionId: string,
      input: {
        idempotencyKey: string;
        body: RecoveryDecisionRequest;
        // An owner deciding for a session outside its share.
        justification?: string;
      },
    ): Promise<ControlAcceptedResponse> {
      await requirePermitted(
        authorization,
        actor,
        "session.recover",
        { kind: "session", id: sessionId },
        input.justification,
      );
      const result = await controls.decideRecoveryAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        decision: input.body,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "execution_unconfirmed":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            "The previous execution has not been confirmed gone; decide once its termination is observed",
          );
        case "turn_not_unknown":
          if (result.turnStatus === null) {
            throw new SessionServiceError("NOT_FOUND", "Resource not found");
          }
          throw new SessionServiceError(
            "REQUEST_STALE",
            `target_turn_id names a turn whose outcome is ${result.turnStatus}, not unknown`,
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that has no recovery path",
          );
        case "not_in_recovery":
          throw new SessionServiceError(
            "REQUEST_STALE",
            `Session is ${result.admissionState} with nothing to recover; a recovery close applies only to recovery_required, stopping, or a stopped session that cannot be resumed, and start_fresh only to recovery_required or a stopped session that cannot be resumed`,
          );
        case "checkpoint_not_covering":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No committed checkpoint reaches the target turn, so a resume would lose the confirmed work; abandon or close instead",
          );
        case "unknown_turn_left":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            `Turn ${result.turnId} has an unknown outcome; abandon or confirm it before starting fresh`,
          );
        case "workspace_reclaiming":
          throw new SessionServiceError(
            "BACKEND_UNAVAILABLE",
            "The stopped session's workspace is being reclaimed; retry the same request shortly",
            { afterSeconds: 10 },
          );
        case "pin_required":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session has no runtime spec pinned on its own model, so it cannot run again; create a new session",
          );
        case "execution_revoked":
          throw executionRevoked();
        case "not_restore_failed":
          throw new SessionServiceError(
            "REQUEST_STALE",
            `Session is ${result.admissionState} and was not stopped by failed checkpoint restores; retry_restore applies only to a recovery_required session whose RESTORE_FAILED attention reached its limit or reports incompatible_checkpoint`,
          );
        default:
          return result.response;
      }
    },

    async resumeSession(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: ResumeSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      await requirePermitted(authorization, actor, "session.control", {
        kind: "session",
        id: sessionId,
      });
      const result = await controls.resumeAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected":
          throw new SessionServiceError(
            ...RESUME_REJECTIONS[result.admissionState],
          );
        case "recovery_required":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            result.unconfirmedTurnId === null
              ? "The previous execution has not been confirmed gone; an operator recovery decision is required"
              : `Turn ${result.unconfirmedTurnId} has an unknown outcome; an operator recovery decision is required`,
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No committed checkpoint the session can be restored from; close it through a recovery decision or create a new session",
          );
        case "pause_committing":
          throw new SessionServiceError(
            "PAUSE_COMMITTING",
            "The pause has already been committed and is waiting for its execution to end; resume once the session is paused",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be resumed",
          );
        case "workspace_reclaiming":
          throw new SessionServiceError(
            "BACKEND_UNAVAILABLE",
            "The stopped session's workspace is being reclaimed; retry the same request shortly",
            // A claim settles within the pass that took it unless the daemon
            // did not answer; then the next pass settles it.
            { afterSeconds: 10 },
          );
        case "pin_required":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session has no runtime spec pinned on its own model, so it cannot run again; create a new session",
          );
        case "execution_revoked":
          throw executionRevoked();
        case "pending_requests_open":
          throw new SessionServiceError(
            "PENDING_REQUESTS_OPEN",
            `${result.waitingFor} request(s) of the parked turn are neither answered nor expired; answer them or wait for them to expire`,
          );
        default:
          return result.response;
      }
    },

    async listSessions(
      actor: Caller,
      query: ListSessionsQuery,
    ): Promise<ListSessionsResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: null,
      });
      const page = await reader.listSessions(
        actor.ownerId,
        query,
        viewerOf(actor),
      );
      return {
        items: page.items.map(({ spec, ...item }) => {
          const attached = attachedRepositoriesOf(
            item.attached_repository_ids,
            catalog.repositories,
          );
          return {
            ...item,
            ...(attached === undefined
              ? {}
              : { attached_repositories: attached }),
            runtime: runtimeFor(spec),
          };
        }),
        next_cursor: page.next_cursor,
      };
    },

    async countSessions(
      actor: Caller,
      query: CountSessionsQuery,
    ): Promise<CountSessionsResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: null,
      });
      return reader.countSessions(actor.ownerId, query, viewerOf(actor));
    },

    async getSession(actor: Caller, sessionId: string): Promise<SessionDetail> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      return detailOf(actor, sessionId);
    },

    // Read-only by construction: it reads through the same reader as
    // getSession and listTurns and allows nothing else on the session.
    async auditRead(
      actor: Caller,
      sessionId: string,
      input: { justification: string } & ListTurnsQuery,
    ): Promise<AuditReadResponse> {
      const { justification, ...query } = input;
      await requirePermitted(
        authorization,
        actor,
        "session.audit_read",
        { kind: "session", id: sessionId },
        justification,
      );
      const session = await detailOf(actor, sessionId);
      const turns = await reader.listTurns(actor.ownerId, sessionId, query);
      if (!turns) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { session, turns };
    },

    async listTurns(
      actor: Caller,
      sessionId: string,
      query: ListTurnsQuery,
    ): Promise<ListTurnsResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const page = await reader.listTurns(actor.ownerId, sessionId, query);
      if (!page) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return page;
    },

    async getTurn(
      actor: Caller,
      sessionId: string,
      turnId: string,
    ): Promise<TurnDetail> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const turn = await reader.getTurn(actor.ownerId, sessionId, turnId);
      if (!turn) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return turn;
    },

    async readEvents(
      actor: Caller,
      sessionId: string,
      query: ReadEventsQuery,
    ): Promise<EventPage> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const page = await reader.readEvents(actor.ownerId, sessionId, query);
      if (!page) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return page;
    },

    // Any principal of the issuing owner's partition may read a receipt,
    // not only the one that issued the command; another owner sees the same
    // 404 as for a receipt that never existed, and so does anyone outside
    // the share of the session it names.
    async getReceipt(actor: Caller, receiptId: string): Promise<Receipt> {
      // Resolve only within the caller's partition. A null session would
      // incorrectly require an agent key to read across all agents.
      const receipt = await reader.getReceipt(actor.ownerId, receiptId);
      const agentId = receipt === null ? null : settingsAgentOf(receipt);
      await (agentId === null
        ? requirePermitted(authorization, actor, "session.read", {
            kind: "session",
            id:
              receipt && "session_id" in receipt.target_ref
                ? receipt.target_ref.session_id
                : null,
          })
        : requirePermitted(authorization, actor, "agent.settings_read", {
            kind: "agent",
            id: agentId,
          }));
      if (!receipt) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return receipt;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
