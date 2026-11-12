import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AdditionalWorkspaceRepository,
  ApiErrorCode,
  AppendEventsRequest,
  AppendEventsResponse,
  AttemptState,
  BootstrapClaimRequest,
  BootstrapClaimResponse,
  CheckpointRequest,
  CheckpointRequestResponse,
  ClaimGit,
  ClaimGitAuthor,
  ClaimTelemetry,
  FinalizeRequest,
  FinalizeResponse,
  GitHubPackagesRegistry,
  HeartbeatRequest,
  HeartbeatResponse,
  InvalidateApprovalCheckpointRequest,
  InvalidateApprovalCheckpointResponse,
  ModelCutCause,
  NextInputRequest,
  NextInputResponse,
  ParkDeclinedRequest,
  ParkDeclinedResponse,
  PendingControlRequest,
  PendingControlResponse,
  PostSessionAnswerRequest,
  ProtectedCommitsRequest,
  ProtectedCommitsResponse,
  RegisterPendingRequest,
  RegisterPendingResponse,
  ReleaseRequest,
  ReleaseResponse,
  RepositoryAttachOrder,
  RequestParkRequest,
  RequestParkResponse,
  RestorePlanRequest,
  RestorePlanResponse,
  RuntimeConfig,
  TraceContentMode,
  WorkerCapabilities,
  WorkerEvent,
  WorkerReadyRequest,
  WorkerReadyResponse,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  DEFAULT_WORKSPACE_ENFORCE,
  ENGINE_COAUTHOR_EMAILS,
  GITHUB_MCP_SERVER,
  githubRefusalStatus,
  IMAGE_GIT_AUTHOR,
  MAX_RESTORE_CONFIGS,
  type RuntimeKind,
  sanitizeToolDecision,
} from "@werft-ai/contracts";
import type { RuntimeFingerprint } from "@werft-ai/runtime-core";
import type { CommitAttributionLedger } from "../action/ports/commit-attributions.ts";
import { repoRefOf } from "../action/ports/forge.ts";
import type {
  SessionAttributionRecord,
  SessionAttributionStore,
} from "../action/ports/session-attribution.ts";
import {
  type CheckpointRequestDecision,
  type RestoreFallback,
  type RestorePlan,
  type RestorePlanResult,
  sessionObjectPrefix,
} from "../checkpoints/checkpoint-service.ts";
import { own } from "../checkpoints/checkpoint-support.ts";
import { checkpointPendingReason } from "../checkpoints/durability.ts";
import type { CheckpointPointer } from "../checkpoints/ports/checkpoint-store.ts";
import type {
  CheckpointOutputObject,
  CheckpointVerifier,
} from "../checkpoints/ports/checkpoint-verifier.ts";
import { BundleIntegrityError } from "../extensions/bundle-service.ts";
import type { GitHubConnectionResolver } from "../github/index.ts";
import {
  allowedOwners,
  createGitHubPackagesEgress,
  isGitHubNpmTarball,
} from "../github/index.ts";
import {
  type GitHubGate,
  GitHubGateError,
  type GitHubGrant,
} from "../github/ports/github-gate.ts";
import type { GitHubMcpStore } from "../github/ports/github-mcp.ts";
import type { GitHubPackagesStore } from "../github/ports/github-packages.ts";
import type { McpEgressStore } from "../github/ports/mcp-egress.ts";
import { budgetExceeded } from "../limits/installation-limits.ts";
import {
  type PricedBy,
  type ProviderUsage,
  priceJudgmentUsage,
  priceProviderUsage,
} from "../limits/model-prices.ts";
import type { RepositoryAttachmentStore } from "../ports/repository-attachments.ts";
import type {
  ClaimInput as ClaimInputOf,
  EgressBindings,
  EgressIssue,
  EgressPurpose,
  FenceRejection,
  FinalizeResult,
  ResolvedCredential,
  WorkerBinding,
  WorkerFence,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { JudgmentEgressStore } from "../sessions/achievements/achievement-judgment-store.ts";
import type { JudgeConnections } from "../sessions/achievements/judge-connections.ts";
import {
  hashJudgmentToken,
  JUDGMENT_TOKEN_PREFIX,
} from "../sessions/achievements/judgment-token.ts";
import {
  type ClaimedMcpServer,
  connectionModels,
  connectionOf,
  type EgressUpstream,
  GITHUB_MCP_ENDPOINT,
  githubMcpBinding,
  mcpBinding,
  modelMoves,
  providerPathAllowed,
  providerUpstreamOf,
  repositoryBinding,
  repositoryUpstreamOf,
  runtimeConfigWithMcp,
  type SessionCatalog,
  type SessionGitHubMcp,
  type SessionMcp,
  trustedGitHubTools,
  withoutDeniedTools,
} from "../sessions/catalog.ts";
import {
  type NeutralizeEvent,
  neutralFieldsOf,
} from "../sessions/event-codecs.ts";
import {
  appBotAuthor,
  claimGitOf,
  coAuthorOfLink,
} from "../sessions/git-attribution.ts";
import type {
  ApprovalCheckpointCommit,
  WorkerPendingStore,
} from "../sessions/ports/pending-requests.ts";
import type { SessionTitleStore } from "../sessions/ports/session-title-store.ts";
import {
  hashTitleToken,
  type SessionTitler,
  TITLE_TOKEN_PREFIX,
  titleRun,
} from "../sessions/session-titler.ts";
import { createGitHubMcpEgress } from "./github-mcp-egress.ts";
import {
  appendNew,
  legacyConfigsFromRow,
  servedLegacyConfig,
} from "./legacy-runtime-configs.ts";
import { createMcpEgress, type McpEgressRequest } from "./mcp-egress.ts";
import {
  GITHUB_PACKAGE_REGISTRIES,
  PACKAGES_BINDING,
  type PackageRegistry,
  PUBLIC_PACKAGE_REGISTRIES,
} from "./package-registries.ts";
import { runtimeConfigOfSpec } from "./runtime-config-of-spec.ts";

// The repository binding of a session without a repository of its own:
// its repository route reaches only attached ones, each through the gate.
const ATTACHED_ONLY_BINDING = "attached-only";

export type WorkerGatewayStatus = 400 | 401 | 403 | 404 | 409 | 503;

// A heartbeat says the attempt is alive. "allocated" would walk the attempt
// back to the state a claim leaves behind, which reopens the one-shot
// bootstrap replay; the terminal states belong to release and to the
// backend's own observation, not to a self-report.
export const HEARTBEAT_STATES = new Set<AttemptState>([
  "starting",
  "running",
  "draining",
]);

export class WorkerGatewayError extends Error {
  constructor(
    readonly status: WorkerGatewayStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly receiptId?: string,
    readonly reasonCode?: string,
  ) {
    super(message);
  }
}

// The caller as the route layer established it from the bearer token.
export type WorkerPrincipal = Exclude<ResolvedCredential, null>;

/**
 * The server side of the checkpoint protocol, which `CheckpointService`
 * satisfies. Separate from the verifier so a composition without an object
 * store can still bind the gateway: it then answers every checkpoint request
 * and restore plan with CHECKPOINT_UNAVAILABLE instead of guessing.
 */
export type CheckpointProtocol = {
  /**
   * The workspace commits of the session's recent confirmed checkpoints.
   * Optional so a protocol that cannot answer says so: the route then
   * answers CHECKPOINT_UNAVAILABLE, never an empty (nothing protected) list.
   */
  protectedCommits?(input: {
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<string[]>;
  requestCheckpoint(input: {
    attemptId: string;
    preparation: CheckpointRequest["preparation"];
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<CheckpointRequestDecision>;
  getRestorePlan(input: {
    runtime: {
      cliVersion: string;
      engine: string;
      profileSha256: string;
      sdkVersion: string;
    };
    alternateProfileSha256s?: readonly string[];
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<RestorePlanResult>;
};

/**
 * What the gateway needs to say about tracing, owned here so the gateway
 * depends on no tracing package. A workspace's content mode can only lower the
 * installation's ceiling, which is the source's job to enforce.
 */
export interface ClaimTelemetrySource {
  claim(workspaceContentMode?: TraceContentMode): ClaimTelemetry;
  /** Undefined while tracing is off. */
  contentMode(
    workspaceContentMode?: TraceContentMode,
  ): TraceContentMode | undefined;
}

export type WorkerGatewayOptions = {
  workspaceEnforce?: "warn" | "fail" | "off";
  /** How long a heartbeat extends the lease. */
  leaseTtlMs: number;
  /** SESSION_COST_LIMIT_USD: past it a session is dispatched nothing new. */
  sessionCostLimitUsd: number;
  /** SESSION_TOKEN_LIMIT, held the same way; null, none. */
  sessionTokenLimit: number | null;
  /** Lifetime of the session token handed out by bootstrapClaim. */
  sessionTokenTtlMs?: number;
  /**
   * How long a registered permission or question takes answers (30 minutes
   * by default). The worker is told what is left, never a deadline.
   */
  pendingTtlMs?: number;
  /** Upper bound on nextInput long-polling. */
  maxWaitMs?: number;
  /** Once aborted, nextInput answers with what it has instead of waiting. */
  stopWaiting?: AbortSignal;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function hashWorkerToken(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * What a launched resource is labelled with so a later pass can tell which
 * credential it holds without reading the credential: a digest of the hash
 * the registry stores, so the registry can compute it from its own column
 * and the label is never the column's lookup key itself. Labels are readable
 * by anyone on the daemon; this reveals nothing the plaintext env var next
 * to it does not already.
 */
export function launchNonceFingerprint(nonceHash: Uint8Array): string {
  return createHash("sha256").update(nonceHash).digest("hex");
}

export function generateLaunchNonce(): string {
  return `wln_${randomBytes(32).toString("base64url")}`;
}

function generateSessionToken(): string {
  return `wsc_${randomBytes(32).toString("base64url")}`;
}

// Prefixes say which route a token is for when one turns up in a log or an
// event; the gateway never trusts them, the stored purpose decides.
const EGRESS_TOKEN_PREFIXES: Record<EgressPurpose, string> = {
  provider: "wep",
  repository: "wer",
  object_store: "weo",
  mcp: "wem",
  packages: "wek",
};

function generateEgressToken(purpose: EgressPurpose): string {
  return `${EGRESS_TOKEN_PREFIXES[purpose]}_${randomBytes(32).toString("base64url")}`;
}

/** What the egress proxy is told to do with one authorized request. */
export type EgressGrant = {
  session_id: string;
  attempt_id: string;
  upstream: EgressUpstream;
};

/**
 * The judgment route's grant: no session or attempt, so a proxy from before
 * judgment grants, which requires both, refuses it rather than charging a
 * session.
 */
export type JudgmentEgressGrant = {
  judgment_id: string;
  upstream: EgressUpstream;
};

function claimedExtensionsOf(
  binding: Pick<WorkerBinding, "extensions">,
): RuntimeConfig["extensions"] {
  const pinned = binding.extensions ?? [];
  return pinned.length === 0
    ? undefined
    : pinned.map(({ name, digest, scope }) => ({ name, digest, scope }));
}

function withExtensions(
  config: RuntimeConfig,
  extensions: RuntimeConfig["extensions"],
): RuntimeConfig {
  return extensions === undefined ? config : { ...config, extensions };
}

function withRestoreExtensions(
  restore: { restore_runtime_configs?: RuntimeConfig[] },
  extensions: RuntimeConfig["extensions"],
): { restore_runtime_configs?: RuntimeConfig[] } {
  return restore.restore_runtime_configs === undefined
    ? restore
    : {
        restore_runtime_configs: restore.restore_runtime_configs.map((config) =>
          withExtensions(config, extensions),
        ),
      };
}

function fenceOf(scope: WorkerScope): WorkerFence {
  return {
    sessionId: scope.session_id,
    attemptId: scope.attempt_id,
    leaseEpoch: scope.lease_epoch,
    executionGeneration: scope.execution_generation,
    authRevision: scope.auth_revision,
  };
}

/**
 * The answer as the polling worker can parse it. A permission answer's
 * `remember` is a field an image without `approval_remember` refuses along
 * with the whole response, so it gets the plain allow the person also gave.
 */
function withoutUnparsedRemember(
  answer: PostSessionAnswerRequest,
  capabilities: WorkerCapabilities | undefined,
): PostSessionAnswerRequest {
  if (
    answer.kind !== "permission" ||
    answer.remember === undefined ||
    capabilities?.approval_remember === true
  ) {
    return answer;
  }
  const { remember: _remember, ...plain } = answer;
  return plain;
}

function rejected(rejection: FenceRejection): never {
  if (rejection.outcome === "lease_expired") {
    throw new WorkerGatewayError(
      409,
      "LEASE_EXPIRED",
      "Lease expired; the attempt must stop writing",
    );
  }
  throw new WorkerGatewayError(
    409,
    "STALE_EPOCH",
    "Another epoch owns this session",
  );
}

/**
 * The checkpoint service answers a bad checkpoint with a verdict and throws
 * only when it could not reach a verdict: S3, git or the manifest read
 * failed underneath it. Left alone, that throw becomes a non-retryable 500
 * and the worker abandons a checkpoint that may be perfectly healthy.
 */
async function checkpointInfrastructure<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WorkerGatewayError) throw error;
    throw new WorkerGatewayError(
      503,
      "BACKEND_UNAVAILABLE",
      `Checkpoint storage could not be read: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

// Both the replay lookup and the commit answer in the same shape.
const FIRST_TURN_ID = "1";

function finalizeAnswer(result: FinalizeResult): FinalizeResponse {
  switch (result.outcome) {
    case "turn_not_found":
      throw new WorkerGatewayError(
        404,
        "NOT_FOUND",
        "Turn is not delivered to this attempt",
      );
    case "finalize_conflict":
      throw new WorkerGatewayError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Turn already finalized under a different finalize_key or body",
      );
    case "checkpoint_rejected":
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        `Checkpoint rejected: ${result.reason}`,
      );
    case "checkpoint_conflict":
      throw new WorkerGatewayError(
        409,
        "REVISION_CONFLICT",
        `The checkpoint pointer stands at ${result.currentRevision ?? "none"}; request the next revision and upload again`,
      );
    case "checkpoint_required":
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        `Session cannot be checkpointed: ${result.reason}; a completed turn is recorded only with a verified checkpoint`,
      );
    case "events_incomplete":
      throw new WorkerGatewayError(
        409,
        "REVISION_CONFLICT",
        `Events are durable through source_sequence ${result.acceptedThrough}, not final_source_sequence; append the tail from ${result.acceptedThrough + 1} before finalizing`,
      );
    case "finalized":
    case "replayed":
      return {
        turn_id: result.result.turnId,
        status: result.result.status,
        checkpoint_revision: result.result.checkpointRevision,
      };
    default:
      return rejected(result);
  }
}

function versionOnWire(object: { version?: string }): { version?: string } {
  return object.version === undefined ? {} : { version: object.version };
}

/** The service's restore plan as the worker protocol answers it. */
export function restorePlanOnWire(
  result: RestorePlanResult,
): RestorePlanResponse {
  switch (result.status) {
    case "none":
      return { status: "none" };
    case "unavailable":
      return {
        status: "unavailable",
        code: result.code,
        reason: result.reason,
      };
    case "incompatible":
      return {
        status: "incompatible",
        code: result.code,
        mismatches: result.mismatches.map((mismatch) => ({ ...mismatch })),
        ...(result.fallback === undefined
          ? {}
          : {
              fallback: {
                ...fallbackOnWire(result.fallback),
                revision: result.fallback.revision,
              },
            }),
      };
    default:
      return planOnWire(result.plan);
  }
}

function planOnWire(plan: RestorePlan): RestorePlanResponse {
  return {
    status: "ready",
    plan: {
      revision: plan.revision,
      manifest_ref: plan.manifestRef,
      manifest_sha256: plan.manifestSha256,
      ...(plan.manifestVersion === undefined
        ? {}
        : { manifest_version: plan.manifestVersion }),
      engine: plan.engine,
      resume: plan.resume,
      cwd: plan.cwd,
      git_commit: plan.gitCommit,
      artifacts: plan.artifacts.map((artifact) =>
        artifact.kind === "workspace_untracked"
          ? {
              kind: artifact.kind,
              label: artifact.label,
              objects: artifact.objects.map((object) => ({
                key: object.key,
                bytes: object.bytes,
                sha256: object.sha256,
                ...versionOnWire(object),
                path: object.path,
                ...(object.executable === true ? { executable: true } : {}),
              })),
            }
          : {
              kind: artifact.kind,
              label: artifact.label,
              objects: artifact.objects.map((object) => ({
                key: object.key,
                bytes: object.bytes,
                sha256: object.sha256,
                ...versionOnWire(object),
              })),
            },
      ),
      object_keys: [...plan.objectKeys],
      ...(plan.fallback === undefined
        ? {}
        : { fallback: fallbackOnWire(plan.fallback) }),
    },
  };
}

function fallbackOnWire(fallback: RestoreFallback) {
  return {
    pointer_revision: fallback.pointerRevision,
    skipped: fallback.skipped.map((skip) => ({
      revision: skip.revision,
      reason: skip.reason,
    })),
  };
}

export function createWorkerGateway(deps: {
  work: WorkerUnitOfWork;
  catalog: SessionCatalog;
  checkpoints: CheckpointVerifier;
  // Absent when no object store is configured; see CheckpointProtocol.
  checkpointProtocol?: CheckpointProtocol;
  // Absent, the pending routes answer 404 and the worker denies what it
  // cannot put to anyone; heartbeat then never reports an answer waiting.
  pending?: WorkerPendingStore;
  // Issues the credential of a GitHub repository. Absent, a repository
  // whose credential GitHub issues (`github_app`) is refused.
  github?: GitHubGate;
  // Absent, the remote MCP route is refused: nothing can say whether the
  // agent's credential is still bound.
  mcp?: McpEgressStore;
  onMcpReceiptError?: (error: unknown) => void;
  // Called when the note on why a model was cut could not be written; the
  // cut stands either way, and a lost note is not retried by a later regrant.
  onModelCutError?: (
    error: unknown,
    cut: { sessionId: string; attemptId: string },
  ) => void;
  onToolAudit?: (finding: {
    sessionId: string;
    attemptId: string;
    dropped: number;
    conflicts: number;
    unverified: number;
  }) => void;
  extensions?: {
    archive(workspaceId: string, digest: string): Promise<Uint8Array | null>;
  };
  // Absent, the built-in `github` MCP route is refused.
  githubMcp?: { store: GitHubMcpStore; grantKey: Uint8Array };
  // Absent, no attachment reaches a worker and its reports are dropped.
  attachments?: Pick<RepositoryAttachmentStore, "pending" | "settle">;
  // Absent, the GitHub Packages registries refuse every request and a
  // claim names no GitHub owners.
  githubPackages?: {
    store: GitHubPackagesStore;
    upstreams?: Partial<Record<GitHubPackagesRegistry, string>>;
  };
  // Absent, a session keeps the title cut from its first message.
  titles?: { store: SessionTitleStore; titler: SessionTitler };
  // Absent, the judgment route is refused. `upstream` reaches the judge a
  // connection names; absent, or null for that connection, the route is
  // unavailable.
  judgments?: {
    store: JudgmentEgressStore;
    upstream?: JudgeConnections["upstream"];
  };
  // Absent, events are stored without the engine-neutral fields beside them.
  neutralize?: NeutralizeEvent;
  // Absent, a claim carries no `git` and the worker adds no commit trailer.
  attribution?: {
    store: Pick<SessionAttributionStore, "attribution" | "githubLinkOf">;
    // Absent, a claim's commit values are not kept and a push is not checked
    // against them.
    ledger?: CommitAttributionLedger;
    consoleOrigin: string | null;
    // What names the session in the commit trailer: `id` leaves the console's
    // address out. Read at claim, so a change reaches commits made after the
    // worker's next claim. Absent, the address.
    sessionLink?: (workspaceId: string) => Promise<"url" | "id">;
    // The numeric id of an App's bot user; null when GitHub does not say.
    // Absent, a claim names no commit author and the image's default stays.
    appBotUserId?: (app: {
      slug: string;
      apiBase: string;
    }) => Promise<string | null>;
    // Pins an unpinned primary repository at claim (decision D11). Absent,
    // such a session's commits keep the image's author.
    commitPin?: {
      resolver: Pick<GitHubConnectionResolver, "resolve">;
      // The pin a claim needed was not made; the claim went on regardless.
      onFailed: (failure: {
        sessionId: string;
        repositoryId: string;
        reason: string;
      }) => void;
    };
  };
  // Absent, a claim carries no `telemetry` and a nextInput no `content_mode`:
  // the worker reads both as tracing off.
  telemetry?: ClaimTelemetrySource;
  options: WorkerGatewayOptions;
}) {
  const { work, catalog, checkpoints, pending, neutralize } = deps;

  // The session's config as its spec says, with the platform prompt its row
  // holds, which a checkpoint's fingerprint holds whichever config made it.
  function specConfigOf(
    binding: Pick<
      WorkerBinding,
      "spec" | "platformPrompt" | "repository" | "callerToolsDeny"
    >,
    providerToken: string,
  ): RuntimeConfig {
    const config = runtimeConfigOfSpec(
      binding.spec,
      providerToken,
      binding.repository !== null,
    );
    const tools = withoutDeniedTools(config.tools, binding.callerToolsDeny);
    const limited = tools === config.tools ? config : { ...config, tools };
    const prompt = binding.platformPrompt;
    return prompt ? { ...limited, platform_prompt: prompt } : limited;
  }

  // Only a primary repository on a console App: the App it is pinned to
  // pushes and opens its pull requests, so that App's bot wrote the commits
  // (decision D11). Undefined leaves the field off the claim; null tells the
  // worker to use the image's author.
  async function gitAuthorOf(
    attribution: (typeof deps)["attribution"],
    record: SessionAttributionRecord | null | undefined,
    sessionId: string,
    repositoryId: string | null,
  ): Promise<ClaimGitAuthor | null | undefined> {
    const lookUp = attribution?.appBotUserId;
    if (attribution === undefined || lookUp === undefined) return undefined;
    const entry =
      repositoryId === null
        ? undefined
        : own(catalog.repositories, repositoryId);
    if (
      record == null ||
      repositoryId === null ||
      entry?.auth === undefined ||
      !("registered" in entry.auth)
    ) {
      return null;
    }
    const app = record.authorPinned
      ? record.authorApp
      : await pinAtClaim(attribution, sessionId, repositoryId, entry.url);
    if (app === null) return null;
    const botUserId = await lookUp(app).catch(() => null);
    return botUserId === null ? null : appBotAuthor(app.slug, botUserId);
  }

  // What this claim asks the session's commits to carry, kept so a push is
  // judged by what the server issued. A claim without `git` or `git_author`
  // (an API from before them) asks for nothing checkable. A failed write fails
  // the claim, after the claim itself has committed. A transient storage error
  // answers 503 and the worker claims again; any other error, such as the
  // table missing before migration 0232, answers a non-retryable
  // INTERNAL_ERROR, the worker leaves, and the session returns to the queue
  // through the startup-failure backoff. Swallowing the error would leave a
  // session with no bundle, and a session with none is not checked at push.
  async function recordIssuedAttribution(
    sessionId: string,
    git: ClaimGit | undefined,
    gitAuthor: ClaimGitAuthor | null | undefined,
  ): Promise<void> {
    const ledger = deps.attribution?.ledger;
    if (ledger === undefined || git === undefined || gitAuthor === undefined) {
      return;
    }
    const author = gitAuthor ?? IMAGE_GIT_AUTHOR;
    const agentSession = git.session_url ?? sessionId;
    await ledger.record(sessionId, {
      author,
      coAuthor: git.co_author ?? null,
      agentSession,
    });
    // An author the claim now names (the App's bot lookup can differ between
    // claims) goes with the co-authors earlier turns were issued, none
    // included, as a repair
    // under this claim remakes their commits with this author.
    const seen = new Set<string>();
    for (const { coAuthor } of await ledger.list(sessionId)) {
      const key =
        coAuthor === null ? "" : `${coAuthor.name}\n${coAuthor.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await ledger.record(sessionId, { author, coAuthor, agentSession });
    }
  }

  // The bundles the push check will accept, as the ledger holds them: a worker
  // that restarted has lost the earlier turns' and its own check would refuse
  // a commit the push check accepts.
  async function issuedBundlesOf(sessionId: string) {
    const ledger = deps.attribution?.ledger;
    if (ledger === undefined) return [];
    return (await ledger.list(sessionId)).slice(0, 5000).map((bundle) => ({
      author: { name: bundle.author.name, email: bundle.author.email },
      co_author:
        bundle.coAuthor === null
          ? null
          : { name: bundle.coAuthor.name, email: bundle.coAuthor.email },
      agent_session: bundle.agentSession,
    }));
  }

  // The co-author a turn's commits name is the turn's requester, not the
  // session's starter, read now so a link made since shows from this turn on.
  // Recorded with the issued values before the worker is told, so a push never
  // sees a commit of this turn carry a co-author the server did not issue. A
  // redelivered turn records the same bundle again, which is one row. Undefined
  // without attribution, which leaves the claim's value in force.
  async function turnCoAuthor(
    sessionId: string,
    actorId: string | null,
  ): Promise<{ name: string; email: string } | null | undefined> {
    const attribution = deps.attribution;
    if (attribution === undefined) return undefined;
    const link =
      actorId === null
        ? null
        : await attribution.store.githubLinkOf(sessionId, actorId);
    const coAuthor = coAuthorOfLink(link);
    await attribution.ledger?.recordTurnCoAuthor(sessionId, coAuthor);
    return coAuthor;
  }

  // A primary repository with no author pin yet gets the one a token issue
  // would leave, chosen the same way, so the commits' bot is the pull
  // request's. Whatever stops it leaves the image's author: the claim is
  // never held up for it.
  async function pinAtClaim(
    attribution: NonNullable<(typeof deps)["attribution"]>,
    sessionId: string,
    repositoryId: string,
    url: string,
  ): Promise<{ slug: string; apiBase: string } | null> {
    const pinning = attribution.commitPin;
    if (pinning === undefined) return null;
    const failed = (reason: string) => {
      pinning.onFailed({ sessionId, repositoryId, reason });
      return null;
    };
    try {
      const repo = repoRefOf(url);
      if (repo === null) return failed("no_repo");
      const choice = await pinning.resolver.resolve(
        repositoryId,
        "author",
        repo,
        { pin: true, claim: { sessionId, receiptId: randomUUID() } },
      );
      if (choice.kind === "refused") return failed(choice.reason);
      if (choice.kind === "unreachable") return failed(choice.pinState);
      if (choice.kind === "none") return failed("no_author_app");
      // Read back through the pin, so a pin another path made first, or a
      // connection replaced meanwhile, decides as it would for the token.
      const pinned = await attribution.store.attribution(sessionId);
      return pinned?.authorApp ?? failed("not_pinned");
    } catch (error) {
      return failed(error instanceof Error ? error.name : "error");
    }
  }

  // A hint like hasUndelivered: a failed read waits for the next beat.
  async function attachmentsWaiting(sessionId: string): Promise<boolean> {
    if (deps.attachments === undefined) return false;
    const rows = await deps.attachments.pending(sessionId).catch(() => []);
    return rows.length > 0;
  }

  // The pending attachments a worker of the session fetches next, at the
  // catalog's URL; one that left the catalog is settled failed rather than
  // handed out forever.
  async function attachOrders(
    sessionId: string,
  ): Promise<RepositoryAttachOrder[] | undefined> {
    if (deps.attachments === undefined) return undefined;
    const rows = await deps.attachments.pending(sessionId);
    const gone = rows.filter(
      (row) => own(catalog.repositories, row.repositoryId) === undefined,
    );
    if (gone.length > 0) {
      await deps.attachments.settle(
        sessionId,
        gone.map((row) => ({
          repository_id: row.repositoryId,
          receipt_id: row.receiptId,
          status: "failed",
          failure: "fetch_failed",
        })),
      );
    }
    return rows.flatMap((row) => {
      const entry = own(catalog.repositories, row.repositoryId);
      return entry === undefined
        ? []
        : [
            {
              id: row.repositoryId,
              url: entry.url,
              branch: row.branch,
              receipt_id: row.receiptId,
            },
          ];
    });
  }

  const decideMcp =
    deps.mcp === undefined
      ? null
      : createMcpEgress({
          catalog,
          store: deps.mcp,
          ...(deps.onMcpReceiptError === undefined
            ? {}
            : { onReceiptError: deps.onMcpReceiptError }),
        });
  const decideGitHubMcp =
    deps.githubMcp === undefined ? null : createGitHubMcpEgress(deps.githubMcp);
  const decideGitHubPackages =
    deps.githubPackages === undefined
      ? null
      : createGitHubPackagesEgress(deps.githubPackages);
  const protocol = deps.checkpointProtocol;
  function requireProtocol(): CheckpointProtocol {
    if (protocol === undefined) {
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        "No checkpoint object store is configured on this control plane",
      );
    }
    return protocol;
  }
  const now = deps.options.now ?? (() => new Date());

  /**
   * An approval-wait checkpoint is verified as a finalize's would be, since
   * a crash can make it the session's pointer with no second look.
   */
  async function approvalCheckpointOf(
    fence: WorkerFence,
    turnId: string,
    checkpoint: NonNullable<RegisterPendingRequest["checkpoint"]>,
  ): Promise<ApprovalCheckpointCommit> {
    const { answers_through, ...ref } = checkpoint;
    const verdict = await checkpointInfrastructure(() =>
      checkpoints.verify({ fence, turnId, checkpoint: ref, at: now() }),
    );
    if (verdict.status === "rejected") {
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        `Checkpoint manifest rejected: ${verdict.reason}`,
      );
    }
    return {
      revision: ref.revision,
      manifestRef: ref.manifest_ref,
      manifestSha256: ref.manifest_sha256,
      ...(ref.manifest_version === undefined
        ? {}
        : { manifestVersion: ref.manifest_version }),
      versionsHeld: verdict.versionsHeld === true,
      ...(verdict.transcriptBytes === undefined
        ? {}
        : { transcriptBytes: verdict.transcriptBytes }),
      ...(verdict.runtime === undefined ? {} : { runtime: verdict.runtime }),
      answersThrough: answers_through,
    };
  }

  const sleep =
    deps.options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const leaseTtlMs = deps.options.leaseTtlMs;
  const sessionTokenTtlMs =
    deps.options.sessionTokenTtlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
  const tokenLimit = deps.options.sessionTokenLimit;
  const pendingTtlMs = deps.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const maxWaitMs = deps.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs =
    deps.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Only sessions this host can actually run are claimable: a session whose
  // connection left the catalog, whose model is no longer offered, or whose
  // repository moved waits for a host that runs it as it was created.
  let runnableOf: {
    connections: SessionCatalog["connections"];
    repositories: SessionCatalog["repositories"];
    settingsGeneration: number | null;
    input: Pick<
      ClaimInputOf,
      | "runnable"
      | "modelMoves"
      | "settingsGeneration"
      | "unsettledRepositoryIds"
      | "unsettledConnectionIds"
    >;
  } | null = null;
  function claimCatalog(): NonNullable<typeof runnableOf>["input"] {
    const { connections, repositories } = catalog;
    const settingsGeneration = catalog.settings_generation ?? null;
    if (
      runnableOf === null ||
      runnableOf.connections !== connections ||
      runnableOf.repositories !== repositories ||
      runnableOf.settingsGeneration !== settingsGeneration
    ) {
      runnableOf = {
        connections,
        repositories,
        settingsGeneration,
        input: {
          runnable: {
            connections: Object.entries(connections).map(
              ([id, connection]) => ({
                id,
                models: connectionModels(connection),
              }),
            ),
            repositories: Object.entries(repositories).map(
              ([repositoryId, repository]) => ({
                repositoryId,
                url: repository.url,
                branch: repository.branch,
              }),
            ),
            runtimeVersions: catalog.runtime_versions?.accepted ?? null,
          },
          modelMoves: Object.entries(connections).flatMap(([id, connection]) =>
            modelMoves(connection).map(({ from, to }) => ({
              connectionId: id,
              from,
              to,
            })),
          ),
          settingsGeneration,
          unsettledRepositoryIds:
            catalog.unavailable_repositories ?? new Set<string>(),
          unsettledConnectionIds:
            catalog.unavailable_connections ?? new Set<string>(),
        },
      };
    }
    return runnableOf.input;
  }

  // The catalog server the release names, then the built-in `github` when
  // the release carries GitHub settings.
  function claimedMcp(
    session: {
      mcp?: SessionMcp | null;
      githubMcp?: SessionGitHubMcp | null;
    },
    servers: typeof catalog.mcp_servers,
    // The claiming worker announced `platform_tool_trust`; for one that did
    // not, the strict claim schema refuses the marks, so they are left off.
    trust = false,
  ): ClaimedMcpServer[] {
    const { mcp, githubMcp } = session;
    const server = mcp ? own(servers ?? {}, mcp.server) : undefined;
    return [
      ...(mcp && server
        ? [
            {
              name: mcp.server,
              endpoint: server.url,
              binding: mcpBinding(mcp.releaseId, mcp.server, server),
              tools: mcp.tools,
            },
          ]
        : []),
      ...(githubMcp
        ? [
            {
              name: GITHUB_MCP_SERVER,
              endpoint: GITHUB_MCP_ENDPOINT,
              binding: githubMcpBinding(githubMcp.releaseId),
              tools: githubMcp.tools,
              ...(trust
                ? { trusted: trustedGitHubTools(githubMcp.tools) }
                : {}),
            },
          ]
        : []),
    ];
  }

  function withMcp(
    config: RuntimeConfig,
    mcp: readonly ClaimedMcpServer[],
    mcpToken: string,
  ): RuntimeConfig {
    return runtimeConfigWithMcp(config, mcp, mcpToken);
  }

  // The configs the session's checkpoints were made under other than the
  // one it runs now (before its model moved): the worker accepts a restored
  // checkpoint made under any of them, and runs the engine on
  // runtime_config.
  function restoreRuntimesOf(
    binding: Pick<
      WorkerBinding,
      | "legacyRuntimeConfigs"
      | "spec"
      | "platformPrompt"
      | "repository"
      | "callerToolsDeny"
    >,
    current: RuntimeConfig,
    providerToken: string,
    mcp: readonly ClaimedMcpServer[],
    mcpToken: string,
  ): { restore_runtime_configs?: RuntimeConfig[] } {
    const kept = legacyConfigsFromRow(binding.legacyRuntimeConfigs).map(
      (config) => servedLegacyConfig(config, providerToken),
    );
    // Checkpoints made before the built-in `github` server was attached
    // name only the catalog server; they resume into a run that has both.
    const legacy = mcp.filter((server) => server.name !== GITHUB_MCP_SERVER);
    const attached = legacy.length !== mcp.length;
    const offerings = (config: RuntimeConfig, running: boolean) => [
      ...(running ? [] : [withMcp(config, mcp, mcpToken)]),
      ...(attached ? [withMcp(config, legacy, mcpToken)] : []),
    ];
    // First, ahead of the cap: what the session ran before its limit removed
    // a tool is the config its own checkpoints carry.
    const unlimited = specConfigOf(
      { ...binding, callerToolsDeny: [] },
      providerToken,
    );
    const beforeLimit =
      unlimited.tools.length === current.tools.length
        ? []
        : offerings(unlimited, false);
    const offered = appendNew(
      beforeLimit,
      appendNew(
        offerings(current, true),
        kept.flatMap((config) => offerings(config, false)),
      ),
    ).slice(0, MAX_RESTORE_CONFIGS);
    return offered.length === 0 ? {} : { restore_runtime_configs: offered };
  }

  // What each egress token is held to, taken from the catalog at the moment
  // the claim binds the session. Only a runnable pair is ever claimed, so
  // its entries exist here.
  function egressBindingsOf(
    session: Parameters<EgressIssue["bindingsOf"]>[0],
    mcpServers: typeof catalog.mcp_servers,
  ): EgressBindings {
    if (connectionOf(catalog, session.connectionId) === undefined) {
      throw new Error("A claimed session has no runnable connection");
    }
    // Thrown inside the claim's transaction, so nothing is bound and the
    // worker asks again, of a replica that has read or resolved the server.
    const server = session.mcp?.server;
    if (server !== undefined && own(mcpServers ?? {}, server) === undefined) {
      throw new WorkerGatewayError(
        503,
        "BACKEND_UNAVAILABLE",
        "The session's release names an MCP server this host's catalog does not hold",
        true,
      );
    }
    // The provider token is held to the session's spec: a session whose spec
    // was rewritten (its model moved) gets a token for the new one.
    const provider = session.specDigest;
    const object_store = sessionObjectPrefix(session.id);
    // One token serves both servers; it is held to the catalog server's
    // binding when there is one, as the remote route checks.
    const [first] = claimedMcp(session, mcpServers);
    const mcpBinding = {
      ...(first === undefined ? {} : { mcp: first.binding }),
      packages: PACKAGES_BINDING,
    };
    if (session.repositoryMode === "none") {
      // A session without a repository still reaches the ones it attached;
      // the gate decides each fetch.
      return {
        provider,
        repository: ATTACHED_ONLY_BINDING,
        object_store,
        ...mcpBinding,
      };
    }
    const repository = session.repositoryId
      ? own(catalog.repositories, session.repositoryId)
      : undefined;
    if (!repository || session.repositoryId === null) {
      throw new Error("A claimed session has no runnable repository");
    }
    return {
      provider,
      repository: repositoryBinding(session.repositoryId, repository),
      object_store,
      ...mcpBinding,
    };
  }

  // The owners the worker points at the GitHub Packages registries; null
  // when none are allowed, so the claim carries nothing for them.
  async function githubOwnersOf(
    workspaceId: string,
  ): Promise<Record<GitHubPackagesRegistry, string[]> | null> {
    if (deps.githubPackages === undefined) return null;
    const owners = allowedOwners(
      await deps.githubPackages.store.allowlist(workspaceId),
    );
    return owners.npm.length + owners.rubygems.length === 0 ? null : owners;
  }

  // The repositories besides its own the session's release lets it work on
  // (session-multi-repository.md decision 2), reached with the attempt's
  // repository token on the route named for each. Not pinned at the claim:
  // the gate reads the release and catalog again on every fetch.
  async function additionalWorkspaceRepositories(
    sessionId: string,
    token: string,
  ): Promise<AdditionalWorkspaceRepository[]> {
    const ids = (await deps.github?.additionalRepositories?.(sessionId)) ?? [];
    return ids.flatMap((id) => {
      const entry = own(catalog.repositories, id);
      return entry === undefined
        ? []
        : [
            {
              id,
              url: entry.url,
              branch: entry.branch,
              access: { kind: "egress_token" as const, token },
            },
          ];
    });
  }

  // A catalog that moved since the claim (a setting edited in the console)
  // is not followed: the attempt agreed to one endpoint and one repository.
  // The proxy is refused rather than pointed somewhere new.
  function moved(what: string): never {
    throw new WorkerGatewayError(
      409,
      "CATALOG_MISMATCH",
      `The ${what} changed in the catalog since this attempt was claimed`,
    );
  }
  function forgeUnavailable(): never {
    throw new WorkerGatewayError(
      503,
      "BACKEND_UNAVAILABLE",
      "The repository's forge credential could not be issued",
      true,
    );
  }

  function githubRefused(error: GitHubGateError): never {
    throw new WorkerGatewayError(
      githubRefusalStatus(error.reasonCode),
      "GITHUB_REFUSED",
      `GitHub work refused: ${error.reasonCode}`,
      false,
      undefined,
      error.reasonCode,
    );
  }

  // Another repository is reached only with the gate's own token: the gate
  // decides whether the session's release still lets it (decision 5), so a
  // deployment without one has no route to it.
  async function additionalRepositoryUpstream(
    sessionId: string,
    repositoryId: string,
  ): Promise<EgressUpstream> {
    if (deps.github === undefined) moved("session's repository");
    let issued: GitHubGrant | null;
    try {
      issued = await deps.github.grant({
        sessionId,
        purpose: "clone",
        repositoryId,
      });
    } catch (error) {
      if (error instanceof GitHubGateError) githubRefused(error);
      forgeUnavailable();
    }
    const entry = own(catalog.repositories, repositoryId);
    if (issued === null || entry === undefined) forgeUnavailable();
    return repositoryUpstreamOf(entry, issued.gitCredential);
  }

  // A title request's token, held to the session's budget and connection as
  // the engine's calls are; null for any other token. No fence: the attempt
  // it is charged to may have ended since its first turn. The prefix only
  // spares the engine's calls a lookup that claims; the row decides.
  async function authorizedTitleEgress(
    token: string,
    path: string | undefined,
  ): Promise<EgressGrant | null> {
    if (deps.titles === undefined || !token.startsWith(TITLE_TOKEN_PREFIX)) {
      return null;
    }
    const result = await deps.titles.store.authorizeAtomic({
      tokenHash: hashTitleToken(token),
    });
    if (result.outcome !== "ok") return null;
    if (
      budgetExceeded(result, {
        costUsd: deps.options.sessionCostLimitUsd,
        tokens: tokenLimit,
      })
    ) {
      throw new WorkerGatewayError(
        403,
        "BUDGET_EXCEEDED",
        "The session has reached its cost or token limit",
      );
    }
    const run = titleRun(catalog, result);
    if (run === null) moved("session's connection");
    requireProviderPath(run.connection.provider.kind, path);
    return {
      session_id: result.sessionId,
      attempt_id: result.attemptId,
      upstream: providerUpstreamOf(run.connection.provider),
    };
  }

  // The provider route a session's connection kind does not serve is
  // refused here: the proxy parses the path, only this side knows the kind.
  function requireProviderPath(
    kind: Parameters<typeof providerPathAllowed>[0],
    path: string | undefined,
  ): void {
    if (providerPathAllowed(kind, path)) return;
    throw new WorkerGatewayError(
      403,
      "FORBIDDEN",
      "This provider route is not served by the session's connection",
    );
  }

  // What an egress token stands for once its attempt still owns the session;
  // anything else is refused here, before any route looks at the request.
  async function authorizedEgress(request: {
    token: string;
    purpose: EgressPurpose;
  }) {
    const result = await work.authorizeEgressAtomic({
      tokenHash: hashWorkerToken(request.token),
      purpose: request.purpose,
    });
    if (result.outcome === "invalid_token") {
      throw new WorkerGatewayError(
        401,
        "UNAUTHORIZED",
        "Egress token is missing, expired, revoked or for another route",
      );
    }
    if (result.outcome !== "ok") {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "The attempt this token belongs to no longer owns its session",
      );
    }
    return result;
  }

  // The write fence comes from the token, not from the body. Checking the
  // body against it closes the race where a holder of a token that is about
  // to be revoked sends the next revision's numbers ahead of time and has
  // them accepted once the rotation lands.
  function requireScope(principal: WorkerPrincipal, scope: WorkerScope) {
    if (principal.kind !== "session") {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "Bootstrap credentials may only call bootstrapClaim",
      );
    }
    const fence = fenceOf(scope);
    if (
      principal.sessionId !== fence.sessionId ||
      principal.attemptId !== fence.attemptId
    ) {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "Token does not match the requested binding",
      );
    }
    const behind =
      fence.leaseEpoch < principal.leaseEpoch ||
      fence.executionGeneration < principal.executionGeneration ||
      fence.authRevision < principal.authRevision;
    const ahead =
      fence.leaseEpoch > principal.leaseEpoch ||
      fence.executionGeneration > principal.executionGeneration ||
      fence.authRevision > principal.authRevision;
    if (behind) {
      throw new WorkerGatewayError(
        409,
        "STALE_EPOCH",
        "The request carries an epoch older than the token's binding",
      );
    }
    if (ahead) {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "The request claims an epoch the token was not issued for",
      );
    }
    // The token's own view can still be stale against the row; the fenced
    // SQL below is what decides that.
    return fence;
  }

  function requirePending(): WorkerPendingStore {
    if (!pending) {
      throw new WorkerGatewayError(
        404,
        "NOT_FOUND",
        "This gateway does not serve pending requests",
      );
    }
    return pending;
  }

  return {
    async authenticate(token: string | null): Promise<WorkerPrincipal> {
      const principal = token
        ? await work.resolveCredential(hashWorkerToken(token))
        : null;
      if (!principal) {
        throw new WorkerGatewayError(
          401,
          "UNAUTHORIZED",
          "Worker token is missing, expired or revoked",
        );
      }
      return principal;
    },

    async bootstrapClaim(
      principal: WorkerPrincipal,
      request: BootstrapClaimRequest,
    ): Promise<BootstrapClaimResponse> {
      if (request.credential.kind !== "launch_nonce") {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "workload_identity bootstrap is not available on this backend",
        );
      }
      if (principal.kind !== "bootstrap") {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "bootstrapClaim requires the launch nonce as bearer token",
        );
      }
      const at = now();
      const sessionToken = generateSessionToken();
      const providerToken = generateEgressToken("provider");
      const repositoryToken = generateEgressToken("repository");
      const objectStoreToken = generateEgressToken("object_store");
      const mcpToken = generateEgressToken("mcp");
      const packagesToken = generateEgressToken("packages");
      const claimable = claimCatalog();
      // One read for the check, the token's binding and the response, so a
      // refresh between them cannot drop a server the claim already bound.
      const mcpServers = catalog.mcp_servers;
      const result = await work.claimAtomic({
        ...claimable,
        costLimitUsd: deps.options.sessionCostLimitUsd,
        tokenLimit,
        nonceHash: hashWorkerToken(request.credential.nonce),
        executionId: request.execution_id,
        executionGeneration: request.execution_generation,
        ...(request.image_runtime === undefined
          ? {}
          : {
              imageRuntime: {
                engine: request.image_runtime.engine,
                sdkVersion: request.image_runtime.sdk_version,
                cliVersion: request.image_runtime.cli_version,
                profileDigestScheme:
                  request.image_runtime.profile_digest_scheme,
              },
            }),
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(sessionToken),
        credentialTtlMs: sessionTokenTtlMs,
        egress: {
          providerHash: hashWorkerToken(providerToken),
          repositoryHash: hashWorkerToken(repositoryToken),
          objectStoreHash: hashWorkerToken(objectStoreToken),
          mcpHash: hashWorkerToken(mcpToken),
          packagesHash: hashWorkerToken(packagesToken),
          bindingsOf: (session) => egressBindingsOf(session, mcpServers),
        },
        leaseTtlMs,
        now: at,
        ...(request.capabilities?.user_env === true
          ? { userEnv: true as const }
          : {}),
        engineSettingsCaps: {
          engineSettings: request.capabilities?.engine_settings === true,
          permissionRules: request.capabilities?.permission_rules === true,
        },
      });
      switch (result.outcome) {
        case "invalid_credential":
          throw new WorkerGatewayError(
            401,
            "UNAUTHORIZED",
            "Launch nonce is unknown, expired or bound to another execution",
          );
        case "no_session":
          throw new WorkerGatewayError(
            404,
            "NOT_FOUND",
            "No session is waiting in this partition",
            true,
          );
        case "connection_unavailable":
          throw new WorkerGatewayError(
            503,
            "BACKEND_UNAVAILABLE",
            "The session's connection, model or repository is not in this host's catalog",
            true,
          );
        // Not retryable: the session is no longer waiting for a worker, and
        // the one that asked has nothing to do but leave.
        case "context_gap":
          throw new WorkerGatewayError(
            409,
            "RECOVERY_REQUIRED",
            "The session has turns no checkpoint covers; an operator decides how it continues",
          );
        // Not retryable: the session this launch was for has been failed and
        // the launch asked to go, so a retry could only find nothing.
        case "catalog_mismatch":
          throw new WorkerGatewayError(
            409,
            "CATALOG_MISMATCH",
            "The session this launch was reserved for runs on a connection, model or repository this host's catalog no longer holds; the session was failed",
          );
        // Retryable, and nothing was consumed: the session waits for a worker
        // that announces `user_env`. It never runs without its variables.
        case "user_env_unsupported":
          throw new WorkerGatewayError(
            503,
            "BACKEND_UNAVAILABLE",
            "The session holds variables and this worker does not carry them yet",
            true,
          );
        // Retryable, nothing consumed: the saved rules need a field this
        // worker does not carry. It never runs a session without them.
        case "engine_settings_unsupported":
          throw new WorkerGatewayError(
            503,
            "BACKEND_UNAVAILABLE",
            "The session has saved rules and this worker does not carry them yet",
            true,
          );
        // Not retryable: a source of the rules cannot be read, and running
        // without them would widen what the session may do.
        case "engine_settings_closed":
          throw new WorkerGatewayError(
            403,
            "FORBIDDEN",
            "The rules saved for this session cannot be read, so it does not start",
          );
        // Not retryable, as above: the session was failed and the launch given up.
        case "variables_refused":
          throw new WorkerGatewayError(
            409,
            "VARIABLE_UNRESOLVED",
            "A variable the session took when it was accepted is refused; the session was failed",
          );
        // Not retryable: this worker will never be the image it was launched
        // as. The session waits for a launch on a correctly configured one.
        case "image_mismatch":
          throw new WorkerGatewayError(
            409,
            "LAUNCH_FAILED",
            `This worker's image does not run the ${result.assumed.engine} sdk ${result.assumed.sdkVersion} cli ${result.assumed.cliVersion} digest scheme ${result.assumed.profileDigestScheme} its launch was configured for; the image is refused until its configured runtime is corrected`,
            false,
            undefined,
            "worker_image_mismatch",
          );
        default: {
          const binding = result.binding;
          const mcp = claimedMcp(
            binding,
            mcpServers,
            request.capabilities?.platform_tool_trust === true,
          );
          const current = specConfigOf(binding, providerToken);
          // A launch on the previous image runs that image's engine, which
          // the worker checks the claim against; the spec names the version
          // the release was made on.
          const run = {
            runtime: {
              kind: binding.spec.runtime.kind,
              version:
                binding.launchRuntime?.sdkVersion ??
                binding.spec.runtime.version,
              connection_id: binding.spec.connection.id,
            },
            spec_digest: binding.specDigest,
            runtime_config: current,
          };
          const extensions = claimedExtensionsOf(binding);
          const resolved = {
            ...run,
            runtime_config: {
              ...withExtensions(
                withMcp(run.runtime_config, mcp, mcpToken),
                extensions,
              ),
              // Only for a worker that announced `user_env` (the claim
              // refused otherwise), and absent when there are none.
              ...(binding.env === undefined ? {} : { env: binding.env }),
              // Only for a worker that announced the capability (the claim
              // was refused otherwise); absent when no rule is saved, so a
              // rule-free agent's claim is what it was.
              ...(binding.engineSettings?.engine === undefined
                ? {}
                : { engine_settings: binding.engineSettings.engine }),
              ...((binding.engineSettings?.disallowedTools.length ?? 0) === 0
                ? {}
                : {
                    disallowed_tools: [
                      ...new Set([
                        ...(run.runtime_config.disallowed_tools ?? []),
                        ...(binding.engineSettings?.disallowedTools ?? []),
                      ]),
                    ].sort(),
                  }),
              // Only for a worker that announced `response_language`: an
              // older one refuses the field, so it runs without the language
              // rather than not at all. Outside every fingerprint.
              ...(binding.releaseLanguage != null &&
              request.capabilities?.response_language === true
                ? { response_language: binding.releaseLanguage }
                : {}),
            },
          };
          const githubOwners = await githubOwnersOf(binding.ownerScope);
          const attribution = deps.attribution;
          const record =
            attribution === undefined
              ? undefined
              : await attribution.store.attribution(binding.sessionId);
          const git =
            attribution === undefined || record === undefined
              ? undefined
              : claimGitOf(
                  record,
                  attribution.consoleOrigin,
                  binding.sessionId,
                  (await attribution.sessionLink?.(binding.ownerScope)) ??
                    "url",
                );
          const gitAuthor = await gitAuthorOf(
            attribution,
            record,
            binding.sessionId,
            binding.repository?.id ?? null,
          );
          await recordIssuedAttribution(binding.sessionId, git, gitAuthor);
          const issued = await issuedBundlesOf(binding.sessionId);
          const additional = await additionalWorkspaceRepositories(
            binding.sessionId,
            repositoryToken,
          );
          return {
            session_id: binding.sessionId,
            turn_id: null,
            attempt_id: binding.attemptId,
            lease_epoch: binding.leaseEpoch,
            execution_generation: binding.executionGeneration,
            auth_revision: binding.authRevision,
            session_credential: sessionToken,
            lease_expires_at: binding.leaseExpiresAt.toISOString(),
            lease_remaining_ms: binding.leaseRemainingMs,
            ...resolved,
            ...withRestoreExtensions(
              restoreRuntimesOf(binding, current, providerToken, mcp, mcpToken),
              extensions,
            ),
            packages: {
              access: { kind: "egress_token", token: packagesToken },
              ...(githubOwners === null ? {} : { github: githubOwners }),
            },
            workspace: {
              repository: binding.repository && {
                ...binding.repository,
                access: { kind: "egress_token", token: repositoryToken },
              },
              ...(additional.length === 0
                ? {}
                : { additional_repositories: additional }),
            },
            object_store: {
              access: { kind: "egress_token", token: objectStoreToken },
            },
            repository_access: {
              kind: "egress_token",
              token: repositoryToken,
            },
            principal: { owner_scope: binding.ownerScope },
            restore: binding.restore,
            // A replay can bind a session that has since spent its budget;
            // its engine gets nothing to spend, and nextInput hands it no turn.
            // An unmetered session gets no budget at all: the engine would
            // price a model it does not know at a guessed rate and cut the
            // turn on it.
            remaining_budget_usd: binding.unmetered
              ? null
              : Math.max(0, deps.options.sessionCostLimitUsd - binding.costUsd),
            workspace_enforce:
              deps.options.workspaceEnforce ?? DEFAULT_WORKSPACE_ENFORCE,
            ...(binding.grants === undefined || binding.grants.length === 0
              ? {}
              : {
                  // An image that did not announce `approval_remember` has a
                  // strict grant schema that would refuse the whole claim.
                  grants: binding.grants.map(
                    ({ remember_offer: offer, ...grant }) =>
                      request.capabilities?.approval_remember === true &&
                      offer !== undefined
                        ? { ...grant, remember_offer: offer }
                        : grant,
                  ),
                }),
            ...(git === undefined
              ? {}
              : { git, git_strip: [...ENGINE_COAUTHOR_EMAILS] }),
            ...(gitAuthor === undefined ? {} : { git_author: gitAuthor }),
            ...(issued.length === 0 ? {} : { git_issued: issued }),
            ...(deps.telemetry === undefined
              ? {}
              : { telemetry: deps.telemetry.claim() }),
          };
        }
      }
    },

    async extensionBundle(
      principal: WorkerPrincipal,
      request: { attemptId: string; digest: string },
    ): Promise<{ digest: string; tar: Uint8Array }> {
      if (principal.kind !== "session") {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "Bootstrap credentials may only call bootstrapClaim",
        );
      }
      if (principal.attemptId !== request.attemptId) {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "Token does not match the requested attempt",
        );
      }
      const bundles = deps.extensions;
      if (bundles === undefined) {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "Extension bundles are not served here",
        );
      }
      const state = await work.extensionsStateAtomic({
        fence: {
          sessionId: principal.sessionId,
          attemptId: principal.attemptId,
          leaseEpoch: principal.leaseEpoch,
          executionGeneration: principal.executionGeneration,
          authRevision: principal.authRevision,
        },
        now: now(),
      });
      if (state.outcome !== "ok") rejected(state);
      if (!state.extensions.some((e) => e.digest === request.digest)) {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "The session does not run with that bundle",
        );
      }
      let tar: Uint8Array | null;
      try {
        tar = await bundles.archive(state.ownerScope, request.digest);
      } catch (error) {
        if (error instanceof BundleIntegrityError) {
          throw new WorkerGatewayError(
            409,
            "UNSUPPORTED_CAPABILITY",
            "The stored bundle failed its integrity check and cannot be served",
          );
        }
        throw error;
      }
      if (tar === null) {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "The session does not run with that bundle",
        );
      }
      return { digest: request.digest, tar };
    },

    // The object store route's question, asked on every request
    // like the others: which session prefix does this token still reach?
    // Only the prefix comes back; which requests under it are signed is the
    // API's object store signer's to decide, since only it holds the key.
    async authorizeObjectAccess(request: {
      token: string;
    }): Promise<{ session_id: string; attempt_id: string; scope: string }> {
      const result = await authorizedEgress({
        token: request.token,
        purpose: "object_store",
      });
      // Issued from the session id, so a mismatch is a row nobody should
      // have written; it reaches nothing rather than whatever it names.
      if (result.binding !== sessionObjectPrefix(result.sessionId)) {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "The token's object prefix is not its session's",
        );
      }
      return {
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        scope: result.binding,
      };
    },

    // The egress proxy's question, asked on every request to a credential
    // route: what does this token stand for right now? The answer
    // carries the upstream credential, so only the authorizer listener —
    // unreachable from any worker — may put it on the wire.
    async authorizeMcpEgress(
      request: { token: string } & McpEgressRequest,
    ): Promise<EgressGrant> {
      const result = await authorizedEgress({
        token: request.token,
        purpose: "mcp",
      });
      const decide =
        request.server === GITHUB_MCP_SERVER ? decideGitHubMcp : decideMcp;
      if (decide === null) {
        throw new WorkerGatewayError(
          503,
          "BACKEND_UNAVAILABLE",
          "This gateway does not serve the MCP route",
          true,
        );
      }
      const decision = await decide(result, request);
      if (decision.kind === "refused") {
        throw new WorkerGatewayError(
          decision.status,
          decision.code,
          decision.message,
          false,
          decision.receiptId,
        );
      }
      return {
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        upstream: decision.upstream,
      };
    },

    // A public registry carries no credential, so the gateway's part is the
    // fence: only a token whose attempt still owns its session reaches one.
    // A GitHub Packages registry also needs the workspace's bot token, which
    // only the allowlist hands out.
    async authorizePackagesEgress(request: {
      token: string;
      registry: PackageRegistry;
      /** Path and query below the registry; required for GitHub's. */
      path?: string | undefined;
      regrant?: boolean | undefined;
    }): Promise<EgressGrant> {
      const result = await authorizedEgress({
        token: request.token,
        purpose: "packages",
      });
      if (result.binding !== PACKAGES_BINDING) moved("package registry set");
      const github =
        request.registry in GITHUB_PACKAGE_REGISTRIES
          ? GITHUB_PACKAGE_REGISTRIES[
              request.registry as keyof typeof GITHUB_PACKAGE_REGISTRIES
            ]
          : request.registry === "npm" &&
              request.path !== undefined &&
              isGitHubNpmTarball(request.path)
            ? "npm"
            : null;
      if (github !== null) {
        if (decideGitHubPackages === null || request.path === undefined) {
          throw new WorkerGatewayError(
            403,
            "FORBIDDEN",
            "GitHub Packages are not served here",
          );
        }
        const decision = await decideGitHubPackages({
          sessionId: result.sessionId,
          attemptId: result.attemptId,
          repositoryId: result.repository?.id ?? null,
          registry: github,
          path: request.path,
          regrant: request.regrant === true,
        });
        if (decision.kind === "refused") {
          throw new WorkerGatewayError(
            403,
            "FORBIDDEN",
            `GitHub Packages request refused: ${decision.reason}`,
            false,
            decision.receiptId ?? undefined,
            decision.reason,
          );
        }
        return {
          session_id: result.sessionId,
          attempt_id: result.attemptId,
          upstream: decision.upstream,
        };
      }
      return {
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        upstream: {
          url: PUBLIC_PACKAGE_REGISTRIES[
            request.registry as keyof typeof PUBLIC_PACKAGE_REGISTRIES
          ],
          headers: [],
        },
      };
    },

    async authorizeEgress(request: {
      token: string;
      purpose: "provider" | "repository";
      /** repository only: another repository than the session's own. */
      repository_id?: string | undefined;
      /** provider only: `/v1/responses`; absent is a Messages call. */
      path?: string | undefined;
    }): Promise<EgressGrant> {
      if (request.purpose === "provider") {
        const titled = await authorizedTitleEgress(request.token, request.path);
        if (titled !== null) return titled;
      }
      const result = await authorizedEgress(request);
      const grant = (upstream: EgressUpstream): EgressGrant => ({
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        upstream,
      });
      if (request.purpose === "provider") {
        // What a session has spent is metered here, a tool's direct calls
        // with the engine's token included; a session past its
        // limit gets no new provider exchange, and the proxy's regrant cuts
        // an open one.
        if (
          budgetExceeded(result, {
            costUsd: deps.options.sessionCostLimitUsd,
            tokens: tokenLimit,
          })
        ) {
          throw new WorkerGatewayError(
            403,
            "BUDGET_EXCEEDED",
            "The session has reached its cost or token limit",
          );
        }
        const connection =
          result.connectionId === null
            ? undefined
            : connectionOf(catalog, result.connectionId);
        // A model taken off the list cuts the attempt still running it here,
        // at the proxy's next regrant.
        if (
          connection === undefined ||
          result.model === null ||
          !connectionModels(connection).includes(result.model)
        ) {
          // Told to the session: a model left off the list, or its
          // connection gone, so the model it ran is no longer reachable.
          const cause: ModelCutCause | null =
            connection === undefined
              ? "connection_removed"
              : result.model !== null
                ? "model_removed"
                : null;
          if (cause !== null && result.model !== null) {
            // The cut happens either way; a failed note must not turn it
            // into a 500 the proxy would read as an outage.
            await work
              .recordModelCutAtomic({
                sessionId: result.sessionId,
                attemptId: result.attemptId,
                model: result.model,
                cause,
              })
              .catch((error: unknown) =>
                deps.onModelCutError?.(error, {
                  sessionId: result.sessionId,
                  attemptId: result.attemptId,
                }),
              );
          }
          moved("session's connection");
        }
        requireProviderPath(connection.provider.kind, request.path);
        return grant(providerUpstreamOf(connection.provider));
      }
      const other = request.repository_id;
      // A session started without a repository reaches only the ones it
      // attached (session-repository-attachment.md decision 4).
      if (result.repository === null) {
        if (other === undefined || result.binding !== ATTACHED_ONLY_BINDING) {
          moved("session's repository");
        }
        return grant(
          await additionalRepositoryUpstream(result.sessionId, other),
        );
      }
      const { id, url, branch } = result.repository;
      if (other !== undefined && other !== id) {
        return grant(
          await additionalRepositoryUpstream(result.sessionId, other),
        );
      }
      const listedRepository =
        id === null ? undefined : own(catalog.repositories, id);
      if (
        id === null ||
        listedRepository === undefined ||
        listedRepository.url !== url ||
        listedRepository.branch !== branch ||
        repositoryBinding(id, listedRepository) !== result.binding
      ) {
        moved("session's repository");
      }
      if (deps.github === undefined) {
        forgeUnavailable();
      }
      let issued: GitHubGrant | null;
      try {
        issued = await deps.github.grant({
          sessionId: result.sessionId,
          purpose: "clone",
        });
      } catch (error) {
        // The proxy hands git only a refusal; the session's receipt (the
        // gate's) carries the reason for the person reading the session.
        if (error instanceof GitHubGateError) githubRefused(error);
        // The adapter logs why; nothing of its error reaches the proxy.
        forgeUnavailable();
      }
      if (issued === null) {
        forgeUnavailable();
      }
      return grant(
        repositoryUpstreamOf(listedRepository, issued.gitCredential),
      );
    },

    // The judgment route's question: a judgment token stands for one
    // running judgment while the judge holds its lease. Held to the
    // workspace's judgment budget, never a session's.
    async authorizeJudgmentEgress(request: {
      token: string;
    }): Promise<JudgmentEgressGrant> {
      const invalid = () =>
        new WorkerGatewayError(
          401,
          "UNAUTHORIZED",
          "Judgment token is missing, expired or for another route",
        );
      if (
        deps.judgments === undefined ||
        !request.token.startsWith(JUDGMENT_TOKEN_PREFIX)
      ) {
        throw invalid();
      }
      const result = await deps.judgments.store.authorizeToken({
        tokenHash: hashJudgmentToken(request.token),
      });
      if (result.outcome !== "ok") throw invalid();
      if (result.spentUsd >= result.dailyBudgetUsd) {
        throw new WorkerGatewayError(
          403,
          "BUDGET_EXCEEDED",
          "The workspace has spent its judgment budget for the day",
        );
      }
      const upstream =
        result.connectionId === null
          ? null
          : ((await deps.judgments.upstream?.(result.connectionId)) ?? null);
      if (upstream === null) {
        throw new WorkerGatewayError(
          503,
          "BACKEND_UNAVAILABLE",
          "No judge is reachable for this workspace",
          true,
        );
      }
      return { judgment_id: result.judgmentId, upstream };
    },

    // What one judgment call used, as the proxy read it off the answer: the
    // judgment's ledger, apart from every session's spend.
    async recordJudgmentUsage(report: {
      exchangeId: string;
      judgmentId: string;
      usage: ProviderUsage;
    }): Promise<{ costUsd: number; pricedBy: PricedBy }> {
      const priced = priceJudgmentUsage(report.usage);
      const result =
        deps.judgments === undefined
          ? { outcome: "unknown_judgment" as const }
          : await deps.judgments.store.recordUsage({
              exchangeId: report.exchangeId,
              judgmentId: report.judgmentId,
              inputTokens: report.usage.inputTokens,
              costUsd: priced.costUsd,
            });
      if (result.outcome === "unknown_judgment") {
        throw new WorkerGatewayError(404, "NOT_FOUND", "No such judgment");
      }
      if (result.outcome === "conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "That exchange was reported with other usage",
        );
      }
      return { costUsd: result.costUsd, pricedBy: priced.pricedBy };
    },

    // What one Messages call through the provider route used, as the proxy
    // read it off the answer. This is the session's spend: the
    // engine's calls and any a tool made with the engine's token alike.
    async recordProviderUsage(report: {
      exchangeId: string;
      sessionId: string;
      attemptId: string;
      usage: ProviderUsage;
    }): Promise<{
      costUsd: number;
      pricedBy: PricedBy;
      ledgerForeignRow?: true;
    }> {
      // Decided by the session row, never by the model the answer names
      // (the upstream's to pick) or by this API's catalog (another replica's
      // may differ mid-rollout).
      const result = await work.recordProviderUsageAtomic({
        ...report,
        priceFor: (session) =>
          session.unmetered
            ? { costUsd: 0, pricedBy: "unmetered" }
            : priceProviderUsage(report.usage),
      });
      if (result.outcome === "unknown_attempt") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "No such attempt of that session",
        );
      }
      if (result.outcome === "conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "That exchange was reported with other usage",
        );
      }
      return {
        costUsd: result.costUsd,
        pricedBy: result.pricedBy,
        ...(result.ledgerForeignRow ? { ledgerForeignRow: true } : {}),
      };
    },

    async nextInput(
      principal: WorkerPrincipal,
      request: NextInputRequest,
    ): Promise<NextInputResponse> {
      const fence = requireScope(principal, request);
      const deadline =
        now().getTime() + Math.min(request.wait_ms ?? 0, maxWaitMs);
      for (;;) {
        const result = await work.nextInputAtomic({
          fence,
          now: now(),
          costLimitUsd: deps.options.sessionCostLimitUsd,
          tokenLimit,
        });
        if (result.outcome !== "ok") rejected(result);
        // A draining attempt is never handed new input, and neither is a
        // session over budget, so waiting out the poll would only hold up
        // the shutdown.
        if (
          result.input ||
          result.draining === true ||
          result.blocked !== undefined ||
          deps.options.stopWaiting?.aborted === true ||
          now().getTime() >= deadline
        ) {
          const coAuthor = result.input
            ? await turnCoAuthor(fence.sessionId, result.input.actorId)
            : undefined;
          const contentMode = deps.telemetry?.contentMode();
          return {
            input: result.input
              ? {
                  turn_id: result.input.turnId,
                  input_id: result.input.inputId,
                  message: result.input.message,
                  delivery_started_at:
                    result.input.deliveryStartedAt.toISOString(),
                  ...(coAuthor === undefined ? {} : { co_author: coAuthor }),
                  ...(result.input.traceContext === null
                    ? {}
                    : { trace_context: result.input.traceContext }),
                  ...(contentMode === undefined
                    ? {}
                    : { content_mode: contentMode }),
                }
              : null,
            lease_expires_at: result.leaseExpiresAt.toISOString(),
            ...(result.blocked !== undefined
              ? { draining: true, reason: result.blocked }
              : result.draining === true
                ? { draining: true }
                : {}),
          };
        }
        // Never sleep past the deadline the caller asked for: a one
        // millisecond wait must not cost a whole poll interval.
        await sleep(Math.min(pollIntervalMs, deadline - now().getTime()));
      }
    },

    async heartbeat(
      principal: WorkerPrincipal,
      request: HeartbeatRequest,
    ): Promise<HeartbeatResponse> {
      const fence = requireScope(principal, request);
      if (!HEARTBEAT_STATES.has(request.attempt_state)) {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          `attempt_state ${request.attempt_state} cannot be reported by a heartbeat`,
        );
      }
      const at = now();
      const result = await work.heartbeatAtomic({
        credentialTtlMs: sessionTokenTtlMs,
        fence,
        now: at,
        leaseTtlMs,
        attemptState: request.attempt_state,
        ...(request.transcript === undefined
          ? {}
          : {
              transcript: {
                persistedAt:
                  request.transcript.persisted_at === null
                    ? null
                    : new Date(request.transcript.persisted_at),
                mirrorError: request.transcript.mirror_error,
              },
            }),
      });
      if (result.outcome !== "ok") rejected(result);
      return {
        lease_expires_at: result.leaseExpiresAt.toISOString(),
        lease_remaining_ms: result.leaseRemainingMs,
        // A hint, read after the fenced write: the worker's pendingControl
        // poll is what actually hands anything over. A failed read must not
        // turn the lease already renewed into an error the worker reads as
        // lost; the next beat reads it again.
        control_pending:
          ((await pending?.hasUndelivered(fence).catch(() => false)) ??
            false) ||
          (await attachmentsWaiting(fence.sessionId)),
      };
    },

    async appendEvents(
      principal: WorkerPrincipal,
      request: AppendEventsRequest,
    ): Promise<AppendEventsResponse> {
      const fence = requireScope(principal, request);
      const runtimeKind =
        principal.kind === "session"
          ? ((principal.runtimeKind ?? null) as RuntimeKind | null)
          : null;
      const reported = request.tool_decisions ?? [];
      const toolAudits = reported.flatMap((report) =>
        report === null ? [] : [sanitizeToolDecision(report)],
      );
      const result = await work.commitEventsAtomic({
        fence,
        turnId: request.turn_id,
        now: now(),
        events: request.events,
        ...(toolAudits.length === 0 ? {} : { toolAudits }),
        ...(neutralize === undefined
          ? {}
          : {
              neutral: (event: WorkerEvent) =>
                neutralFieldsOf(neutralize, runtimeKind, event),
            }),
      });
      if (result.outcome === "turn_not_found") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "Unknown turn_id, or the turn is not running on this attempt",
        );
      }
      if (result.outcome === "turn_finalized") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Turn is already finalized; its event stream is closed",
        );
      }
      if (result.outcome === "sequence_gap") {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          `Events must continue the durable prefix; resume from source_sequence ${result.acceptedThrough + 1}`,
        );
      }
      if (result.outcome === "event_conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "A source_sequence was already stored with different content",
        );
      }
      if (result.outcome !== "ok") rejected(result);
      const dropped = reported.length - toolAudits.length;
      const audit = result.toolAudit;
      if (
        dropped > 0 ||
        (audit !== undefined && (audit.conflicts > 0 || audit.unverified > 0))
      ) {
        deps.onToolAudit?.({
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
          dropped,
          conflicts: audit?.conflicts ?? 0,
          unverified: audit?.unverified ?? 0,
        });
      }
      return {
        accepted_through: result.acceptedThrough,
        cursor: result.cursor,
      };
    },

    async registerPending(
      principal: WorkerPrincipal,
      request: RegisterPendingRequest,
    ): Promise<RegisterPendingResponse> {
      const fence = requireScope(principal, request);
      const checkpoint =
        request.checkpoint === undefined
          ? undefined
          : await approvalCheckpointOf(
              fence,
              request.turn_id,
              request.checkpoint,
            );
      const result = await requirePending().registerAtomic({
        fence,
        turnId: request.turn_id,
        requestId: request.request_id,
        inputHash: request.input_hash,
        request: request.request,
        ...(request.announce === undefined
          ? {}
          : { announce: request.announce }),
        ttlMs: pendingTtlMs,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(request.checkpoint_failure === undefined
          ? {}
          : { checkpointFailure: request.checkpoint_failure }),
      });
      if (result.outcome === "turn_not_found") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "Unknown turn_id, or the turn is not running on this attempt",
        );
      }
      if (result.outcome === "conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "request_id is already registered for a different or settled request",
        );
      }
      if (result.outcome === "turn_interrupted") {
        throw new WorkerGatewayError(
          409,
          "REQUEST_STALE",
          "The turn is being interrupted and takes no new requests",
        );
      }
      if (!("expiresAt" in result)) return rejected(result);
      return {
        request_id: request.request_id,
        expires_at: result.expiresAt.toISOString(),
        expires_in_ms: result.expiresInMs,
      };
    },

    async pendingControl(
      principal: WorkerPrincipal,
      request: PendingControlRequest,
    ): Promise<PendingControlResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().pendingControlAtomic({
        fence,
        answersAfter: request.answers_after,
        settled: request.settled ?? [],
        ...(request.delivered === undefined
          ? {}
          : { delivered: request.delivered }),
      });
      if (result.outcome !== "ok") return rejected(result);
      if (request.attached !== undefined) {
        await deps.attachments?.settle(fence.sessionId, request.attached);
      }
      const attachments = await attachOrders(fence.sessionId);
      return {
        ...(attachments === undefined ? {} : { attachments }),
        control:
          result.control === null
            ? null
            : {
                control_id: result.control.controlId,
                kind: result.control.kind,
                target_turn_id: result.control.turnId,
                issued_at: result.control.issuedAt.toISOString(),
              },
        answers: result.answers.map((item) => ({
          sequence: item.sequence,
          answer: withoutUnparsedRemember(item.answer, request.capabilities),
          input_hash: item.inputHash,
          // An image that did not announce `answer_surface` has a strict
          // schema that refuses the field along with the whole poll.
          ...(item.answerSurface == null ||
          request.capabilities?.answer_surface !== true
            ? {}
            : { answer_surface: item.answerSurface }),
        })),
      };
    },

    async invalidateApprovalCheckpoint(
      principal: WorkerPrincipal,
      request: InvalidateApprovalCheckpointRequest,
    ): Promise<InvalidateApprovalCheckpointResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().invalidateApprovalCheckpointAtomic({
        fence,
        manifestRef: request.manifest_ref,
      });
      if (result.outcome !== "ok") return rejected(result);
      return { invalidated: result.invalidated };
    },

    async parkDeclined(
      principal: WorkerPrincipal,
      request: ParkDeclinedRequest,
    ): Promise<ParkDeclinedResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().parkDeclinedAtomic({
        fence,
        pauseControlId: request.pause_control_id,
        reason: request.reason,
      });
      if (result.outcome !== "ok") return rejected(result);
      return { reverted: result.reverted };
    },

    async requestPark(
      principal: WorkerPrincipal,
      request: RequestParkRequest,
    ): Promise<RequestParkResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().requestParkAtomic({
        fence,
        turnId: request.turn_id,
      });
      switch (result.outcome) {
        case "ok":
          return { pause_control_id: result.pauseControlId };
        case "not_found":
          throw new WorkerGatewayError(
            404,
            "NOT_FOUND",
            "Unknown turn_id, or the turn is not running on this attempt",
          );
        case "refused":
          throw new WorkerGatewayError(
            409,
            "REQUEST_STALE",
            `The turn cannot be parked: ${result.reason}`,
          );
        default:
          return rejected(result);
      }
    },

    async finalize(
      principal: WorkerPrincipal,
      request: FinalizeRequest,
    ): Promise<FinalizeResponse> {
      const fence = requireScope(principal, request);
      const attempt = {
        fence,
        now: now(),
        turnId: request.turn_id,
        finalizeKey: request.finalize_key,
        finalSourceSequence: request.final_source_sequence,
        terminal: request.terminal,
        checkpoint: request.checkpoint,
        costLimitUsd: deps.options.sessionCostLimitUsd,
        tokenLimit,
      };
      // A finalize that already committed is answered from the stored turn.
      // Re-verifying its checkpoint could fail for a reason that has nothing
      // to do with this turn, and the worker has no other way to learn a
      // result that is already durable.
      const settled = await work.peekFinalizeAtomic(attempt);
      if (settled.outcome !== "open") return finalizeAnswer(settled);
      let checkpointVersionsHeld = false;
      let checkpointTranscriptBytes: number | undefined;
      let checkpointOutputs: readonly CheckpointOutputObject[] | undefined;
      let checkpointOutputsDigest: string | null | undefined;
      let checkpointRuntime: RuntimeFingerprint | undefined;
      if (request.checkpoint) {
        const checkpoint = request.checkpoint;
        const verdict = await checkpointInfrastructure(() =>
          checkpoints.verify({
            fence,
            turnId: request.turn_id,
            checkpoint,
            at: attempt.now,
          }),
        );
        if (verdict.status === "rejected") {
          // A transcript past the limits is where the engine session stands,
          // not a fault of this upload: recorded before the refusal, so the
          // session takes no new turn whatever the worker reports next.
          if (verdict.limit !== undefined) {
            const state = await work.checkpointStateAtomic({
              fence,
              now: now(),
              pendingReason: verdict.limit,
            });
            if (state.outcome !== "ok") rejected(state);
          }
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `Checkpoint manifest rejected: ${verdict.reason}`,
          );
        }
        checkpointVersionsHeld = verdict.versionsHeld === true;
        checkpointTranscriptBytes = verdict.transcriptBytes;
        checkpointOutputs = verdict.outputs;
        checkpointOutputsDigest = verdict.outputsDigest;
        checkpointRuntime = verdict.runtime;
      }
      // Verification is a network call that can outlast the lease, so the
      // fence is judged against the clock at commit time, not the one this
      // request started with.
      const finalized = await work.finalizeAtomic({
        ...attempt,
        checkpointVersionsHeld,
        ...(checkpointTranscriptBytes === undefined
          ? {}
          : { checkpointTranscriptBytes }),
        ...(checkpointOutputs === undefined ? {} : { checkpointOutputs }),
        ...(checkpointOutputsDigest === undefined
          ? {}
          : { checkpointOutputsDigest }),
        ...(checkpointRuntime === undefined ? {} : { checkpointRuntime }),
        now: now(),
      });
      // Not awaited: naming the session must never hold up its turn.
      if (
        deps.titles !== undefined &&
        finalized.outcome === "finalized" &&
        finalized.result.status === "completed" &&
        request.turn_id === FIRST_TURN_ID
      ) {
        void deps.titles.titler.afterFirstTurn({
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        });
      }
      return finalizeAnswer(finalized);
    },

    // Where the next checkpoint goes. The fenced read comes first: a stale
    // attempt gets STALE_EPOCH here rather than a key it would upload to for
    // nothing, and the runtime's durable refusal is recorded before the
    // answer says "blocked", so a crash in between cannot lose it.
    async requestCheckpoint(
      principal: WorkerPrincipal,
      request: CheckpointRequest,
    ): Promise<CheckpointRequestResponse> {
      const fence = requireScope(principal, request);
      const service = requireProtocol();
      const durable =
        request.preparation.status === "rejected"
          ? checkpointPendingReason(request.preparation)
          : null;
      const state = await work.checkpointStateAtomic({
        fence,
        now: now(),
        ...(durable === null ? {} : { pendingReason: durable }),
      });
      if (state.outcome !== "ok") rejected(state);
      if (request.preparation.status === "rejected") {
        return {
          status: "blocked",
          reason: request.preparation.reason,
          detail: request.preparation.detail,
        };
      }
      // Built from the pointer the fenced transaction read, so the answer
      // and the fence come from one snapshot. The revision it names is the
      // only one finalize will accept next; a pointer that moves in between
      // (another finalize of this attempt) makes the upload a 409 there.
      const preparation = request.preparation;
      const decision = await checkpointInfrastructure(() =>
        service.requestCheckpoint({
          attemptId: fence.attemptId,
          preparation,
          sessionId: fence.sessionId,
          pointer: state.pointer,
        }),
      );
      if (decision.status === "blocked") {
        return {
          status: "blocked",
          reason: decision.reason,
          detail: decision.detail,
        };
      }
      return {
        status: "ready",
        revision: decision.request.revision,
        manifest_ref: decision.request.manifestRef,
      };
    },

    // What the worker's attribution repair must not remake (decision 5, the
    // repair tool). Fenced like a checkpoint request: a worker that no longer
    // owns the session learns that, not the commits.
    async protectedCommits(
      principal: WorkerPrincipal,
      request: ProtectedCommitsRequest,
    ): Promise<ProtectedCommitsResponse> {
      const fence = requireScope(principal, request);
      const service = requireProtocol();
      const protect = service.protectedCommits?.bind(service);
      if (protect === undefined) {
        throw new WorkerGatewayError(
          409,
          "CHECKPOINT_UNAVAILABLE",
          "This control plane cannot list the commits a checkpoint protects",
        );
      }
      const state = await work.checkpointStateAtomic({ fence, now: now() });
      if (state.outcome !== "ok") rejected(state);
      const commits = await checkpointInfrastructure(() =>
        protect({
          sessionId: fence.sessionId,
          pointer: state.pointer,
        }),
      );
      return { commits };
    },

    // The committed checkpoint as a download list, or the reason there is
    // none the worker may resume from. Fenced like every post-claim call: a
    // worker that no longer owns the session learns that, not the plan.
    async restorePlan(
      principal: WorkerPrincipal,
      request: RestorePlanRequest,
    ): Promise<RestorePlanResponse> {
      const fence = requireScope(principal, request);
      const service = requireProtocol();
      const state = await work.checkpointStateAtomic({ fence, now: now() });
      if (state.outcome !== "ok") rejected(state);
      const result = await checkpointInfrastructure(() =>
        service.getRestorePlan({
          runtime: {
            cliVersion: request.runtime.cli_version,
            engine: request.runtime.engine,
            profileSha256: request.runtime.profile_sha256,
            sdkVersion: request.runtime.sdk_version,
          },
          ...(request.alternate_profile_sha256s === undefined
            ? {}
            : { alternateProfileSha256s: request.alternate_profile_sha256s }),
          sessionId: fence.sessionId,
          // A pointer the claim did not hand out is not one to restore: a
          // retired one belongs to the engine session start_fresh gave up.
          pointer: state.restorable ? state.pointer : null,
        }),
      );
      // A refusal is the end of a resume from `paused` that stands on this
      // pointer; the session is handed to an operator in its own fenced
      // transaction, rechecked there. Any other session is left alone.
      const refusal =
        result.status === "ready"
          ? null
          : result.status === "none"
            ? "no committed checkpoint to restore"
            : result.status === "unavailable"
              ? result.reason
              : `the checkpoint is incompatible with this worker: ${result.mismatches
                  .map((m) => `${m.field} ${m.expected} != ${m.found}`)
                  .join(", ")}`;
      if (refusal !== null) {
        const failed = await work.failResumeAtomic({
          fence,
          now: now(),
          pointerRevision: state.pointer?.revision ?? null,
          error: {
            code: "CHECKPOINT_UNAVAILABLE",
            message: `the resume could not restore its checkpoint: ${refusal}`,
          },
        });
        if (failed.outcome !== "ok") rejected(failed);
        return restorePlanOnWire(result);
      }
      if (result.status !== "ready") return restorePlanOnWire(result);
      // A ready plan exists only with a pointer: "none" answered above.
      const pointerRevision =
        state.pointer?.revision ??
        result.plan.fallback?.pointerRevision ??
        result.plan.revision;
      const fallback = result.plan.fallback;
      if (fallback !== undefined) {
        // A resume from `paused` promised the pointer's state; an older one
        // is not that resume, so the owner decides (with).
        // A session that is not resuming takes the fallback as before.
        const failed = await work.failResumeAtomic({
          fence,
          now: now(),
          pointerRevision,
          error: {
            code: "CHECKPOINT_UNAVAILABLE",
            message: `the resume could not restore its checkpoint: revision ${pointerRevision} is damaged and only revision ${result.plan.revision} verifies`,
          },
        });
        if (failed.outcome !== "ok") rejected(failed);
        else if (failed.failed) {
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `Revision ${pointerRevision} is damaged; the resume it was to restore is handed to an operator rather than resumed from revision ${result.plan.revision}`,
          );
        }
      }
      const recorded = await work.recordRestoreBaseAtomic({
        fence,
        now: now(),
        pointerRevision,
        fallback:
          fallback === undefined
            ? null
            : { revision: result.plan.revision, skipped: fallback.skipped },
      });
      switch (recorded.outcome) {
        case "ok":
          return restorePlanOnWire(result);
        case "pointer_moved":
          throw new WorkerGatewayError(
            409,
            "REVISION_CONFLICT",
            `The checkpoint pointer moved to ${recorded.currentRevision ?? "none"} while the plan was judged; ask for the plan again`,
          );
        case "base_changed":
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `This attempt was already handed revision ${recorded.recordedRevision} to restore; a new attempt must start over`,
          );
        default:
          return rejected(recorded);
      }
    },

    async release(
      principal: WorkerPrincipal,
      request: ReleaseRequest,
    ): Promise<ReleaseResponse> {
      const fence = requireScope(principal, request);
      const result = await work.releaseAtomic({
        fence,
        now: now(),
        reason: request.reason,
        ...(request.pause_control_id === undefined
          ? {}
          : { pauseControlId: request.pause_control_id }),
        ...(request.stop_kind === "drain" ? { drained: true } : {}),
      });
      if ("refused" in result) {
        switch (result.refused) {
          case "pause_stale":
            throw new WorkerGatewayError(
              409,
              "REQUEST_STALE",
              "The pause this release answers is no longer the session's open one",
            );
          case "pause_blocked":
            throw new WorkerGatewayError(
              409,
              "CHECKPOINT_UNAVAILABLE",
              `The pause cannot commit yet (${result.reason}); keep the lease`,
            );
          default:
            return rejected({ outcome: "lease_expired" });
        }
      }
      return { released: result.released };
    },

    async ready(
      principal: WorkerPrincipal,
      request: WorkerReadyRequest,
    ): Promise<WorkerReadyResponse> {
      const fence = requireScope(principal, request);
      const result = await work.readyAtomic({
        fence,
        now: now(),
        restoredRevision: request.restored_revision,
      });
      if (result.outcome === "restore_mismatch") {
        throw new WorkerGatewayError(
          409,
          "CHECKPOINT_UNAVAILABLE",
          "The session was not resumed onto the checkpoint this worker restored; the resume failed",
        );
      }
      if (result.outcome !== "ok") rejected(result);
      return { activated: result.activated };
    },
  };
}

export type WorkerGateway = ReturnType<typeof createWorkerGateway>;
