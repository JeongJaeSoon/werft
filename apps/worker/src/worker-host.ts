import { createHash } from "node:crypto";
import type {
  AdditionalWorkspaceRepository,
  AttemptState,
  BootstrapClaimResponse,
  CheckpointRef,
  ClaimPrincipal,
  ControlIntent,
  NextInputResponse,
  PermissionGrant,
  ReleaseRequest,
  RepositoryAttachOrder,
  RepositoryAttachResult,
  RuntimeConfig,
  SessionRuntime,
  TerminalTurnStatus,
  TranscriptReport,
  WorkerScope,
  WorkspaceDescriptor,
} from "@werft-ai/contracts";
import {
  DEFAULT_WORKSPACE_ENFORCE,
  MAX_TURN_COST_USD,
  TURN_BUDGET_EXCEEDED_REASON,
  TURN_INPUT_WAIT_PARKED_REASON,
  TURN_WORKSPACE_QUOTA_EXCEEDED_REASON,
} from "@werft-ai/contracts";
import {
  type AdmissionHold,
  type AgentRun,
  type AnswerResult,
  type ApprovalDecisionPayload,
  type ApprovalRequested,
  type CheckpointLease,
  type CheckpointPreparation,
  type GitEnvironment,
  type ImageRuntime,
  isOwnershipLost,
  isRetryable,
  type ParkedApproval,
  type ParkReadiness,
  type RuntimeEvent,
  runtimeRequirementsOf,
  type ToolDecisionObserver,
  type TurnEnded,
  unmetFeatures,
  type WorkerCheckpointState,
  type WorkerGatewayClient,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";

import { noteTurnCoAuthor } from "./attribution-repair.ts";
import { WORKER_CAPABILITIES } from "./capabilities.ts";
import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import { LEASE_SAFETY_MARGIN_MS, type WorkerTimeouts } from "./config.ts";
import { createConsoleLogger, type WorkerLogger } from "./console-logger.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { EventPublisher } from "./event-publisher.ts";
import { Heartbeat } from "./heartbeat.ts";
import { messageOf as describe } from "./message-of.ts";
import {
  type ApprovalCheckpointer,
  PendingRequestRegistry,
} from "./pending-requests.ts";
import { goPrivateModules } from "./repository-routes.ts";
import {
  claimSecrets,
  SecretScrubber,
  scrubbingGateway,
  scrubbingLogger,
} from "./secret-scrubber.ts";
import {
  protectSession,
  type TelemetryFactory,
  type TelemetrySession,
} from "./telemetry/session.ts";
import {
  type CheckpointSpan,
  NO_TURN_SPANS,
  type TurnSpans,
} from "./telemetry/turn-spans.ts";
import { ToolAuditCollector } from "./tool-audit.ts";
import { settledWithin, until } from "./waits.ts";
import { AttachLimitError, type WorkspacePreparer } from "./workspace.ts";
import type { WorkspaceObserver } from "./workspace-observer.ts";
import {
  WorkspaceQuota,
  type WorkspaceQuotaLimits,
} from "./workspace-quota.ts";

/** Where the claim's object store token goes. */
export type ObjectStoreAccess = { useToken(token: string): void };

/** The gateway client plus the one thing a claim changes about it. */
export interface WorkerGatewaySession extends WorkerGatewayClient {
  /** Swaps the launch nonce for the credential bootstrapClaim issued. */
  useCredential(credential: string): void;
  useTraceparent?(current: () => string | undefined): void;
}

/**
 * `runtimeConfig` is the claim's: the server resolved it from the session's
 * spec. `principal` is the claim's too — the session's owner partition,
 * which the runtime hashes into every checkpoint fingerprint. It
 * is never defaulted here: a worker that made one up would let two
 * partitions on one provider resume each other's checkpoints.
 */
export type RuntimeLaunch = RuntimeResumePlan & {
  /** The workspace's, read only when the run config lets the file in. */
  committedInstructions: () => string | null;
  correlationId: string;
  /** The claim's git settings for the engine (git-trailers.ts gitEnvironmentFor). */
  gitEnvironment?: GitEnvironment;
  /**
   * The claim's remaining_budget_usd: this run counts its spend from zero.
   * Absent for a session that is not billed, whose engine runs with no budget.
   */
  maxBudgetUsd?: number;
  principal: ClaimPrincipal;
  runtimeConfig: RuntimeConfig;
  toolDecisions?: ToolDecisionObserver;
  /** The claim's; absent is a session with a repository. */
  workspace?: WorkspaceDescriptor;
};

export type RuntimeLauncher = {
  start(launch: RuntimeLaunch): AgentRun;
};

export interface RuntimeRegistry {
  /** Throws when this worker cannot run what the session was created with. */
  launcherFor(runtime: SessionRuntime): RuntimeLauncher;
}

export type { WorkerLogger };

/** A worker never cancels a turn; cancellation is the control plane's call. */
export type WorkerTerminalStatus = Exclude<TerminalTurnStatus, "cancelled">;

export type TurnOutcome = {
  turnId: string;
  status: WorkerTerminalStatus;
  reason: string | null;
};

export type WorkerRunSummary = {
  outcome:
    | "unclaimed"
    | "idle"
    | "drained"
    | "paused"
    | "lease_lost"
    | "failed";
  reason: string;
  turns: TurnOutcome[];
};

export type WorkerHostOptions = {
  checkpoints: WorkerCheckpointPort;
  execution: { bootstrapNonce: string; generation: number; id: string };
  gateway: WorkerGatewaySession;
  runtimes: RuntimeRegistry;
  timeouts: WorkerTimeouts;
  workspace: WorkspacePreparer;
  workspaceQuota?: {
    observer: Pick<
      WorkspaceObserver,
      "measureNow" | "watch" | "nudge" | "onClassified"
    >;
    limits: WorkspaceQuotaLimits;
  };
  logger?: WorkerLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Absent for engines that spawn no process, like the fake. */
  engines?: EngineExitWatch;
  /** Absent when the checkpoint port is a fake that needs no token. */
  objectStoreAccess?: ObjectStoreAccess;
  /**
   * More values for the `SecretScrubber` to keep out of events and logs, on
   * top of the nonce and what the claim brings. The composition root passes
   * none; for tests.
   */
  secrets?: readonly string[];
  /** Overrides APPROVAL_CHECKPOINT_MS; for tests. */
  approvalCheckpointMs?: number;
  telemetry?: TelemetryFactory;
  /** Hands the claim's commit author and trailers to the image's git config and hook. */
  gitTrailers?: (claim: BootstrapClaimResponse) => Promise<void>;
  /**
   * Leaves the platform's instructions in the workspace once it is ready,
   * before the engine starts; the answer is what happened, for the log.
   */
  placeInstructions?: (
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * Publishes the claim's extension bundles read-only under the image's HOME
   * before the engine starts. Required whenever a claim carries any; a throw
   * fails the start.
   */
  extensionBundles?: (
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /** The git settings the claim's engine runs every git under. */
  gitEnvironment?: (
    claim: BootstrapClaimResponse,
  ) => GitEnvironment | undefined;
  /**
   * Sends the engine's own fetches of the session's repositories through
   * their route; true when routes were written.
   */
  repositoryRoutes?: (workspace: WorkspaceDescriptor) => Promise<boolean>;
  /** Points the engine's package managers at the claim's packages route. */
  packageManagers?: (
    token: string | undefined,
    github?: { npm: string[]; rubygems: string[] },
    /** Go module paths fetched through the repository route (`GOPRIVATE`). */
    privateModules?: readonly string[],
  ) => Promise<void>;
  /** What this image runs, sent with the claim so a misconfigured image is refused. */
  imageRuntime?: ImageRuntime;
};

/**
 * `failed` winds down like a drain; only the reported outcome differs.
 * `paused` comes after the release that committed a pause, so the shutdown
 * that follows has nothing left to release.
 */
type Stop = {
  kind: "drain" | "failed" | "idle" | "lost" | "paused";
  reason: string;
  /**
   * A drain asked of this process from outside (`drain`), unlike the ones
   * it decides itself: a mirror error can end a startup as surely as a
   * failure does.
   */
  requested?: true;
};

type Settlement = {
  /** What the engine says the turn cost; absent when it said nothing. */
  costUsd?: number;
  reason: string | null;
  result: unknown;
  status: WorkerTerminalStatus;
  /**
   * Decided here rather than reported by the engine: there is no engine
   * terminal a checkpoint could be consistent with, so none is taken.
   */
  synthetic?: true;
  usage: unknown;
};

type Turn = {
  /** Past its terminal: what the engine emits now belongs to no turn. */
  closed: boolean;
  /** Its settlement is decided and its stream cut; later ones are ignored. */
  cut: boolean;
  /**
   * A frame named this turn's input: before one does, what the engine
   * emits may still be the previous turn's and belongs to no turn.
   */
  entered: boolean;
  /** An interrupt intent for this turn has been taken. */
  interrupting: boolean;
  /** The intent that interrupted the turn, named by its engine_stopped event. */
  controlId?: string;
  /**
   * How the engine answered the interrupt sent for this turn, if one was.
   * The SDK ends every abort alike, so only an acknowledged interrupt makes
   * an aborted terminal an interrupted turn.
   */
  interruptReceipt?: "pending" | "acknowledged" | "refused";
  /** Settles once interruptReceipt is no longer pending. */
  interruptAnswered?: Promise<void>;
  /**
   * When the interrupt's grace runs out (performance.now()): it bounds the
   * whole way to the engine's terminal, not each step. The checkpoint capture
   * after it has a budget of its own.
   */
  interruptDeadline?: number;
  /** Monotonic origin for every stage of this interrupt's diagnostic timeline. */
  interruptStartedAt?: number;
  /**
   * The turn is being cut where it waits on a person: what it waited on,
   * kept for the checkpoint, and the park control that asked, if one did.
   */
  parking?: { approvals: ParkedApproval[]; controlId?: string };
  /** The input went to the engine: an interrupt can only reach it from here. */
  sent: boolean;
  settled: Promise<Settlement>;
  settle: (settlement: Settlement | Promise<Settlement>) => void;
  /** The deadline fired: whatever terminal comes now is the timeout's. */
  timedOut: boolean;
  quotaExceeded?: boolean;
  timers: ReturnType<typeof setTimeout>[];
  turnId: string;
  uuid: string;
  spans: TurnSpans;
};

/** A run without `parkable` cannot be cut where it waits on a person. */
function parkReadinessOf(run: AgentRun): ParkReadiness {
  return run.parkable?.() ?? { ok: false, reason: "not_supported" };
}

const TELEMETRY_SHUTDOWN_MS = 1_500;
const CLAIM_RETRY_MS = 1_000;
const GATEWAY_RETRY_MS = 500;

/** What is left of a lease, counted from when the request it answered went out. */
type ClaimedLease = { remainingMs: number; sentAt: number };
const CHECKPOINT_PROCESS_GRACE_MS = 1_000;
const CHECKPOINT_PROCESS_POLL_MS = 20;
/** How long an interrupted engine gets to produce its terminal frame. */
const INTERRUPT_GRACE_MS = 5_000;
/**
 * How long an interrupted turn's capture gets once the engine has stopped.
 * With the grace before it and finalize after it, the turn settles well
 * before the reconciler fences an interrupt still unsettled at 60s.
 */
const INTERRUPT_CAPTURE_MS = 30_000;
/** How long a closed engine gets to exit, and a killed one after that. */
const ENGINE_EXIT_GRACE_MS = 5_000;
/** Kept back from the stop grace for the release call. */
const RELEASE_RESERVE_MS = 2_000;
/** The default for `timeouts.toolUseFrameWaitMs`. */
const TOOL_USE_FRAME_WAIT_MS = 10_000;
/**
 * The most a park keeps of what its turn waited on: it rides in the
 * manifest, whose own limit is far above it.
 */
const PARKED_STATE_MAX_BYTES = 1024 * 1024;
const NOTHING_WAITING = "The turn is no longer waiting on a person alone";
/**
 * The most an approval-wait checkpoint may take, lease to upload (design
 * §6.3). Past it the request is registered without one, and a crash leaves
 * the turn unknown as before.
 */
const APPROVAL_CHECKPOINT_MS = 10_000;

/**
 * The worker process: one session, one attempt, however many turns the lease
 * lasts for.
 *
 * `runLoop` claims a session, opens one engine run and feeds it inputs one at
 * a time — turns for a session are serial, so there is at most one outstanding
 * input and a single frame pump can attribute every terminal to the turn that
 * is waiting for it. Ownership is the other axis: the heartbeat runs on its
 * own clock, and the moment it says this attempt no longer owns the session
 * the loop stops writing anything at all.
 */
export class WorkerHost {
  private readonly options: WorkerHostOptions;
  private readonly logger: WorkerLogger;
  private readonly turns: TurnOutcome[] = [];
  private readonly checkpoints: WorkerCheckpointPort;
  private engine: AgentRun | undefined;
  /**
   * The engine's answer to the last interrupt sent. The next input waits for
   * it: an interrupt still in flight when a turn ends on its own would
   * otherwise land on the one after.
   */
  private interruptAnswered: Promise<void> | undefined;
  private attemptState: AttemptState = "starting";
  private heartbeat: Heartbeat | undefined;
  private mirrorError: string | undefined;
  private engineBudgeted = false;
  private workspaceEnforce: "warn" | "fail" | "off" = DEFAULT_WORKSPACE_ENFORCE;
  private pending: PendingRequestRegistry | undefined;
  /**
   * Approval-wait checkpoints of the current turn that may be committed and
   * are not yet void, and the admission hold that voids them before any
   * tool starts.
   */
  private approvalCheckpoints: string[] = [];
  private admissionHold: AdmissionHold | undefined;
  private publisher: EventPublisher | undefined;
  private pumping: Promise<void> | undefined;
  /** The restore in flight or done, settled either way; see `shutdown`. */
  private restoring: Promise<void> | undefined;
  private scopeValue: WorkerScope | undefined;
  private claimValue: BootstrapClaimResponse | undefined;
  private turnCoAuthorWritten = false;
  private checkpointRevision: number | null = null;
  private scrubber: SecretScrubber;
  private tracing: TelemetrySession | undefined;
  private stopping: Stop | undefined;
  /** Resolves when the current turn has to be given up unfinished. */
  private readonly abandoned: Promise<void>;
  private announceAbandon: () => void = () => {};
  private abandonedNow = false;
  /** When the drain under way gives the turn up, on the monotonic clock its timer runs on. */
  private abandonsAt: number | undefined;
  /** Aborted by any stop: a clone in progress is not worth finishing. */
  private readonly preparation = new AbortController();
  // Attachments run one at a time, and only once the workspace is prepared
  // and restored: an order can come with the first heartbeat, before
  // `startUp` has a `.git` to add a remote to. `attaching` keeps a repeated
  // order from queueing the same fetch twice.
  private startAttachments: () => void = () => {};
  private attachQueue = new Promise<void>((resolve) => {
    this.startAttachments = resolve;
  });
  private readonly attaching = new Set<string>();
  private stoppedAt: number | undefined;
  private readonly stopped: Promise<void>;
  private announceStop: () => void = () => {};
  private released = false;
  /**
   * The pause this attempt was asked for (its control id). Not a stop: the
   * turn in flight runs on with its questions and approvals, and only the
   * release that commits the pause ends the loop.
   */
  private pauseControl: string | undefined;
  /**
   * The pause whose release may have committed unseen: one is out, or one
   * went unanswered and nothing has said since whether it landed.
   */
  private pauseReleasing: string | undefined;
  private turn: Turn | undefined;
  /** The claim's: allows the turn this attempt resumes may spend once each. */
  private grants: PermissionGrant[] = [];
  /** Park controls already carried out or declined; polls repeat them. */
  private readonly parksTaken = new Set<string>();
  /**
   * What the engine reported spending on turns that settled nothing, waiting
   * for the next turn that settles with a cost of its own.
   */
  private unsettledUsd = 0;

  constructor(options: WorkerHostOptions) {
    this.options = options;
    this.checkpoints = options.checkpoints;
    // Until a claim names the rest, the nonce and the host's own secrets.
    this.scrubber = new SecretScrubber([
      options.execution.bootstrapNonce,
      ...(options.secrets ?? []),
    ]);
    this.logger = scrubbingLogger(
      options.logger ?? createConsoleLogger(),
      () => this.scrubber,
    );
    this.abandoned = new Promise<void>((resolve) => {
      this.announceAbandon = () => {
        this.abandonedNow = true;
        resolve();
      };
    });
    this.stopped = new Promise<void>((resolve) => {
      this.announceStop = resolve;
    });
  }

  /** The secrets this process holds so far, for loggers built before it. */
  get secrets(): SecretScrubber {
    return this.scrubber;
  }

  /**
   * Asks the loop to wind down at the next safe point; safe from a signal
   * handler. A turn waiting only on a person is parked rather than held to
   * the drain budget and denied.
   */
  drain(reason: string): void {
    const draining = this.stopping === undefined;
    this.stop({ kind: "drain", reason, requested: true });
    if (draining) void this.drainPark();
  }

  async runLoop(): Promise<WorkerRunSummary> {
    const owned = await this.claimAndActivate();
    if ("outcome" in owned) return owned;
    const { claim, lease } = owned;
    // Attribution, not a boundary: commits without it still go through.
    await this.options.gitTrailers?.(claim).catch((error: unknown) =>
      this.logger.warn("worker.git_trailers.not_written", {
        reason: describe(error),
      }),
    );
    await this.writeEngineRoutes(claim);

    // Everything this process holds that the engine's tools could print.
    this.scrubber = new SecretScrubber([
      ...claimSecrets(claim, this.options.execution.bootstrapNonce),
      ...(this.options.secrets ?? []),
    ]);
    if (claim.telemetry?.enabled === true && this.options.telemetry) {
      const { telemetry } = claim;
      const build = this.options.telemetry;
      this.tracing = protectSession(() =>
        build({
          telemetry,
          claim,
          execution: {
            id: this.options.execution.id,
            generation: this.options.execution.generation,
          },
          masker: { mask: (text) => this.scrubber.scrub(text) },
        }),
      );
      if (this.tracing !== undefined) {
        this.options.gateway.useTraceparent?.(() =>
          this.turn?.spans.traceparent(),
        );
      }
    }
    const scrubbed = scrubbingGateway(this.options.gateway, this.scrubber);
    const publisher = new EventPublisher({
      gateway: scrubbed,
      scope: () => this.scope,
      now: this.options.now ?? (() => new Date()),
      retryBudgetMs: this.options.timeouts.nextInputRetryTimeoutMs,
      onAuditsDropped: (count) =>
        this.logger.warn("worker.tool_audit.dropped", { dropped: count }),
      onFailed: (error) => {
        if (isOwnershipLost(error)) {
          this.lose(describe(error), error);
          return;
        }
        // Nothing the engine does from here is recorded, so nothing waiting
        // on a person may be allowed to run.
        this.pending?.cancelAll(
          "refused",
          "The session's events can no longer be stored",
        );
        this.fail(`Events could not be stored: ${describe(error)}`);
      },
    });
    this.publisher = publisher;
    this.options.workspaceQuota?.observer.onClassified((mode) => {
      if (this.ownerLost || this.stopping !== undefined) return;
      publisher.publish(
        [
          {
            id: "workspace-limit-mode",
            event: "system",
            data: {
              type: "system",
              subtype: "workspace_limit_mode",
              ...mode,
            },
          },
        ],
        null,
      );
    });
    this.pending = new PendingRequestRegistry({
      gateway: scrubbed,
      eventsStored: (toolUseId, askedAt) =>
        publisher.toolUseStored(
          toolUseId,
          this.options.timeouts.toolUseFrameWaitMs ?? TOOL_USE_FRAME_WAIT_MS,
          askedAt,
        ),
      scope: () => this.scope,
      timeoutMs: this.options.timeouts.questionTimeoutMs,
      pollIntervalMs: this.options.timeouts.answerPollIntervalMs,
      onOwnershipLost: (error) => this.lose(describe(error), error),
      onControl: (control, poll) => this.onControl(control, poll),
      onAttachments: (orders) => this.onAttachments(claim, orders),
      onDecided: (decided) => this.turn?.spans.decided(decided),
      onSettlementDetailRefused: (error) =>
        this.logger.warn("worker.pending.settlement_detail_refused", {
          reason: error.message,
        }),
    });
    const toolAudit = new ToolAuditCollector({
      scrubber: () => this.scrubber,
      turnId: () => this.scope.turn_id,
      requestIdOf: (localId) => this.pending?.requestIdOf(localId),
      enqueue: (report, turnId) => publisher.audit(report, turnId),
    });
    this.heartbeat = new Heartbeat({
      gateway: this.options.gateway,
      scope: () => this.scope,
      attemptState: () => this.attemptState,
      intervalMs: this.options.timeouts.heartbeatIntervalMs,
      lease,
      safetyMarginMs:
        this.options.timeouts.leaseSafetyMarginMs ?? LEASE_SAFETY_MARGIN_MS,
      onLost: (reason, error) => this.lose(reason, error),
      onControlPending: () => this.pending?.poll(true),
      transcript: () => this.transcriptReport(),
    });

    let run: AgentRun | undefined;
    try {
      const launcher = this.options.runtimes.launcherFor(claim.runtime);
      // From here on: a clone can take longer than the lease the claim gave.
      this.heartbeat.start();
      const startup = this.stageBudget(
        "Starting the session",
        this.options.timeouts.startupTimeoutMs,
      );
      let ready = false;
      try {
        const plan = await this.startUp(claim);
        if (plan !== undefined && this.stopping === undefined) {
          await this.publishExtensions(claim);
        }
        if (plan !== undefined) this.startAttachments();
        if (plan !== undefined && this.stopping === undefined) {
          // A convenience file: the engine's prompt carries the same text.
          // Raced with a stop like the other stages, so slow I/O cannot hold
          // the shutdown back.
          const placing = this.options.placeInstructions;
          if (placing !== undefined) {
            await this.untilStopped(
              placing(claim, this.preparation.signal)
                .then((placement) =>
                  this.logger.info("worker.instruction_files.placed", {
                    placement,
                  }),
                )
                .catch((error: unknown) =>
                  this.logger.warn("worker.instruction_files.not_placed", {
                    reason: describe(error),
                  }),
                ),
            );
          }
        }
        // Again: a stop can land while the files are being placed.
        if (plan !== undefined && this.stopping === undefined) {
          this.engineBudgeted = claim.remaining_budget_usd !== null;
          const gitEnvironment = this.options.gitEnvironment?.(claim);
          const engineStartedAt = Date.now();
          run = launcher.start({
            ...plan,
            committedInstructions:
              plan.mode === "resume" && plan.committedInstructions !== undefined
                ? plan.committedInstructions
                : () => this.options.workspace.committedInstructions(),
            correlationId: `${claim.session_id}:${claim.attempt_id}`,
            ...(gitEnvironment === undefined ? {} : { gitEnvironment }),
            ...(claim.remaining_budget_usd === null
              ? {}
              : { maxBudgetUsd: claim.remaining_budget_usd }),
            principal: claim.principal,
            runtimeConfig: claim.runtime_config,
            toolDecisions: toolAudit,
            workspace: claim.workspace,
          });
          this.engine = run;
          this.attemptState = "running";
          this.pumping = this.pump(run);
          ready = await this.reportReady(run, plan, claim);
          this.tracing?.emitter.noteEngineStart(engineStartedAt, Date.now());
        }
      } finally {
        startup.disarm();
      }
      if (run !== undefined && ready) await this.turnLoop(run);
    } catch (error) {
      // A worker that failed but still owns the session gives it back, so
      // recovery does not have to wait for the lease to lapse. A loss wins
      // over a stop already under way: no durable write may follow it.
      if (isOwnershipLost(error)) this.lose(describe(error), error);
      else this.stop({ kind: "failed", reason: releaseReason(error) });
      this.logger.error("worker.failed", { reason: describe(error) });
      await this.shutdown(run);
      return {
        outcome: this.stopping?.kind === "lost" ? "lease_lost" : "failed",
        reason: describe(error),
        turns: this.turns,
      };
    }
    await this.shutdown(run);
    // Read after the shutdown: the lease can still be lost while it runs.
    const stop = this.stopping ?? { kind: "drain", reason: "loop ended" };
    return {
      outcome:
        stop.kind === "lost"
          ? "lease_lost"
          : stop.kind === "idle"
            ? "idle"
            : stop.kind === "failed"
              ? "failed"
              : stop.kind === "paused"
                ? "paused"
                : "drained",
      reason: stop.reason,
      turns: this.turns,
    };
  }

  /**
   * The claim's extension bundles, in place before the engine starts. Unlike
   * the instruction files this is fatal: a session that pinned a bundle never
   * runs without it, so an error here fails the start and its reason is the
   * release's.
   */
  private async publishExtensions(
    claim: BootstrapClaimResponse,
  ): Promise<void> {
    const bundles = claim.runtime_config.extensions;
    if (bundles === undefined) return;
    if (bundles.length > 0 && !claim.runtime_config.tools.includes("Skill")) {
      throw new Error(
        `This session pins extension bundles (${bundles.map((bundle) => bundle.name).join(", ")}), whose skills the model uses only through the "Skill" tool, and the tools it runs with do not list it. Release the agent with a tool list that has "Skill".`,
      );
    }
    const publish = this.options.extensionBundles;
    if (publish === undefined) {
      throw new Error("This worker cannot publish extension bundles");
    }
    await this.untilStopped(publish(claim, this.preparation.signal));
  }

  /**
   * The engine's git routes and package manager configuration for the
   * claim's repositories, written again whenever one is attached. Each file
   * is staged and renamed into place, so git and go never read half of one.
   */
  private async writeEngineRoutes(
    claim: BootstrapClaimResponse,
  ): Promise<void> {
    // Not a boundary: the gate judges every repository the route is asked
    // for.
    const routed =
      (await this.options
        .repositoryRoutes?.(claim.workspace)
        .catch((error: unknown) => {
          this.logger.warn("worker.repository_routes.not_written", {
            reason: describe(error),
          });
          return false;
        })) ?? false;
    // Nor this: the proxy is. Without it an install fails. A Go module named
    // private with no route to it would go to github.com directly.
    await this.options
      .packageManagers?.(
        claim.packages?.access.token,
        claim.packages?.github,
        routed ? goPrivateModules(claim.workspace) : [],
      )
      .catch((error: unknown) =>
        this.logger.warn("worker.package_managers.not_written", {
          reason: describe(error),
        }),
      );
  }

  /**
   * Fetches the repositories the agent attached mid-session, one at a time
   * (session-repository-attachment.md decision 3), and reports each outcome
   * on the next control poll. One whose fetch a stop cut short is left
   * unreported: it stays pending for the next attempt, whose claim already
   * carries it.
   */
  private onAttachments(
    claim: BootstrapClaimResponse,
    orders: RepositoryAttachOrder[],
  ): void {
    for (const order of orders) {
      if (this.attaching.has(order.id)) continue;
      this.attaching.add(order.id);
      this.attachQueue = this.attachQueue
        .then(() => this.attachOne(claim, order))
        .finally(() => this.attaching.delete(order.id));
    }
  }

  private async attachOne(
    claim: BootstrapClaimResponse,
    order: RepositoryAttachOrder,
  ): Promise<void> {
    const attach = this.options.workspace.attachRepository;
    const { receipt_id, ...entry } = order;
    const repository: AdditionalWorkspaceRepository = {
      ...entry,
      ...(claim.repository_access === undefined
        ? {}
        : { access: claim.repository_access }),
    };
    let result: RepositoryAttachResult;
    try {
      if (attach === undefined) {
        throw new Error("This worker's workspace takes no repository");
      }
      const commit = await attach.call(
        this.options.workspace,
        repository,
        this.preparation.signal,
      );
      result = {
        repository_id: order.id,
        receipt_id,
        status: "attached",
        commit,
      };
      const listed = claim.workspace.additional_repositories ?? [];
      if (!listed.some((entry) => entry.id === order.id)) {
        claim.workspace.additional_repositories = [...listed, repository];
      }
      await this.writeEngineRoutes(claim);
    } catch (error) {
      if (this.preparation.signal.aborted) return;
      result = {
        repository_id: order.id,
        receipt_id,
        status: "failed",
        failure:
          error instanceof AttachLimitError ? error.failure : "fetch_failed",
      };
      this.logger.warn("worker.workspace.attach_failed", {
        repository_id: order.id,
        failure: result.failure,
        reason: describe(error),
      });
    }
    this.logger.info("worker.workspace.repository_attached", {
      repository_id: order.id,
      status: result.status,
    });
    this.pending?.reportAttached(result);
  }

  /**
   * Prepares the workspace and resolves the restore plan, or gives up at the
   * first stop — the startup budget's included. Both are raced with it: a
   * preparation that ignores its abort, or a restore that never answers,
   * would otherwise hold a session the heartbeat keeps leased. Undefined
   * once stopped; whatever either answers after that is not used.
   */
  private async startUp(
    claim: BootstrapClaimResponse,
  ): Promise<RuntimeResumePlan | undefined> {
    const repository = claim.workspace.repository;
    const prepared = await this.untilStopped(
      this.options.workspace
        .prepare({
          descriptor: claim.workspace,
          restore: claim.restore,
          signal: this.preparation.signal,
        })
        .catch((error: unknown) => {
          // A stop aborts the preparation; that is the stop's outcome, not a
          // failure of its own.
          if (this.preparation.signal.aborted) return undefined;
          throw error;
        }),
    );
    if (prepared === undefined || this.stopping !== undefined) return;
    this.logger.info("worker.workspace.prepared", {
      action: prepared,
      repository_id: repository?.id ?? null,
      branch: repository?.branch ?? null,
    });
    const restoring = this.checkpoints
      .restorePlan(claim, this.preparation.signal)
      .catch((error: unknown) => {
        if (this.preparation.signal.aborted) return undefined;
        throw error;
      });
    this.restoring = restoring.then(
      () => {},
      () => {},
    );
    const plan = await this.untilStopped(restoring);
    const extra = claim.workspace.additional_repositories ?? [];
    const attach = this.options.workspace.attachRepositories;
    if (plan === undefined || extra.length === 0 || attach === undefined) {
      return plan;
    }
    // After the restore, which rebuilds the checkout with origin alone.
    const attached = await this.untilStopped(
      attach.call(this.options.workspace, {
        descriptor: claim.workspace,
        signal: this.preparation.signal,
      }),
    );
    if (attached === undefined || this.stopping !== undefined) return;
    this.logger.info("worker.workspace.repositories_attached", {
      attached: attached.attached,
      failed: attached.failed,
    });
    return plan;
  }

  /**
   * Refuses, before any input, a claim whose settings need a feature the
   * started engine does not offer — the control plane checked the release
   * against its own copy of the descriptor, which this image may not match.
   * Then tells the gateway this attempt restored what its claim named and can
   * take input: a session resumed out of `paused` admits none until then
   * . The engine is waited on first — its transcript loaded
   * the engine initialized — so a restore that fails there fails the resume
   * instead of reaching the first turn. The revision reported is the one the
   * restore loaded (the claim's, for a plan resuming this container's disk);
   * a plan that fell back to a fresh engine reports none, which the gateway
   * refuses for a resuming session. A
   * claim with nothing to restore has nothing to prove and sends no report,
   * so a worker ahead of its API still serves new sessions. Inside the
   * startup budget. False once stopped.
   */
  private async reportReady(
    run: AgentRun,
    plan: RuntimeResumePlan,
    claim: BootstrapClaimResponse,
  ): Promise<boolean> {
    const negotiated = await this.untilStopped(run.ready());
    if (negotiated === undefined || this.stopping !== undefined) return false;
    const unmet = unmetFeatures(
      negotiated.effective,
      negotiated.effectiveExtraFeatures,
      runtimeRequirementsOf(claim.runtime_config),
    );
    if (unmet.length > 0) {
      throw new Error(
        `Runtime ${claim.runtime.kind} ${claim.runtime.version} cannot run this session's settings: it does not support ${unmet.join(", ")}`,
      );
    }
    if (claim.restore === null) return true;
    const restored =
      plan.mode === "resume"
        ? (plan.restoredRevision ?? claim.restore.revision)
        : null;
    const answer = await this.untilStopped(
      this.withRetry(() =>
        this.options.gateway.ready({
          ...this.scope,
          restored_revision: restored,
        }),
      ),
    );
    if (answer === undefined || this.stopping !== undefined) return false;
    if (answer.activated) {
      this.logger.info("worker.resume.ready", { restore_revision: restored });
    }
    return true;
  }

  /** Read through getters: the field changes across awaits, which narrowing cannot see. */
  private get ownerLost(): boolean {
    return this.stopping?.kind === "lost";
  }

  private get stopKind(): Stop["kind"] | undefined {
    return this.stopping?.kind;
  }

  private get scope(): WorkerScope {
    if (this.scopeValue === undefined) {
      throw new Error("The worker has no claimed session");
    }
    return this.scopeValue;
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((wait: number) => Bun.sleep(wait)))(ms);
  }

  private stop(stop: Stop): void {
    if (this.stopping !== undefined) return;
    this.stopping = stop;
    this.preparation.abort();
    if (stop.kind !== "lost") {
      this.attemptState = "draining";
      // The launcher's SIGKILL clock starts with its SIGTERM, not a lease loss.
      this.stoppedAt ??= performance.now();
    }
    this.announceStop();
    this.logger.info("worker.stopping", {
      kind: stop.kind,
      reason: stop.reason,
    });
    // Tell the gateway now rather than at the next beat: a draining attempt
    // is handed no further input. A paused one has already released.
    if (stop.kind !== "lost" && stop.kind !== "paused") {
      this.heartbeat?.beatNow();
    }
    if (stop.kind === "lost") {
      this.announceAbandon();
      return;
    }
    // A drain lets the turn in flight finish and be finalized; only once that
    // budget is spent is it given up for the recovery path to retry.
    this.abandonsAt = performance.now() + this.options.timeouts.drainTimeoutMs;
    const timer = setTimeout(
      () => this.announceAbandon(),
      this.options.timeouts.drainTimeoutMs,
    );
    timer.unref?.();
  }

  /**
   * A failure that must show in the outcome even when a drain is already
   * under way: first-wins `stop` would report the session as cleanly drained
   * while events it owed were never stored.
   */
  private fail(reason: string): void {
    if (this.stopping === undefined) {
      this.stop({ kind: "failed", reason });
      return;
    }
    if (this.stopping.kind === "lost" || this.stopping.kind === "failed") {
      return;
    }
    this.stopping = { kind: "failed", reason };
    this.logger.error("worker.failed", { reason });
  }

  private lose(reason: string, error?: unknown): void {
    // A poll still in flight when the session was given back comes home to
    // a fence that is gone; that is the release, not a lease loss.
    if (this.released) return;
    if (this.stopping?.kind === "lost") return;
    // Committing the pause revokes this credential and moves the epoch on,
    // so either refusal while the release is unanswered is most likely that
    // commit, its answer lost: UNAUTHORIZED for a request that
    // came after it, STALE_EPOCH for one that authenticated before it and
    // waited on its fence. A double fault — the binding ended by a terminate
    // as the release went out — is reported paused too; the session's state
    // on the server is the record either way.
    if (this.showsPauseCommit(error)) {
      this.presumePaused(`The release went unanswered and then: ${reason}`);
      return;
    }
    this.stopping = undefined;
    this.stop({ kind: "lost", reason });
    // Owner loss means no further durable writes from this attempt, so the
    // queued tail is dropped rather than retried against someone else's lease.
    this.publisher?.abandon(reason);
    this.pending?.cancelAll(
      "shutdown",
      "This worker no longer owns the session",
    );
    this.pending?.stop();
  }

  private showsPauseCommit(error: unknown): boolean {
    return (
      this.pauseReleasing !== undefined &&
      error instanceof WorkerGatewayRequestError &&
      (error.code === "UNAUTHORIZED" || error.code === "STALE_EPOCH")
    );
  }

  private presumePaused(reason: string): void {
    this.released = true;
    this.logger.warn("worker.pause.committed", {
      control_id: this.pauseReleasing ?? null,
      reason,
    });
    this.stopping = undefined;
    this.stop({ kind: "paused", reason: "Paused; the execution is released" });
  }

  /**
   * The claim, activated: the gateway has accepted one fenced call made with
   * the claim's credential, which moves the attempt out of `allocated`. From
   * then on the launch nonce opens nothing. The nonce stays readable in this
   * container's environ (PID 1 holds it too) by whatever the engine runs, so
   * nothing is written to disk and no child process starts before this
   * returns a claim.
   *
   * A refusal means a duplicate of the claim request landed late and rotated
   * the credential away: while the attempt is unstarted, claiming once more
   * returns the one that works. A second refusal ends the worker.
   */
  private async claimAndActivate(): Promise<
    { claim: BootstrapClaimResponse; lease: ClaimedLease } | WorkerRunSummary
  > {
    for (let reclaimed = false; ; reclaimed = true) {
      let claimed: Awaited<ReturnType<WorkerHost["claim"]>>;
      try {
        claimed = await this.claim();
      } catch (error) {
        // The first claim fails the way it always has. One made to recover
        // the credential is refused when the session moved on meanwhile.
        if (!reclaimed || !(error instanceof WorkerGatewayRequestError)) {
          throw error;
        }
        return this.unactivated("lease_lost", describe(error));
      }
      if (claimed === null) {
        return {
          outcome: "unclaimed",
          reason:
            this.stopping?.reason ?? "No session was waiting for this worker",
          turns: [],
        };
      }
      const { claim } = claimed;
      this.claimValue = claim;
      this.workspaceEnforce =
        claim.workspace_enforce ?? DEFAULT_WORKSPACE_ENFORCE;
      this.options.gateway.useCredential(claim.session_credential);
      this.options.objectStoreAccess?.useToken(claim.object_store.access.token);
      this.scopeValue = {
        session_id: claim.session_id,
        turn_id: null,
        attempt_id: claim.attempt_id,
        lease_epoch: claim.lease_epoch,
        execution_generation: claim.execution_generation,
        auth_revision: claim.auth_revision,
      };
      this.grants = [...(claim.grants ?? [])];
      this.checkpointRevision = claim.restore?.revision ?? null;
      this.logger.info("worker.claimed", {
        session_id: claim.session_id,
        attempt_id: claim.attempt_id,
        restore_revision: claim.restore?.revision ?? null,
      });
      const activation = await this.activate(claimed);
      if (activation.kind === "accepted") {
        return { claim, lease: activation.lease };
      }
      if (
        activation.kind === "refused" &&
        !reclaimed &&
        this.stopping === undefined
      ) {
        this.logger.warn("worker.activation.reclaiming", {
          reason: activation.reason,
        });
        continue;
      }
      return this.unactivated(
        activation.kind === "abandoned"
          ? "drained"
          : activation.kind === "failed"
            ? "failed"
            : "lease_lost",
        activation.reason,
      );
    }
  }

  /**
   * One `starting` heartbeat under the claim's fence, answered. Unlike the
   * heartbeat loop's beats, which survive a refusal or a silence, this one
   * says which it was: startup goes on only after the gateway said yes.
   * An answer that never came is asked for again with the same credential,
   * never by claiming again: the beat that went unanswered may have landed,
   * and then the claim would be refused.
   */
  private async activate(claimed: {
    claim: BootstrapClaimResponse;
    sentAt: number;
  }): Promise<
    | { kind: "accepted"; lease: ClaimedLease }
    | { kind: "refused" | "lost" | "abandoned" | "failed"; reason: string }
  > {
    const leaseEndsAt = claimed.sentAt + claimed.claim.lease_remaining_ms;
    for (;;) {
      const sentAt = performance.now();
      if (sentAt >= leaseEndsAt) {
        return {
          kind: "lost",
          reason:
            "The claim's lease ran out before the gateway accepted this worker's first call",
        };
      }
      try {
        const answer = await this.untilStopGraceSpent(
          this.options.gateway.heartbeat({
            ...this.scope,
            attempt_state: "starting",
          }),
        );
        if (answer === undefined) {
          return {
            kind: "abandoned",
            reason:
              this.stopping?.reason ??
              "Stopped before the gateway accepted this worker's first call",
          };
        }
        return {
          kind: "accepted",
          lease: { remainingMs: answer.lease_remaining_ms, sentAt },
        };
      } catch (error) {
        if (!(error instanceof WorkerGatewayRequestError)) throw error;
        if (isOwnershipLost(error)) {
          return {
            kind:
              error.code === "UNAUTHORIZED" || error.code === "STALE_EPOCH"
                ? "refused"
                : "lost",
            reason: describe(error),
          };
        }
        if (!isRetryable(error)) {
          return { kind: "failed", reason: describe(error) };
        }
        if (this.stopping !== undefined) {
          return { kind: "abandoned", reason: this.stopping.reason };
        }
        this.logger.warn("worker.activation.retry", {
          reason: describe(error),
        });
        await this.sleep(GATEWAY_RETRY_MS);
      }
    }
  }

  /** How a worker that never got past activation ends: nothing was started. */
  private unactivated(
    outcome: "drained" | "failed" | "lease_lost",
    reason: string,
  ): WorkerRunSummary {
    this.logger.error("worker.activation.not_accepted", { outcome, reason });
    return { outcome, reason, turns: [] };
  }

  /** The claim, with the monotonic instant the request that won it went out. */
  private async claim(): Promise<{
    claim: BootstrapClaimResponse;
    sentAt: number;
  } | null> {
    const deadline = performance.now() + this.options.timeouts.claimTimeoutMs;
    let retriedUnauthorized = false;
    for (;;) {
      if (this.stopping !== undefined) return null;
      const sentAt = performance.now();
      try {
        const claimed = await this.untilStopGraceSpent(
          this.options.gateway.bootstrapClaim({
            capabilities: WORKER_CAPABILITIES,
            execution_id: this.options.execution.id,
            execution_generation: this.options.execution.generation,
            credential: {
              kind: "launch_nonce",
              nonce: this.options.execution.bootstrapNonce,
            },
            ...(this.options.imageRuntime === undefined
              ? {}
              : {
                  image_runtime: {
                    engine: this.options.imageRuntime.engine,
                    sdk_version: this.options.imageRuntime.sdkVersion,
                    cli_version: this.options.imageRuntime.cliVersion,
                    profile_digest_scheme:
                      this.options.imageRuntime.profileDigestScheme,
                  },
                }),
          }),
        );
        if (claimed === undefined) {
          // Past this point the SIGKILL would take the release away anyway;
          // a claim that lands later is recovered when its lease lapses.
          this.logger.warn("worker.claim.abandoned", {
            reason: "The stop grace ran out before the gateway answered",
          });
          return null;
        }
        return { claim: claimed, sentAt };
      } catch (error) {
        if (!(error instanceof WorkerGatewayRequestError)) throw error;
        // Two claims racing leave one holding the revoked token; before this
        // attempt has used a credential, claiming again returns a working one.
        if (error.code === "UNAUTHORIZED" && !retriedUnauthorized) {
          retriedUnauthorized = true;
          continue;
        }
        // The session was waiting, but on an operator rather than a worker:
        // its turns have no checkpoint this worker could restore.
        // Nothing went wrong here, so the worker leaves as one with nothing
        // to claim does.
        if (error.code === "RECOVERY_REQUIRED") {
          this.logger.info("worker.claim.refused", { reason: error.message });
          return null;
        }
        // The session this launch was for was failed on the spot; there is
        // nothing to wait for and nothing for anyone to resolve.
        if (error.code === "CATALOG_MISMATCH") {
          this.logger.warn("worker.claim.catalog_mismatch", {
            reason: error.message,
          });
          return null;
        }
        if (!error.retryable) throw error;
        if (performance.now() >= deadline) {
          // Nothing was waiting for this worker: KEDA-style launchers must see
          // it leave rather than sit on a slot.
          if (error.code === "NOT_FOUND") return null;
          throw error;
        }
        await this.sleep(CLAIM_RETRY_MS);
      }
    }
  }

  private async turnLoop(run: AgentRun): Promise<void> {
    let lastInputAt = performance.now();
    while (this.stopping === undefined) {
      // Before asking for input, not after: a delivered input the engine is
      // never given would be left for recovery as if it might have run.
      if (!(await this.interruptSettled())) return;
      if (this.mirrorError !== undefined) {
        // The next turn would run on a transcript that can no longer be
        // checkpointed; the gateway blocks new turns once the heartbeat
        // records it, and this stops the one that could slip in before.
        this.stop({ kind: "drain", reason: this.mirrorError });
        return;
      }
      // Between turns, the one safe boundary a pause waits for.
      if (this.pauseControl !== undefined) {
        if ((await this.commitPause(this.pauseControl)) !== "withdrawn") {
          return;
        }
        // The pause was cancelled: the same engine carries on, and the time
        // spent held is not idleness.
        lastInputAt = performance.now();
        continue;
      }
      // Not raced with a drain: an input the gateway hands over is this
      // attempt's to finish, and one dropped here stays open until the
      // reconciler decides it. The draining heartbeat `stop` sends makes the
      // gateway answer the poll empty, so waiting costs one poll interval.
      const next = await this.untilAbandoned(this.nextInput());
      if (next === undefined || next === null || this.ownerLost) return;
      // Pausing hands out no input; the idle clock must not end the attempt
      // before the pause is committed or refused.
      if (next.input === null && this.pauseControl !== undefined) continue;
      if (next.input === null) {
        // Nothing will come however long this waits: give the slot back now
        // rather than at the idle timeout.
        if (next.reason === "BUDGET_EXCEEDED") {
          this.stop({
            kind: "idle",
            reason:
              "The session has spent its cost or token budget (BUDGET_EXCEEDED)",
          });
          return;
        }
        if (next.draining === true) {
          this.stop({
            kind: "idle",
            reason: "The gateway hands this attempt no more input",
          });
          return;
        }
        const idleFor = performance.now() - lastInputAt;
        if (idleFor >= this.options.timeouts.idleTimeoutMs) {
          this.stop({
            kind: "idle",
            reason: `No input for ${Math.round(idleFor / 1000)}s`,
          });
          return;
        }
        continue;
      }
      await this.runTurn(run, next.input);
      // Idle is counted from the end of the last turn, not its start: a turn
      // longer than the idle timeout must not end the worker on the next poll.
      lastInputAt = performance.now();
    }
  }

  private requestPause(control: ControlIntent): void {
    if (this.stopping !== undefined) return;
    if (this.pauseControl === control.control_id) return;
    this.pauseControl = control.control_id;
    this.logger.info("worker.pause.requested", {
      control_id: control.control_id,
      turn_id: this.turn?.closed === false ? this.turn.turnId : null,
    });
  }

  /**
   * The turn is finished and finalized with its checkpoint; asking the
   * coordinator to commit the pause is the release itself. Everything the
   * attempt owes goes out first, since nothing it writes lands afterwards.
   * A refusal for want of a safe checkpoint keeps the lease and the engine:
   * the session stays pausing and shows why, and the release is asked again
   * every heartbeat interval until it commits or something else stops this
   * attempt (terminate fences it, SIGTERM drains it). Once the pause is no
   * longer the open one — a resume cancelled it, or a newer pause
   * replaced it — the answer is REQUEST_STALE and the attempt goes back to
   * its input loop as if it had never been asked.
   */
  private async commitPause(
    controlId: string,
  ): Promise<"committed" | "withdrawn" | "ended"> {
    const flushed = await settledWithin(
      this.publisher?.idle() ?? Promise.resolve(),
      this.options.timeouts.requestTimeoutMs,
    );
    if (!flushed || this.ownerLost) return "ended";
    // Raced with the loss, as the release below is: a lost attempt's engine
    // is killed now, not once these requests give up.
    await this.untilAbandoned(
      this.pending?.flush(this.options.timeouts.requestTimeoutMs) ??
        Promise.resolve(),
    );
    if (this.ownerLost) return "ended";
    // A mirror error latched while flushing is already draining; the
    // shutdown releases only once the gateway has recorded it, which a pause
    // release would skip. One that lands during the release request itself
    // may go unrecorded, and costs nothing: the turn's checkpoint pinned only
    // writes that had already settled, so the failed batch came after it,
    // and a resume starts from that checkpoint rather than this engine.
    if (this.mirrorError !== undefined) return "ended";
    let held = false;
    for (;;) {
      try {
        this.pauseReleasing = controlId;
        let unanswered = false;
        const response = await this.untilAbandoned(
          this.withRetry(() =>
            this.options.gateway
              .release({
                ...this.scope,
                turn_id: null,
                reason: "pause",
                pause_control_id: controlId,
              })
              // Judged per try, so an answer that lands after the loop has
              // stopped waiting still settles whether the pause committed.
              .then((response) => {
                if (!response.released && !unanswered) {
                  this.pauseReleasing = undefined;
                }
                return response;
              })
              .catch((error: unknown) => {
                if (isRetryable(error)) {
                  unanswered = true;
                } else if (!unanswered || !isOwnershipLost(error)) {
                  // A refusal before any try went unanswered, or one only a
                  // live binding gets: the release did not commit.
                  this.pauseReleasing = undefined;
                }
                throw error;
              }),
          ),
        );
        if (response === undefined) return "ended";
        // Already read as committed from a refusal elsewhere; a retry that
        // answers after that changes nothing.
        if (this.released) return "committed";
        if (!response.released) {
          // Only a superseded epoch answers so, and after a try that went
          // unanswered, that try is most likely what superseded it.
          if (unanswered) {
            this.presumePaused(
              "The release went unanswered and its retry found the epoch moved on",
            );
            return "committed";
          }
          this.lose("The pause release found the binding already superseded");
          return "ended";
        }
        this.released = true;
        this.logger.info("worker.pause.committed", { control_id: controlId });
        this.stop({
          kind: "paused",
          reason: "Paused; the execution is released",
        });
        return "committed";
      } catch (error) {
        if (this.ownerLost || this.released) return "ended";
        // Given up on by a stop with its outcome unknown: the stop decides
        // how this attempt ends, and a later refusal can still show the
        // release committed.
        if (isRetryable(error)) return "ended";
        const code =
          error instanceof WorkerGatewayRequestError ? error.code : null;
        if (code === "REQUEST_STALE") {
          // A newer pause the poll has since delivered is kept.
          if (this.pauseControl === controlId) this.pauseControl = undefined;
          this.logger.info("worker.pause.withdrawn", {
            control_id: controlId,
          });
          return "withdrawn";
        }
        if (code !== "CHECKPOINT_UNAVAILABLE") throw error;
        if (!held) {
          held = true;
          this.logger.warn("worker.pause.blocked", {
            control_id: controlId,
            reason: describe(error),
          });
        }
        await this.untilStopped(
          this.sleep(this.options.timeouts.heartbeatIntervalMs),
        );
        if (this.stopping !== undefined) return "ended";
      }
    }
  }

  /**
   * The server may have handed a turn over on a poll whose answer was lost,
   * so retrying is bounded: past the budget the worker fails and releases,
   * and the gateway closes that turn as unknown once the execution is gone.
   * A poll that answers after the budget is not used — its turn is the same
   * one, already given up.
   */
  private async nextInput(): Promise<NextInputResponse | null> {
    let budget: ReturnType<WorkerHost["stageBudget"]> | undefined;
    let expire: () => void = () => {};
    const expired = new Promise<undefined>((resolve) => {
      expire = () => resolve(undefined);
    });
    const poll = () =>
      this.options.gateway
        .nextInput({
          ...this.scope,
          wait_ms: this.options.timeouts.nextInputWaitMs,
        })
        .catch((error: unknown) => {
          if (budget === undefined && isRetryable(error)) {
            budget = this.stageBudget(
              "Retrying nextInput",
              this.options.timeouts.nextInputRetryTimeoutMs,
            );
            budget.expired.then(expire);
          }
          throw error;
        });
    const polling = this.withRetry(
      poll,
      () => budget?.hasExpired() === true || this.stopping !== undefined,
    );
    polling.catch(() => {});
    try {
      const answer = await Promise.race([polling, expired]);
      if (answer === undefined || budget?.hasExpired() === true) return null;
      return answer;
    } catch (error) {
      // Once winding down, a failed poll only means there is nothing more to
      // run; losing the lease is still a loss.
      if (this.stopping !== undefined && !isOwnershipLost(error)) return null;
      throw error;
    } finally {
      budget?.disarm();
    }
  }

  private async runTurn(
    run: AgentRun,
    input: {
      input_id: string;
      message: string;
      turn_id: string;
      co_author?: { name: string; email: string } | null | undefined;
      trace_context?: string | undefined;
      content_mode?: "full" | "metadata" | undefined;
    },
  ): Promise<void> {
    // Delivered while the engine was already gone, or to an attempt whose
    // lease is gone: either way nothing may run it here, so it is left open
    // for the reconciler. A drain still runs it: that attempt owns it —
    // unless the mirror lost a batch, as when the gateway answered the poll
    // before the draining beat: no checkpoint could cover what it did.
    if (
      this.stopKind === "failed" ||
      this.stopKind === "lost" ||
      this.mirrorError !== undefined
    ) {
      return;
    }
    const claim = this.claimValue;
    if (
      claim?.git !== undefined &&
      this.options.gitTrailers !== undefined &&
      (input.co_author !== undefined || this.turnCoAuthorWritten)
    ) {
      // An input without the field goes back to the claim's own value, so a
      // turn from an older control host never inherits the previous turn's.
      const coAuthor =
        input.co_author === undefined ? claim.git.co_author : input.co_author;
      try {
        await this.options.gitTrailers({
          ...claim,
          git: { ...claim.git, co_author: coAuthor },
        });
      } catch (error) {
        const reason = describe(error);
        this.logger.warn("worker.git_trailers.turn_not_started", {
          turn_id: input.turn_id,
          reason,
        });
        // Left open, and this attempt stops: the same input would otherwise
        // be handed back on every poll while the lease is kept.
        this.fail(`The trailer files could not be written: ${reason}`);
        return;
      }
      this.turnCoAuthorWritten = input.co_author !== undefined;
      if (input.co_author !== undefined) {
        noteTurnCoAuthor(claim, input.co_author);
      }
    }
    this.scope.turn_id = input.turn_id;
    // The same input must carry the same uuid on every delivery: that is what
    // lets the engine deduplicate a turn it already saw after a crash.
    const uuid = inputUuid(
      this.scope.session_id,
      input.turn_id,
      input.input_id,
    );
    const turn = this.beginTurn(input.turn_id, uuid);
    const telemetry = claim?.telemetry;
    if (this.tracing !== undefined && telemetry?.enabled === true) {
      turn.spans = this.tracing.emitter.beginTurn(
        {
          turnId: input.turn_id,
          message: input.message,
          traceContext: input.trace_context,
          checkpointRevision: this.checkpointRevision,
        },
        {
          mode: input.content_mode ?? telemetry.content_mode,
          maxBytes: telemetry.content_max_bytes,
        },
      );
    }
    this.logger.info("worker.turn.started", {
      turn_id: input.turn_id,
      input_id: input.input_id,
    });
    // Watched from before the send: an interrupt that comes while the input
    // is still being checked is applied as soon as it goes out.
    this.pending?.watch(true);
    // Armed before the delivery check, so a check that hangs spends the same
    // budget as an engine that does.
    this.armDeadline(run, turn);
    let unwatch: (() => void) | undefined;
    let settledAs: Settlement | undefined;
    try {
      unwatch = await this.armQuota(run, turn);
      await this.deliver(run, turn, input.message);
      // The engine's terminal ends the turn; the deadline ends one it never
      // answers, which heartbeats alone would otherwise keep leased forever.
      const settlement = await Promise.race([
        turn.settled,
        this.abandoned.then(() => undefined),
      ]);
      try {
        settledAs = settlement;
        // Owner loss forbids every further durable write, including this one.
        if (settlement === undefined || this.ownerLost) return;
        if (settlement.status === "outcome_unknown") {
          // The session is recovery's to decide now (the gateway holds the
          // input back as recovery_required); stopping first also bounds
          // the finalize below by the drain budget.
          this.stop({
            kind: "drain",
            reason: `Turn ${input.turn_id} needs a recovery decision`,
          });
        }
        await this.finalizeTurn(run, input.turn_id, settlement);
      } finally {
        // Whatever the engine said after the terminal goes out now, as session
        // events, whether or not the turn made it to a finalize.
        this.publisher?.release();
      }
    } finally {
      unwatch?.();
      clearTurnTimers(turn);
      // After the checkpoint and the finalize, so `werft.checkpoint` is inside
      // the root; sending starts at once and waits for nobody.
      turn.spans.end({
        status: settledAs?.status ?? "outcome_unknown",
        reason: settledAs?.reason ?? null,
        usage: settledAs?.usage,
      });
      this.tracing?.flush();
    }
  }

  /**
   * Sends the input unless the engine session already holds its uuid. Such a
   * send is deduplicated and never answered; regenerating the uuid
   * would make it a new turn and redo whatever the first delivery did. The
   * transcript the run resumed from is what says so, and when it holds the
   * input its outcome is unknown: it was recorded, not proven finished.
   */
  private async deliver(run: AgentRun, turn: Turn, message: string) {
    const check = run.holdsInput(turn.uuid).catch((error: unknown) => {
      // Past the deadline the timeout owns the terminal; a check failing
      // now must not unwind the turn before it is finalized.
      if (turn.timedOut || turn.quotaExceeded) return undefined;
      throw error;
    });
    // Raced with the turn too: the deadline has to end a check that hangs.
    const held = await Promise.race([
      this.untilAbandoned(check),
      turn.settled.then(() => undefined),
    ]);
    // The check awaited: the deadline, the lease or the engine may be gone.
    // Past the deadline nothing is sent, even with the terminal still to
    // come: the interrupt has already been asked for and would miss it.
    if (
      held === undefined ||
      turn.closed ||
      turn.timedOut ||
      turn.quotaExceeded
    )
      return;
    if (this.stopKind === "failed" || this.stopKind === "lost") return;
    if (held) {
      this.logger.warn("worker.turn.already_consumed", {
        turn_id: turn.turnId,
      });
      this.settleTurn(unknownOutcome("input_already_consumed"));
      return;
    }
    run.send({ message, uuid: turn.uuid });
    turn.sent = true;
    // An interrupt taken while the check ran reaches the engine now.
    if (turn.interrupting) this.sendInterrupt(run, turn);
  }

  /**
   * On expiry the turn is interrupted, and the worker winds down whatever
   * happens next: an engine that overran its budget is not handed another
   * input, and a late interrupt must not land on one. An engine that answers
   * within the grace ends the turn `failed`; one that does not leaves it
   * `outcome_unknown` for recovery, because the interrupt proves nothing
   * about what the engine did.
   */
  private armDeadline(run: AgentRun, turn: Turn): void {
    const budget = this.options.timeouts.maxTurnMs;
    const expire = () => {
      // An interrupt already has its own, shorter grace; the deadline taking
      // over would turn its `interrupted` into a timeout failure.
      if (turn.closed || turn.interrupting || this.ownerLost) return;
      turn.timedOut = true;
      const reason = `Turn ${turn.turnId} ran past its ${budget / 1000}s budget`;
      this.logger.warn("worker.turn.timeout", {
        turn_id: turn.turnId,
        max_turn_ms: budget,
      });
      this.stop({ kind: "drain", reason });
      this.pending?.cancelAll("interrupt", "The turn ran out of time");
      run.interrupt().catch((error) => {
        this.logger.warn("worker.interrupt.failed", {
          reason: describe(error),
        });
      });
      // Never more than half of what is left of the drain, which may have
      // begun well before the deadline: were the drain to give the turn up
      // first, it would end with no terminal at all.
      const left =
        (this.abandonsAt ?? Number.POSITIVE_INFINITY) - performance.now();
      const grace = Math.min(this.interruptGraceMs(), left / 2);
      const unanswered = `${reason}, and the engine did not answer the interrupt`;
      if (grace <= 0) {
        this.closeUnanswered(turn, unanswered);
        return;
      }
      turn.timers.push(
        setTimeout(() => this.closeUnanswered(turn, unanswered), grace),
      );
    };
    turn.timers.push(setTimeout(expire, budget));
  }

  private async armQuota(
    run: AgentRun,
    turn: Turn,
  ): Promise<(() => void) | undefined> {
    const monitoring = this.options.workspaceQuota;
    if (monitoring === undefined || this.workspaceEnforce === "off") return;
    const baseline =
      this.workspaceEnforce === "fail"
        ? await Promise.race([
            monitoring.observer.measureNow(),
            turn.settled.then(() => undefined),
            this.abandoned.then(() => undefined),
          ])
        : undefined;
    if (turn.closed || this.ownerLost) return;
    const quota = new WorkspaceQuota(monitoring.limits, baseline);
    return monitoring.observer.watch((usage, mode) => {
      if (
        this.turn !== turn ||
        turn.closed ||
        turn.interrupting ||
        turn.timedOut ||
        turn.quotaExceeded ||
        this.ownerLost
      )
        return;
      const exceeded =
        this.workspaceEnforce === "fail"
          ? quota.exceeded(usage, mode)
          : (["bytes", "inodes"] as const).some(
              (axis) =>
                mode[axis] !== "hard" && usage[axis] > monitoring.limits[axis],
            );
      if (!exceeded) return;
      this.logger.warn("worker.turn.workspace_quota_exceeded", {
        turn_id: turn.turnId,
        bytes: usage.bytes,
        inodes: usage.inodes,
        enforce: this.workspaceEnforce,
        metric: "workspace_quota_exceeded_total",
        value: 1,
      });
      if (this.workspaceEnforce !== "fail") return;
      turn.quotaExceeded = true;
      turn.interruptDeadline = performance.now() + this.interruptGraceMs();
      this.pending?.cancelAll("interrupt", "The workspace exceeded its quota");
      this.sendInterrupt(run, turn);
      turn.timers.push(
        setTimeout(() => {
          if (
            this.turn !== turn ||
            turn.closed ||
            turn.interrupting ||
            turn.timedOut ||
            this.ownerLost
          )
            return;
          this.fail(
            "The engine did not settle after the workspace exceeded its quota",
          );
          this.settleTurn(
            unknownOutcome("workspace_quota_interrupt_unanswered"),
          );
        }, this.interruptGraceMs()),
      );
    });
  }

  /** A timed-out turn the engine gave no terminal for: unknown, and the engine is not trusted again. */
  private closeUnanswered(turn: Turn, reason: string): void {
    if (turn.closed) return;
    this.fail(reason);
    this.settleTurn(unknownOutcome("turn_timeout"));
  }

  private async finalizeTurn(
    run: AgentRun,
    turnId: string,
    reported: Settlement,
  ): Promise<void> {
    const interruptTurn =
      this.turn?.turnId === turnId && this.turn.interrupting
        ? this.turn
        : undefined;
    const parking = interruptTurn?.parking;
    this.endApprovalCheckpoints();
    // Parked only when the cut is what ended it; a turn that got to its
    // own end first keeps that end, and what it held is settled after all.
    const parked = parking !== undefined && reported.status === "interrupted";
    if (parking !== undefined && !parked) this.pending?.unpark();
    const settlement: Settlement = parked
      ? { ...reported, reason: TURN_INPUT_WAIT_PARKED_REASON }
      : reported;
    // The event tail has to be durable before the turn is declared over: a
    // finalize that overtakes its own events publishes a closed turn whose
    // stream is still arriving. Both waits end with the drain budget, so a
    // gateway that keeps failing cannot hold the process past it.
    const flushed = await this.untilAbandoned(
      (this.publisher?.idle() ?? Promise.resolve()).then(() => true),
    );
    if (flushed === undefined || this.ownerLost) return;
    // Where settleTurn cut the stream; idle() has made all of it durable.
    const finalSourceSequence = this.publisher?.hold() ?? 0;
    const interrupted = settlement.status === "interrupted";
    let captured: Captured | undefined;
    let checkpointSpan: CheckpointSpan | undefined;
    // What may still commit this turn's checkpoint. The lease is released
    // only once it has answered: untilAbandoned stops waiting for a request,
    // it does not stop the request, and a pointer CAS that lands after
    // writers were let back in would commit a capture they have changed.
    let outstanding: Promise<unknown> | undefined;
    // Set once any finalize attempt fails without an answer that decides it
    // (no answer, a 5xx): that request may still commit, whatever a later
    // retry is told, until one succeeds and the idempotent key settles both.
    let undecided = false;
    let captureStageFinished = false;
    const finishInterruptCapture = (fields: Record<string, unknown>): void => {
      if (interruptTurn === undefined || captureStageFinished) return;
      captureStageFinished = true;
      this.logInterruptStage(interruptTurn, "capture_finished", fields);
    };
    try {
      let checkpoint: CheckpointRef | null = null;
      if (settlement.synthetic !== true) {
        if (interruptTurn !== undefined) {
          this.logInterruptStage(interruptTurn, "capture_started");
        }
        const span = (
          this.turn?.turnId === turnId ? this.turn.spans : NO_TURN_SPANS
        ).beginCheckpoint();
        checkpointSpan = span;
        const rawCapturing = this.capture(
          run,
          parked ? { pendingApprovals: parking.approvals } : undefined,
        ).catch((error: unknown) => {
          span.fail(describe(error));
          throw error;
        });
        const capturing =
          interruptTurn === undefined
            ? rawCapturing
            : rawCapturing.then(
                (result) => {
                  finishInterruptCapture({
                    checkpoint_available: result.ref !== null,
                    outcome: "completed",
                  });
                  return result;
                },
                (error: unknown) => {
                  finishInterruptCapture({
                    outcome: "failed",
                    reason: describe(error),
                  });
                  throw error;
                },
              );
        outstanding = capturing;
        // The heartbeat keeps the lease while a capture runs, so one that
        // never returns needs a bound of its own. It moves the workspace out
        // as the startup moved it in, and gets the same budget; a knob of its
        // own waits until the two need different bounds.
        const budget = interrupted
          ? undefined
          : this.stageBudget(
              "Checkpointing the turn",
              this.options.timeouts.startupTimeoutMs,
            );
        try {
          captured = await this.untilAbandoned(
            // Someone is waiting on an interrupt's receipt: a capture that
            // fails or hangs gives it an unknown outcome (below) instead of
            // none. Any other turn fails the worker, and its budget above
            // starts the drain that ends the wait.
            interrupted
              ? this.withinCaptureBudget(
                  capturing,
                  turnId,
                  interruptTurn,
                  finishInterruptCapture,
                )
              : capturing,
          );
        } finally {
          budget?.disarm();
        }
        if (captured === undefined) {
          checkpointSpan?.fail("The checkpoint was abandoned");
          finishInterruptCapture({ outcome: "abandoned" });
          capturing.then(
            ({ lease }) => lease?.release(),
            () => {},
          );
          return;
        }
        checkpoint = captured.ref;
      }
      if (this.ownerLost) return;
      // A turn is `interrupted` only when the engine's terminal comes
      // with a checkpoint consistent with it; without one nobody can say what
      // the transcript holds, and the turn goes to recovery instead.
      const unconfirmed: Settlement = {
        ...settlement,
        status: "outcome_unknown",
        reason: "interrupt_checkpoint_unavailable",
      };
      // The session goes to recovery with it, as runTurn arranges for an
      // unknown the engine reported itself.
      const unconfirm = (): Settlement => {
        this.stop({
          kind: "drain",
          reason: `Turn ${turnId} needs a recovery decision`,
        });
        return unconfirmed;
      };
      let terminal: Settlement =
        interrupted && checkpoint === null ? unconfirm() : settlement;
      const finalize = (outcome: Settlement, ref: CheckpointRef | null) => {
        if (interruptTurn !== undefined) {
          this.logInterruptStage(interruptTurn, "finalize_started", {
            checkpoint_present: ref !== null,
            terminal_status: outcome.status,
          });
        }
        const finalizing = this.withRetry(
          () =>
            this.options.gateway
              .finalize({
                ...this.scope,
                turn_id: turnId,
                finalize_key: `${this.scope.attempt_id}:${turnId}`,
                final_source_sequence: finalSourceSequence,
                terminal: {
                  status: outcome.status,
                  reason: outcome.reason,
                  result: outcome.result ?? null,
                  usage: outcome.usage ?? null,
                  cost_usd:
                    outcome.costUsd === undefined
                      ? null
                      : Math.min(outcome.costUsd, MAX_TURN_COST_USD),
                },
                checkpoint: ref,
              })
              .catch((error: unknown) => {
                // Only a request carrying the checkpoint can commit it.
                if (ref !== null && isRetryable(error)) undecided = true;
                throw error;
              }),
          () => this.abandonedNow,
        );
        outstanding = finalizing;
        return this.untilAbandoned(finalizing).then(
          (result) => {
            if (interruptTurn !== undefined) {
              this.logInterruptStage(interruptTurn, "finalize_finished", {
                checkpoint_present: ref !== null,
                outcome: result === undefined ? "abandoned" : "succeeded",
                terminal_status: outcome.status,
              });
            }
            return result;
          },
          (error: unknown) => {
            if (interruptTurn !== undefined) {
              this.logInterruptStage(interruptTurn, "finalize_finished", {
                checkpoint_present: ref !== null,
                outcome: "failed",
                reason: describe(error),
                terminal_status: outcome.status,
              });
            }
            throw error;
          },
        );
      };
      let finalized: Awaited<ReturnType<typeof finalize>>;
      try {
        finalized = await finalize(
          terminal,
          terminal === settlement ? checkpoint : null,
        );
      } catch (error) {
        // The gateway refused the manifest itself (only verification answers
        // CHECKPOINT_UNAVAILABLE to a finalize that carries one), so that
        // request committed nothing and the same key may carry another body.
        if (
          terminal !== settlement ||
          checkpoint === null ||
          !(error instanceof WorkerGatewayRequestError) ||
          error.code !== "CHECKPOINT_UNAVAILABLE"
        ) {
          throw error;
        }
        // Any other turn is recorded without the checkpoint, as it would have
        // been had the publish failed here — but only when no earlier attempt
        // is still out that might commit it under the first body.
        if (undecided) throw error;
        checkpointSpan?.fail(describe(error));
        this.logger.warn("worker.checkpoint.failed", {
          stage: "finalize",
          reason: describe(error),
          revision: checkpoint.revision,
          manifest_ref: checkpoint.manifest_ref,
          turn_id: turnId,
        });
        // Nothing can commit the capture any more; the fallback carries no
        // checkpoint to wait on.
        captured?.lease?.release();
        await this.checkpoints.finalizeRefused?.(describe(error), {
          ...this.scope,
        });
        // An interrupted turn is `interrupted` only with its checkpoint.
        terminal = interrupted ? unconfirm() : settlement;
        finalized = await finalize(terminal, null);
      }
      if (finalized === undefined) return;
      outstanding = undefined;
      if (terminal === settlement && checkpoint !== null) {
        this.checkpointRevision = checkpoint.revision;
      }
      this.dropGrants(turnId);
      this.turns.push({
        turnId,
        status: terminal.status,
        reason: terminal.reason,
      });
      this.logger.info("worker.turn.finalized", {
        turn_id: turnId,
        status: terminal.status,
      });
      this.turn = undefined;
      this.scope.turn_id = null;
    } finally {
      checkpointSpan?.end();
      const lease = captured?.lease;
      if (lease != null) {
        if (outstanding === undefined) lease.release();
        else
          outstanding.then(
            () => lease.release(),
            // Only a refusal of a request that was the only one out decides
            // the CAS; otherwise the run ends with the lease still held
            // rather than let a writer in ahead of a commit that may yet land.
            () => {
              if (!undecided) lease.release();
            },
          );
      }
    }
  }
  private beginTurn(turnId: string, uuid: string): Turn {
    let settle: (settlement: Settlement | Promise<Settlement>) => void =
      () => {};
    const settled = new Promise<Settlement>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = {
      closed: false,
      cut: false,
      entered: false,
      interrupting: false,
      sent: false,
      settled,
      settle,
      timedOut: false,
      timers: [],
      turnId,
      uuid,
      spans: NO_TURN_SPANS,
    };
    this.turn = turn;
    return turn;
  }

  private settleTurn(settlement: Settlement): void {
    const turn = this.turn;
    if (turn === undefined) return;
    this.closeTurn(turn);
    this.cutTurn(turn, settlement);
  }

  /**
   * The stream is cut here, at the terminal frame, and not wherever it has
   * reached by the time finalize is sent: the engine keeps emitting after
   * its result, and the gateway closes the turn only at the exact end. Only
   * the first settlement counts; a later one is a no-op.
   */
  private cutTurn(turn: Turn, settlement: Settlement): void {
    if (turn.cut) return;
    turn.cut = true;
    this.recordEngineStopped(turn, settlement);
    this.publisher?.hold();
    turn.settle(settlement);
  }

  private closeTurn(turn: Turn): void {
    turn.closed = true;
    clearTurnTimers(turn);
    // Nothing can interrupt a turn that has ended; the next one watches anew.
    this.pending?.watch(false);
  }

  /**
   * The interrupt's effect, recorded ahead of the checkpoint: the
   * engine ended the turn by abort after acknowledging the interrupt, so it
   * does no more work for it. Inside the turn's stream, before the cut, so
   * it is durable before the capture starts; it settles nothing, and the
   * turn is `interrupted` only once finalize carries its checkpoint.
   */
  private recordEngineStopped(turn: Turn, settlement: Settlement): void {
    if (turn.interrupting && settlement.synthetic !== true) {
      this.logInterruptStage(turn, "engine_terminal", {
        outcome: "received",
        terminal_status: settlement.status,
      });
    }
    if (settlement.status !== "interrupted" || settlement.synthetic === true)
      return;
    this.logger.info("worker.turn.engine_stopped", {
      turn_id: turn.turnId,
      control_id: turn.controlId ?? null,
    });
    this.publisher?.publish(
      [
        {
          id: `engine-stopped:${turn.turnId}`,
          event: "status",
          data: {
            phase: "engine_stopped",
            ...(turn.controlId === undefined
              ? {}
              : { control_id: turn.controlId }),
          },
        },
      ],
      turn.turnId,
    );
  }

  /**
   * An interrupt reaches only the turn it names, and only while it runs: one
   * that arrives after its turn ended — the next may already be running — is
   * ignored here, and the gateway settles its receipt from how that turn
   * actually ended. The engine keeps its session; only this turn stops.
   */
  private onControl(
    control: ControlIntent,
    poll: { answered: boolean } = { answered: false },
  ): void {
    if (control.kind === "pause") {
      this.requestPause(control);
      return;
    }
    if (control.kind === "park") {
      void this.onPark(control, poll.answered);
      return;
    }
    const turn = this.turn;
    const run = this.engine;
    if (control.kind !== "interrupt") return;
    if (turn === undefined || run === undefined || this.stopKind === "lost") {
      return;
    }
    // A timed-out turn is already being interrupted, on its own terms.
    if (
      turn.closed ||
      turn.interrupting ||
      turn.timedOut ||
      turn.turnId !== control.target_turn_id
    ) {
      return;
    }
    turn.interrupting = true;
    turn.controlId = control.control_id;
    turn.interruptStartedAt = performance.now();
    this.logInterruptStage(turn, "control_received");
    this.logger.info("worker.turn.interrupting", {
      turn_id: turn.turnId,
      control_id: control.control_id,
    });
    this.publisher?.publish(
      [
        {
          id: `control:${control.control_id}`,
          event: "status",
          data: { phase: "interrupting" },
        },
      ],
      turn.turnId,
    );
    // What the turn was waiting on is void: an answer landing now must not
    // let the engine carry the interrupted turn on.
    this.pending?.cancelAll("interrupt", "The turn was interrupted");
    this.armInterruptGrace(turn);
    if (turn.sent) this.sendInterrupt(run, turn);
  }

  /**
   * The grace runs from here, not from the send: an input check that hangs
   * must not hold the interrupt open until the turn budget ends.
   */
  private armInterruptGrace(turn: Turn): void {
    const graceMs = this.interruptGraceMs();
    turn.interruptDeadline = performance.now() + graceMs;
    turn.timers.push(
      setTimeout(() => {
        if (turn.closed) return;
        this.logInterruptStage(turn, "engine_terminal", {
          outcome: "timeout",
          sdk_response: turn.interruptReceipt ?? "not_sent",
        });
        // An engine that ignores an interrupt is not handed the next input.
        this.fail(
          `Turn ${turn.turnId} gave no terminal within ${graceMs}ms of its interrupt`,
        );
        this.settleTurn(unknownOutcome("interrupt_unanswered"));
      }, graceMs),
    );
  }

  /**
   * A park the platform asked for because the turn's requests went
   * unanswered. Declined before anything is touched when the poll that
   * brought it also applied an answer, or when no checkpoint could be left
   * to park on; otherwise the turn is cut, finalized parked, and the
   * release commits the control. A drain under way parks on its own.
   */
  private async onPark(
    control: ControlIntent,
    answered: boolean,
  ): Promise<void> {
    if (this.parksTaken.has(control.control_id)) return;
    if (this.stopping !== undefined) return;
    this.parksTaken.add(control.control_id);
    const turn = this.turn;
    const run = this.engine;
    this.logger.info("worker.park.requested", {
      control_id: control.control_id,
      turn_id: turn?.closed === false ? turn.turnId : null,
    });
    if (
      answered ||
      run === undefined ||
      turn === undefined ||
      this.parkBlockedNow(run, turn)?.reason === NOTHING_WAITING
    ) {
      await this.declinePark(control.control_id, "answer_applied");
      return;
    }
    if (this.pending?.parkReady === false) {
      await this.pending.flush(this.options.timeouts.requestTimeoutMs);
    }
    const blocked =
      (await this.parkBlocker(run, turn)) ?? this.parkBlockedNow(run, turn);
    if (this.stopping !== undefined) return;
    if (blocked !== undefined) {
      this.logger.warn("worker.park.unavailable", {
        control_id: control.control_id,
        reason: blocked.reason,
      });
      await this.declinePark(
        control.control_id,
        blocked.reason === NOTHING_WAITING
          ? "answer_applied"
          : "checkpoint_unavailable",
      );
      return;
    }
    this.cutForPark(run, turn, control.control_id);
  }

  private async declinePark(
    controlId: string,
    reason: "answer_applied" | "checkpoint_unavailable",
  ): Promise<void> {
    try {
      const { reverted } = await this.withRetry(() =>
        this.options.gateway.parkDeclined({
          ...this.scope,
          pause_control_id: controlId,
          reason,
        }),
      );
      this.logger.info("worker.park.declined", {
        control_id: controlId,
        reason,
        reverted,
      });
    } catch (error) {
      // The park stays the open pause; a pause can still commit it later.
      this.logger.warn("worker.park.decline_failed", {
        control_id: controlId,
        reason: describe(error),
      });
    }
  }

  /**
   * The drain's park: a turn left waiting only on a person is cut there and
   * parked, rather than held to the drain budget and denied. Answers
   * already given are applied first, and a tool one of them let run is
   * waited out before the turn is judged again. Anything that would leave
   * no checkpoint leaves the drain as it was.
   */
  private async drainPark(): Promise<void> {
    for (;;) {
      const run = this.engine;
      const turn = this.turn;
      const pending = this.pending;
      if (
        run === undefined ||
        turn === undefined ||
        pending === undefined ||
        this.stopKind !== "drain" ||
        this.abandonedNow
      ) {
        return;
      }
      await pending.refresh(this.options.timeouts.requestTimeoutMs);
      if (this.stopKind !== "drain" || this.turn !== turn) return;
      const blocked =
        (await this.parkBlocker(run, turn)) ?? this.parkBlockedNow(run, turn);
      if (this.stopKind !== "drain" || this.abandonedNow) return;
      if (blocked === undefined) {
        this.cutForPark(run, turn);
        return;
      }
      if (blocked.lasting) {
        if (blocked.reason !== NOTHING_WAITING) {
          this.logger.warn("worker.park.unavailable", {
            turn_id: turn.turnId,
            reason: blocked.reason,
          });
        }
        return;
      }
      await this.untilAbandoned(
        Promise.race([
          this.sleep(this.options.timeouts.answerPollIntervalMs),
          turn.settled,
        ]),
      );
    }
  }

  /**
   * Why the turn cannot be parked at this instant, judged in one step with
   * nothing awaited, so the cut that follows it finds the same. `lasting`
   * says waiting will not change it.
   */
  private parkBlockedNow(
    run: AgentRun,
    turn: Turn,
  ): { lasting: boolean; reason: string } | undefined {
    if (this.mirrorError !== undefined) {
      return { lasting: true, reason: this.mirrorError };
    }
    const pending = this.pending;
    if (
      turn.closed ||
      turn.interrupting ||
      turn.timedOut ||
      !turn.sent ||
      pending === undefined ||
      pending.outstanding === 0
    ) {
      return { lasting: true, reason: NOTHING_WAITING };
    }
    const readiness = parkReadinessOf(run);
    if (!readiness.ok) {
      return readiness.reason === "checkpoint_unavailable"
        ? { lasting: true, reason: readiness.detail }
        : {
            lasting: readiness.reason === "not_supported",
            reason: `The runtime cannot park now (${readiness.reason})`,
          };
    }
    if (!pending.parkReady) {
      return {
        lasting: false,
        reason: "A request or its outcome has not reached the gateway yet",
      };
    }
    const bytes = Buffer.byteLength(JSON.stringify(pending.peekParked()));
    if (bytes > PARKED_STATE_MAX_BYTES) {
      return {
        lasting: true,
        reason: `What the turn waits on is ${bytes} bytes, over the ${PARKED_STATE_MAX_BYTES} a park keeps`,
      };
    }
    return undefined;
  }

  /** parkBlockedNow, then what the checkpoint port knows about the transcript. */
  private async parkBlocker(
    run: AgentRun,
    turn: Turn,
  ): Promise<{ lasting: boolean; reason: string } | undefined> {
    const now = this.parkBlockedNow(run, turn);
    if (now !== undefined) return now;
    const readiness = parkReadinessOf(run);
    if (!readiness.ok) return undefined;
    // A parked finalize needs its checkpoint, which this run would not take.
    const { effective } = await run.ready();
    if (!effective.checkpoint) {
      return { lasting: true, reason: "The run takes no checkpoints" };
    }
    const reason = await this.checkpoints.parkBlocked?.(readiness.resume);
    return reason === undefined ? undefined : { lasting: true, reason };
  }

  /**
   * Every waiting callback is cancelled for the park, which the runtime
   * turns into a refusal that stops the turn, and the turn is interrupted
   * on the interrupt's own terms. Nothing is settled: the requests stay
   * open for the finalize to park.
   */
  private cutForPark(run: AgentRun, turn: Turn, controlId?: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    const approvals = pending.park();
    turn.parking = {
      approvals,
      ...(controlId === undefined ? {} : { controlId }),
    };
    // The release that follows the finalize is the park's commit.
    if (controlId !== undefined) this.pauseControl = controlId;
    turn.interrupting = true;
    turn.interruptStartedAt = performance.now();
    this.logger.info("worker.turn.parking", {
      turn_id: turn.turnId,
      control_id: controlId ?? null,
      request_ids: approvals.map((approval) => approval.requestId),
    });
    this.armInterruptGrace(turn);
    this.sendInterrupt(run, turn);
  }

  private sendInterrupt(run: AgentRun, turn: Turn): void {
    turn.interruptReceipt = "pending";
    this.logInterruptStage(turn, "sdk_interrupt_called");
    const answered = run.interrupt().then(
      () => {
        turn.interruptReceipt = "acknowledged";
        this.logInterruptStage(
          turn,
          turn.closed
            ? "late_sdk_interrupt_answered"
            : "sdk_interrupt_answered",
          { outcome: "acknowledged" },
        );
      },
      (error) => {
        turn.interruptReceipt = "refused";
        this.logInterruptStage(
          turn,
          turn.closed
            ? "late_sdk_interrupt_answered"
            : "sdk_interrupt_answered",
          {
            outcome: "refused",
            reason: describe(error),
          },
        );
        this.logger.warn("worker.interrupt.failed", {
          reason: describe(error),
        });
      },
    );
    turn.interruptAnswered = answered;
    this.interruptAnswered = answered;
  }

  /**
   * An aborted terminal that overtook its interrupt's receipt. The SDK writes
   * a clean interrupt's receipt first; a turn that crashed while handling it
   * may report first, so the receipt, awaited within what is left of the
   * grace, decides. None by then is an interrupt the engine never answered.
   */
  private onceAnswered(
    turn: Turn,
    decide: (acknowledged: boolean) => Settlement,
  ): Promise<Settlement> {
    const leftMs = Math.max(
      0,
      (turn.interruptDeadline ?? performance.now()) - performance.now(),
    );
    return settledWithin(
      turn.interruptAnswered ?? Promise.resolve(),
      leftMs,
    ).then((answered) => {
      if (answered) return decide(turn.interruptReceipt === "acknowledged");
      this.fail(
        `Turn ${turn.turnId} ended before its interrupt was answered, and no answer came`,
      );
      return unknownOutcome("interrupt_unanswered", decide(false));
    });
  }

  /**
   * A capture for an interrupted turn, bounded by a budget of its own that
   * starts once the engine has stopped: the interrupt's effect is already
   * recorded (engine_stopped), so the capture no longer shares its grace. One
   * that fails or runs late counts as no checkpoint; a lease it takes after
   * that is let go as soon as it arrives, since nothing will commit what it
   * guards. A drain already under way can only cut it shorter
   * (untilAbandoned).
   */
  private withinCaptureBudget(
    capturing: Promise<Captured>,
    turnId: string,
    turn: Turn | undefined,
    finishCapture: (fields: Record<string, unknown>) => void,
  ): Promise<Captured> {
    const none: Captured = { lease: null, ref: null };
    const tolerant = capturing.then(
      (captured) => captured,
      (error: unknown): Captured => {
        this.logger.warn("worker.checkpoint.failed", {
          session_id: this.scope.session_id,
          turn_id: turnId,
          control_id: turn?.controlId ?? null,
          reason: describe(error),
        });
        return none;
      },
    );
    const budgetMs =
      this.options.timeouts.interruptCaptureMs ?? INTERRUPT_CAPTURE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Captured>((resolve) => {
      timer = setTimeout(() => {
        finishCapture({ budget_ms: budgetMs, outcome: "timeout" });
        this.logger.warn("worker.checkpoint.late", {
          session_id: this.scope.session_id,
          turn_id: turnId,
          control_id: turn?.controlId ?? null,
          budget_ms: budgetMs,
        });
        tolerant.then(({ lease }) => lease?.release());
        resolve(none);
      }, budgetMs);
    });
    return Promise.race([tolerant, late]).finally(() => clearTimeout(timer));
  }

  private interruptGraceMs(): number {
    return this.options.timeouts.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  }

  private logInterruptStage(
    turn: Turn,
    stage: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger.info("worker.turn.interrupt.stage", {
      ...fields,
      session_id: this.scope.session_id,
      turn_id: turn.turnId,
      control_id: turn.controlId ?? null,
      stage,
      elapsed_ms:
        turn.interruptStartedAt === undefined
          ? null
          : Math.round(performance.now() - turn.interruptStartedAt),
    });
  }

  /**
   * Waits, bounded by the interrupt grace, for the engine to have answered
   * the last interrupt. False when it never did: that engine is not handed
   * another input, and the worker winds down.
   */
  private async interruptSettled(): Promise<boolean> {
    const answered = this.interruptAnswered;
    if (answered === undefined) return true;
    const graceMs = this.interruptGraceMs();
    if (await settledWithin(answered, graceMs)) {
      if (this.interruptAnswered === answered)
        this.interruptAnswered = undefined;
      return true;
    }
    this.fail(
      `The engine did not acknowledge an interrupt within ${graceMs}ms`,
    );
    return false;
  }

  private pump(run: AgentRun): Promise<void> {
    return (async () => {
      try {
        // A `tool.called` follows the public event that carries its call.
        let publicIsOurs = true;
        for await (const event of run.events()) {
          const framed =
            event.type === "public" ? this.frameTurn(event.inputs) : undefined;
          if (event.type === "public") publicIsOurs = framed !== null;
          const turn = this.turn;
          // Another input's events belong to no turn, by the rule settlement
          // applies, so they must not reach this turn's spans either.
          const ours =
            event.type === "public"
              ? framed !== null
              : event.type === "tool.called"
                ? publicIsOurs
                : event.type === "turn.ended" && turn !== undefined
                  ? event.turn.inputs.length === 0 ||
                    event.turn.inputs.includes(turn.uuid)
                  : true;
          if (turn?.closed === false && ours) turn.spans.onEvent(event);
          if (event.type === "public") {
            this.publisher?.publish([event.event], framed ?? null);
          } else if (event.type === "inputs.named") {
            this.frameTurn(event.inputs);
          } else if (event.type === "tool.called") {
            this.options.workspaceQuota?.observer.nudge();
            this.publisher?.toolCalled(event.toolCallId);
          } else if (event.type === "runtime.warning") {
            this.onWarning(event);
          } else if (event.type === "turn.ended") {
            this.options.workspaceQuota?.observer.nudge();
            await this.onTurnEnded(event.turn);
          } else if (event.type === "approval.requested") {
            this.onApprovalRequested(run, event.request);
          } else if (event.type === "approval.resolved") {
            this.pending?.withdraw(event.localId);
          }
        }
      } catch (error) {
        this.logger.warn("worker.stream.ended", { reason: describe(error) });
      } finally {
        const turn = this.turn;
        if (turn?.timedOut === true) {
          // The interrupt ended the stream rather than the turn: still the
          // timeout's outcome, and the drain it began becomes a failure.
          this.closeUnanswered(
            turn,
            "The engine stream ended after the turn ran out of time",
          );
        }
        // A stream that ended without a terminal leaves the turn's outcome
        // genuinely unknown; guessing either way would be a lie about the
        // transcript.
        this.settleTurn(
          unknownOutcome("The engine stream ended before the turn settled"),
        );
        // An engine that is gone accepts inputs it will never answer, so the
        // loop must not hand it another one. A no-op when shutdown closed it.
        this.stop({ kind: "failed", reason: "The engine stream ended" });
      }
    })();
  }

  private frameTurn(inputs: readonly string[] = []): string | null {
    const turn = this.turn;
    if (turn === undefined) return null;
    const { entered, turnId } = frameTurn(inputs, turn);
    turn.entered = entered;
    return turnId;
  }

  /** Absent while the port binds no mirror, so such a worker beats unchanged. */
  private transcriptReport(): TranscriptReport | undefined {
    const mirror = this.checkpoints.mirror?.();
    if (mirror === undefined) return undefined;
    return {
      persisted_at: mirror.persistedAt?.toISOString() ?? null,
      mirror_error: this.mirrorError ?? null,
    };
  }

  private onWarning(warning: RuntimeWarning): void {
    if (warning.kind !== "transcript_mirror_failed") return;
    // Latched for the run like the ledger's own: the engine has given up on
    // a batch, and no later write brings it back.
    if (this.mirrorError !== undefined) return;
    this.mirrorError = `Transcript mirror dropped a batch: ${
      typeof warning.detail.error === "string"
        ? warning.detail.error
        : "unspecified error"
    }`;
    // Recorded now rather than at the next interval: until the gateway
    // holds it, a checkpoint-less completion is still accepted.
    this.heartbeat?.beatNow();
    // Draining from here, not from the next loop boundary: the beat
    // carries it, so a poll already waiting is answered empty rather than
    // handed a turn that could not be checkpointed. A turn in flight still
    // finishes and is finalized.
    this.stop({ kind: "drain", reason: this.mirrorError });
  }

  /**
   * A promise only while an aborted terminal waits for its interrupt's
   * receipt: the pump awaits it before taking the next frame.
   */
  private onTurnEnded(ended: TurnEnded): Promise<void> | undefined {
    this.unsettledUsd += ended.cost.deltaUsd ?? 0;
    if (ended.cost.countRestarted && this.engineBudgeted) {
      // `/clear` starts the engine's count over, and the budget the claim
      // gave it with it: left running, the next turn could spend the whole
      // remainder again. The turn in flight is finalized; the next one waits
      // for a claim that brings what is really left.
      this.stop({
        kind: "drain",
        reason:
          "The engine started its cost count over, so its budget no longer bounds the session's",
      });
    }
    const turn = this.turn;
    if (turn === undefined) return;
    const attributed = ended.inputs;
    // A result that names other inputs belongs to a batch this turn is not
    // part of; one that names nothing settles nothing on its own.
    if (attributed.length > 0 && !attributed.includes(turn.uuid)) return;
    if (turn.timedOut && attributed.length === 0) {
      // As unproven as no answer at all, and the engine as untrusted.
      this.fail(
        `Turn ${turn.turnId} ran out of time, and the engine answered for no input`,
      );
    }
    // A turn already closed takes nothing: its settlement is a no-op, and the
    // cost stays for the turn that can still carry it.
    const cost = turn.closed ? {} : this.settleCost(ended);
    if (
      attributed.includes(turn.uuid) &&
      !turn.closed &&
      !turn.timedOut &&
      turn.interruptReceipt === "pending" &&
      ended.abortedByStop
    ) {
      // Closed now, cut once the receipt decides: until then the pump takes
      // no further frame (it awaits this), so the cut still lands right
      // after the terminal, with engine_stopped ahead of it if it applies.
      this.closeTurn(turn);
      return this.onceAnswered(turn, (acknowledged) => ({
        ...this.quotaTerminal(turn, terminalOf(ended, acknowledged)),
        ...cost,
      })).then((settlement) => this.cutTurn(turn, settlement));
    }
    this.settleTurn({
      ...(attributed.includes(turn.uuid)
        ? turn.timedOut
          ? // Whatever the engine says it ended with, the budget ended it.
            {
              ...terminalOf(ended, false),
              status: "failed",
              reason: "turn_timeout",
            }
          : this.quotaTerminal(
              turn,
              terminalOf(ended, turn.interruptReceipt === "acknowledged"),
            )
        : {
            status: "outcome_unknown",
            reason: turn.timedOut
              ? "turn_timeout"
              : "The engine reported a result it attributed to no input",
            result: ended.engineResult,
            usage: ended.usage ?? null,
          }),
      ...cost,
    });
  }

  private quotaTerminal(turn: Turn, terminal: Settlement): Settlement {
    if (
      !turn.quotaExceeded ||
      turn.interrupting ||
      turn.timedOut ||
      this.ownerLost ||
      terminal.status === "outcome_unknown"
    )
      return terminal;
    return {
      ...terminal,
      status: "failed",
      reason: TURN_WORKSPACE_QUOTA_EXCEEDED_REASON,
    };
  }

  /**
   * A turn whose own terminal carried no cost settles with none at all, not
   * zero, so the API can tell an unknown cost from a zero one. What other
   * terminals reported then waits for the next turn that does report.
   */
  private settleCost(ended: TurnEnded): { costUsd?: number } {
    if (ended.cost.unknown) return {};
    const costUsd = this.unsettledUsd;
    this.unsettledUsd = 0;
    return { costUsd };
  }

  private onApprovalRequested(run: AgentRun, request: ApprovalRequested): void {
    const answer = async (
      decision: ApprovalDecisionPayload,
    ): Promise<AnswerResult> => {
      const result = await run.answer({
        ...decision,
        localId: request.localId,
        inputHash: request.inputHash,
      });
      if (result === "unknown") {
        this.logger.warn("worker.approval.answer_unknown", {
          local_id: request.localId,
          tool_call_id: request.toolCallId,
          decision: decision.kind,
        });
      }
      return result;
    };
    if (this.stopping !== undefined || this.pending === undefined) {
      void answer({
        kind: "cancelled",
        reason: "shutdown",
        message: "This worker is winding down and cannot ask for approval",
      });
      return;
    }
    // The interrupt voided the turn's callbacks; one raised after it is no
    // different, and asking would only hold the turn open again.
    if (this.turn?.interrupting === true || this.turn?.closed === true) {
      void answer({
        kind: "cancelled",
        reason: "interrupt",
        message: "The turn was interrupted",
      });
      return;
    }
    const grant = this.takeGrant(request);
    if (grant !== undefined) {
      this.pending.bind(request.localId, grant.request_id);
      this.turn?.spans.granted(request.localId);
      void answer({
        kind: "selected",
        optionKind: "allow_once",
        ...(grant.remember_offer === undefined
          ? {}
          : {
              remember: {
                scope: "session" as const,
                rules: grant.remember_offer.map((rule) => ({
                  toolName: rule.tool_name,
                  ...(rule.rule_content === undefined
                    ? {}
                    : { ruleContent: rule.rule_content }),
                })),
              },
            }),
      }).then(
        (result) => this.grantAnswered(grant, result),
        () => this.grantAnswered(grant, "stale"),
      );
      return;
    }
    this.pending.request(request, answer, this.approvalCheckpointer(run));
  }

  /**
   * Captures the run as it waits on a person, holding the checkpoint lease
   * until the registration that carries it is settled; undefined when the
   * run takes no such checkpoints.
   */
  private approvalCheckpointer(run: AgentRun): ApprovalCheckpointer {
    return async (waiting) => {
      const { effective } = await run.ready();
      if (!effective.approvalCheckpoint || this.mirrorError !== undefined) {
        return null;
      }
      const scope = { ...this.scope };
      if (scope.turn_id === null || this.pending === undefined) return null;
      if (Buffer.byteLength(JSON.stringify(waiting)) > PARKED_STATE_MAX_BYTES) {
        return null;
      }
      const startedAt = performance.now();
      const { lease, preparation } = await run.leaseCheckpoint("approval_wait");
      if (lease === null) {
        this.logger.info("worker.approval_checkpoint.skipped", {
          reason: preparation.reason,
          detail: preparation.detail,
        });
        return null;
      }
      // Taken with the lease: an answer applied after this may have let a
      // tool run that the capture does not hold.
      const answersThrough = this.pending.answersThrough;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(
          () => resolve("late"),
          Math.max(
            0,
            (this.options.approvalCheckpointMs ?? APPROVAL_CHECKPOINT_MS) -
              (performance.now() - startedAt),
          ),
        );
      });
      let ref: CheckpointRef | null | "late";
      try {
        ref = await Promise.race([
          this.checkpoints.capture(preparation, {
            scope,
            recheck: () => run.prepareCheckpoint("approval_wait"),
            workerState: { pendingApprovals: waiting },
          }),
          late,
        ]);
      } catch (error) {
        lease.release();
        this.logger.warn("worker.approval_checkpoint.failed", {
          reason: describe(error),
        });
        return null;
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (ref === null || ref === "late") {
        // Nothing carries it, so nothing can commit it.
        lease.release();
        this.logger.warn("worker.approval_checkpoint.skipped", {
          reason: ref === null ? "capture_refused" : "deadline",
          elapsed_ms: elapsedMs,
        });
        return null;
      }
      this.logger.info("worker.approval_checkpoint.captured", {
        revision: ref.revision,
        elapsed_ms: elapsedMs,
      });
      const manifestRef = ref.manifest_ref;
      let settled = false;
      return {
        ref: { ...ref, answers_through: answersThrough },
        settle: (maybeCommitted) => {
          if (settled) return;
          settled = true;
          // The hold goes up before the lease comes down: no tool starts
          // in between unguarded.
          if (maybeCommitted) this.guardAdmissions(run, manifestRef);
          lease.release();
        },
      };
    };
  }

  /** Voids `manifestRef` before the run admits its next tool. */
  private guardAdmissions(run: AgentRun, manifestRef: string): void {
    this.approvalCheckpoints.push(manifestRef);
    if (this.admissionHold !== undefined) return;
    if (run.holdAdmission === undefined) {
      throw new Error(
        "An approval checkpoint was taken from a run that admits tools through no gate a host can hold",
      );
    }
    const hold = run.holdAdmission(async () => {
      while (this.approvalCheckpoints.length > 0) {
        const [next] = this.approvalCheckpoints;
        if (next === undefined) break;
        await this.options.gateway.invalidateApprovalCheckpoint({
          ...this.scope,
          manifest_ref: next,
        });
        this.approvalCheckpoints = this.approvalCheckpoints.filter(
          (ref) => ref !== next,
        );
      }
      if (this.admissionHold === hold) {
        this.admissionHold = undefined;
        hold.release();
      }
    });
    this.admissionHold = hold;
  }

  /** The turn is over: what it waited on can no longer be resumed from. */
  private endApprovalCheckpoints(): void {
    this.approvalCheckpoints = [];
    this.admissionHold?.release();
    this.admissionHold = undefined;
  }

  /**
   * The allow a parked request was answered with, spent on the first call
   * of the resumed turn with the same tool and arguments. A second such
   * call, or one with other arguments, is asked again.
   */
  private takeGrant(request: ApprovalRequested): PermissionGrant | undefined {
    const turn = this.turn;
    if (turn === undefined || request.kind !== "permission") return undefined;
    const index = this.grants.findIndex(
      (grant) =>
        grant.turn_id === turn.turnId &&
        grant.tool === request.tool.name &&
        grant.input_hash === request.inputHash,
    );
    if (index === -1) return undefined;
    return this.grants.splice(index, 1)[0];
  }

  /**
   * A stale allow never reached the engine, so the grant is still there for
   * the next such call, or unused if its turn is already over. An unknown
   * one may have let the tool run, so it counts as spent.
   */
  private grantAnswered(grant: PermissionGrant, result: AnswerResult): void {
    if (result !== "stale") {
      this.logger.info("worker.grant.consumed", {
        turn_id: grant.turn_id,
        request_id: grant.request_id,
      });
      this.pending?.deliver(grant.request_id, "grant_consumed");
      return;
    }
    if (this.turn?.turnId === grant.turn_id && this.turn.closed !== true) {
      this.grants.push(grant);
      return;
    }
    this.pending?.deliver(grant.request_id, "grant_unused");
  }

  /** What the turn did not spend is reported unused, once it is finalized. */
  private dropGrants(turnId: string): void {
    for (const grant of this.grants.filter((g) => g.turn_id === turnId)) {
      this.pending?.deliver(grant.request_id, "grant_unused");
    }
    this.grants = this.grants.filter((grant) => grant.turn_id !== turnId);
  }

  /**
   * Takes the checkpoint lease with the verdict, so nothing
   * writes between the quiescence check and the pointer CAS. A capture that
   * fails or produces nothing to commit gives the lease back at once.
   */
  private async capture(
    run: AgentRun,
    workerState?: WorkerCheckpointState,
  ): Promise<Captured> {
    // A run that takes no checkpoints finalizes without one, not as a
    // capture that failed.
    const { effective } = await run.ready();
    if (!effective.checkpoint) return { lease: null, ref: null };
    const { lease, preparation: runPreparation } =
      await run.leaseCheckpoint("turn_end");
    let ref: CheckpointRef | null;
    try {
      const deadline = performance.now() + CHECKPOINT_PROCESS_GRACE_MS;
      let descendants =
        runPreparation.status === "ready"
          ? ((await this.options.engines?.descendants?.()) ?? [])
          : [];
      // Startup helpers may briefly outlive the terminal frame. Keep the lease
      // while waiting, and refuse any process still present at the deadline.
      while (descendants.length > 0) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await this.sleep(Math.min(CHECKPOINT_PROCESS_POLL_MS, remaining));
        descendants = (await this.options.engines?.descendants?.()) ?? [];
      }
      const preparation: CheckpointPreparation =
        descendants.length === 0
          ? runPreparation
          : {
              status: "rejected",
              reason: "background_writer",
              detail: `Engine process tree still has background processes: ${descendants.join(", ")}`,
            };
      if (preparation.status === "rejected") {
        this.logger.warn("worker.checkpoint.rejected", {
          reason: preparation.reason,
          detail: preparation.detail,
        });
      }
      ref = await this.checkpoints.capture(preparation, {
        scope: { ...this.scope },
        recheck: () => run.prepareCheckpoint("turn_end"),
        ...(workerState === undefined ? {} : { workerState }),
      });
    } catch (error) {
      lease?.release();
      throw error;
    }
    if (ref === null) lease?.release();
    return { lease, ref };
  }

  /**
   * Every decision below reads the current stop rather than the one this
   * began with: a heartbeat, a poll or an event write can each learn the
   * lease is gone while shutdown waits on something else.
   */
  private async shutdown(run: AgentRun | undefined): Promise<void> {
    this.pending?.cancelAll(
      "shutdown",
      this.ownerLost
        ? "This worker no longer owns the session"
        : "This worker is shutting down",
    );
    if (run !== undefined && this.turn !== undefined) {
      // Whatever is still open here has already used up its drain budget, or
      // belongs to a lease this attempt no longer holds.
      const settledInTime =
        !this.ownerLost && (await settledWithin(this.turn.settled, 0));
      if (!settledInTime) {
        // Not awaited: a wedged engine may never answer the interrupt, and
        // the terminal frame, bounded below, is what this is waiting for.
        run.interrupt().catch((error) => {
          this.logger.warn("worker.interrupt.failed", {
            reason: describe(error),
          });
        });
        await settledWithin(
          this.turn.settled,
          this.shutdownWait(INTERRUPT_GRACE_MS),
        );
      }
    }
    // No checkpoint is taken here. One only becomes durable riding a turn's
    // finalize, and a turn given up on the way out is not finalized; an idle
    // worker leaves the last committed checkpoint as the one to resume from.
    // A session-level checkpoint commit would change that, and alpha has none.
    const closing = run?.close().catch((error) => {
      this.logger.warn("worker.close.failed", { reason: describe(error) });
    });
    // Bounded for the same reason: a wedged engine may never end its stream
    // or finish closing, and the exit check below is what deals with that.
    const ending = [this.pumping, closing].filter(
      (step): step is Promise<void> => step !== undefined,
    );
    if (ending.length > 0) {
      await settledWithin(
        Promise.all(ending),
        this.shutdownWait(ENGINE_EXIT_GRACE_MS),
      );
    }
    await this.confirmEngineExit();
    // A restore still replacing the workspace should not outlive the
    // release: the next attempt restores into the same root. The abort
    // reaches it at its next step, and the port starts no file work after
    // it, so this waits out only a step already under way. One still out
    // past that is waiting on the network, not writing; the process exits
    // right after the release, which ends it either way.
    if (
      this.restoring !== undefined &&
      !(await settledWithin(
        this.restoring,
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      ))
    ) {
      this.logger.warn("worker.restore.unsettled", {
        reason: "the restore had not stopped by the release",
      });
    }
    const releasable = await this.settleBeforeRelease();
    // Beating until here, not only until the engine is gone: the event tail
    // and the pending flush can outlast the lease, and one that lapses
    // meanwhile is fenced by the reconciler with the turn unknown.
    if (this.heartbeat !== undefined) {
      await settledWithin(
        this.heartbeat.stop(),
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
    }
    if (!releasable || this.reportedOwnerLost()) return;
    // The pause commit was the release.
    if (this.released) return;
    this.released = true;
    const request: ReleaseRequest = {
      ...this.scope,
      turn_id: null,
      // The session shows it when a restore keeps failing.
      reason: this.scrubber.scrub(this.stopping?.reason ?? "loop ended"),
    };
    const gateway = this.options.gateway;
    // A startup a signal cut short is not a failed one.
    const releasing = (
      this.stopping?.kind === "drain" && this.stopping.requested
        ? gateway
            .release({ ...request, stop_kind: "drain" })
            .catch((error: unknown) => {
              // A strict gateway older than this worker refuses the field
              // . The session is still handed back without it, which
              // that gateway counts as it counted every stop before
              // a lapsed lease would count it all the same, only later.
              if (
                !(error instanceof WorkerGatewayRequestError) ||
                error.code !== "BAD_REQUEST"
              ) {
                throw error;
              }
              this.logger.warn("worker.release.stop_kind_refused", {
                reason: error.message,
              });
              return gateway.release(request);
            })
        : gateway.release(request)
    )
      .then((response) => {
        this.logger.info("worker.released", { released: response.released });
        // Superseded by the pause release a stop gave up on.
        if (!response.released && this.pauseReleasing !== undefined) {
          this.presumePaused("The final release found the epoch moved on");
        }
      })
      .catch((error) => {
        if (this.showsPauseCommit(error)) {
          this.presumePaused(
            `The final release was refused: ${describe(error)}`,
          );
          return;
        }
        this.logger.warn("worker.release.failed", { reason: describe(error) });
      });
    // The release keeps its reserve; past the grace the SIGKILL ends it anyway.
    const releaseBudget = this.withinGrace(
      this.options.timeouts.requestTimeoutMs,
      0,
    );
    if (!(await settledWithin(releasing, releaseBudget))) {
      this.logger.warn("worker.release.failed", {
        reason: "The stop grace ran out before the gateway answered",
      });
    }
    // After the release, never before: an ingest that has stalled costs the
    // spans still queued, not the session's hand-back.
    await this.tracing?.shutdown(TELEMETRY_SHUTDOWN_MS);
  }

  /**
   * Everything the attempt still owes the gateway before it lets the session
   * go: false when it may not be let go at all.
   */
  private async settleBeforeRelease(): Promise<boolean> {
    // No durable write survives owner loss: not the event tail, not the
    // in-flight turn, not the release.
    if (this.reportedOwnerLost()) return false;
    if (!(await this.mirrorErrorRecorded())) return false;
    const flushed = await this.untilAbandoned(
      (this.publisher?.idle() ?? Promise.resolve()).then(
        () => true,
        (error) => {
          this.logger.warn("worker.events.undelivered", {
            reason: describe(error),
          });
          return false;
        },
      ),
    );
    if (flushed === undefined) {
      this.publisher?.abandon("The drain budget ran out");
      this.logger.warn("worker.events.undelivered", {
        reason: "The drain budget ran out",
      });
    }
    if (this.reportedOwnerLost()) return false;
    // How each request ended decides its answer's receipt; once released,
    // the gateway can only call the undelivered ones unknown.
    await this.pending?.flush(
      this.withinGrace(this.options.timeouts.requestTimeoutMs),
    );
    // What did not land by now never will; nothing may keep retrying past
    // the release.
    this.pending?.stop();
    return true;
  }

  /**
   * A latched `mirror_error` is recorded before the session is handed back:
   * released without it, the next attempt resumes a checkpoint the gateway
   * still trusts, missing the batch that was lost. One more beat is tried;
   * failing that the lease is left to lapse rather than released as if this
   * attempt had left the session in order.
   */
  private async mirrorErrorRecorded(): Promise<boolean> {
    const heartbeat = this.heartbeat;
    if (this.mirrorError === undefined || heartbeat === undefined) return true;
    if (!heartbeat.mirrorErrorRecorded) {
      await settledWithin(
        heartbeat.beatOnce(),
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
    }
    if (heartbeat.mirrorErrorRecorded) return true;
    this.logger.error("worker.mirror_error.unrecorded", {
      reason: this.mirrorError,
    });
    return false;
  }

  private reportedOwnerLost(): boolean {
    if (this.stopping?.kind !== "lost") return false;
    this.logger.warn("worker.ownership.lost", { reason: this.stopping.reason });
    return true;
  }

  /**
   * The stream ending says the engine stopped talking, not that its process
   * is gone. Only the observed exit says that, so a straggler past the grace
   * period is killed rather than left running behind this process.
   */
  private async confirmEngineExit(): Promise<void> {
    const engines = this.options.engines;
    if (engines === undefined) return;
    if (await engines.exited(this.shutdownWait(ENGINE_EXIT_GRACE_MS))) {
      this.logger.info("worker.engine.exited", {});
      return;
    }
    const lingering = engines.running;
    this.logger.error("worker.engine.lingering", { pids: lingering });
    engines.kill();
    const killed = await engines.exited(this.withinGrace(ENGINE_EXIT_GRACE_MS));
    this.logger[killed ? "warn" : "error"]("worker.engine.killed", {
      pids: lingering,
      exited: killed,
    });
  }

  /**
   * How long the engine gets to wind down by itself. None once the lease is
   * gone: another attempt may already own the workspace, and whatever the
   * engine does meanwhile is unfenced, so it is killed rather than waited on.
   */
  private shutdownWait(ms: number): number {
    return this.ownerLost ? 0 : this.withinGrace(ms);
  }

  /**
   * A shutdown wait, cut to what the launcher's stop grace still allows so
   * the release at the end is not the part the SIGKILL takes away.
   */
  private withinGrace(ms: number, reserve = RELEASE_RESERVE_MS): number {
    const grace = this.options.timeouts.stopGraceMs;
    if (grace === undefined || this.stoppedAt === undefined) return ms;
    const left = this.stoppedAt + grace - reserve - performance.now();
    return Math.max(0, Math.min(ms, left));
  }

  /**
   * Resolves with the value, or undefined once a stop has come and the
   * request still has not answered within what the grace leaves for it.
   * Waiting on a stop at all is deliberate: a claim that lands is one this
   * worker can still release, rather than one left to lapse.
   */
  private async untilStopGraceSpent<T>(
    work: Promise<T>,
  ): Promise<T | undefined> {
    return until(
      work,
      this.stopped.then(() =>
        settledWithin(
          work,
          this.withinGrace(this.options.timeouts.requestTimeoutMs),
        ),
      ),
    );
  }

  /** Resolves with the value, or undefined once any stop has come. */
  private async untilStopped<T>(work: Promise<T>): Promise<T | undefined> {
    return until(work, this.stopped);
  }

  /**
   * A budget for a stage the turn deadline does not cover. The heartbeat
   * extends the lease on its own clock whatever the stage is doing, so one
   * that never ends would hold the session forever. Expiry fails
   * the worker, unless a stop is already under way: a drain keeps its outcome.
   */
  private stageBudget(stage: string, ms: number) {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.logger.error("worker.stage.timeout", { stage, budget_ms: ms });
        this.stop({
          kind: "failed",
          reason: `${stage} ran past its ${ms / 1000}s budget`,
        });
        resolve();
      }, ms);
    });
    return {
      disarm: () => clearTimeout(timer),
      expired,
      hasExpired: () => timedOut,
    };
  }

  /** Resolves with the value, or undefined once the turn has to be given up. */
  private async untilAbandoned<T>(work: Promise<T>): Promise<T | undefined> {
    return until(work, this.abandoned);
  }

  /**
   * Retries a transient failure until `giveUp` says the result is no longer
   * wanted: by default any stop, but a finalize keeps trying for as long as
   * the drain budget lasts.
   */
  private async withRetry<T>(
    call: () => Promise<T>,
    giveUp: () => boolean = () => this.stopping !== undefined,
  ): Promise<T> {
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.lose(describe(error), error);
          throw error;
        }
        if (!isRetryable(error) || giveUp()) throw error;
        this.logger.warn("worker.gateway.retry", { reason: describe(error) });
        await this.sleep(GATEWAY_RETRY_MS);
        // What gave up during the backoff sends nothing more.
        if (giveUp()) throw error;
      }
    }
  }
}

type Captured = { lease: CheckpointLease | null; ref: CheckpointRef | null };

/**
 * A stable UUID for one delivered input. Derived rather than random so the
 * same queue row always reaches the engine under the same identity.
 */
export function inputUuid(
  sessionId: string,
  turnId: string,
  inputId: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}:${turnId}:${inputId}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  // Shaped like a name-based UUID so anything that validates the field accepts
  // it; the namespace is this function, not RFC 4122's.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RuntimeWarning = Extract<RuntimeEvent, { type: "runtime.warning" }>;

/**
 * The turn an event is stored under, and whether the engine has shown it
 * took the turn's input up. `inputs` are the ones the event's engine message
 * is for: an engine names an input from the moment it queues one, so an
 * event naming none says nothing of its own. An event for another input
 * belongs to no turn, before this one's input is named and after, and so
 * does one past the terminal.
 */
export function frameTurn(
  inputs: readonly string[],
  turn: { closed: boolean; entered: boolean; turnId: string; uuid: string },
): { entered: boolean; turnId: string | null } {
  const entered = turn.entered || (!turn.closed && inputs.includes(turn.uuid));
  const ours =
    !turn.closed &&
    entered &&
    (inputs.length === 0 || inputs.includes(turn.uuid));
  return { entered, turnId: ours ? turn.turnId : null };
}

/**
 * `interruptAcknowledged` is the worker's own fact that the engine took its
 * interrupt for this turn. An aborted terminal without it is some other
 * abort, and a turn that finished before the interrupt landed keeps the
 * outcome it reached.
 */
function terminalOf(
  ended: TurnEnded,
  interruptAcknowledged: boolean,
): Settlement {
  const interrupted = interruptAcknowledged && ended.abortedByStop;
  const status: WorkerTerminalStatus = interrupted
    ? "interrupted"
    : ended.isError
      ? "failed"
      : "completed";
  return {
    status,
    reason: status === "completed" ? null : failureReason(ended),
    result: ended.engineResult,
    usage: ended.usage ?? null,
  };
}

function failureReason(ended: TurnEnded): string {
  // The engine's budget is the session's remaining one, so this is the same
  // limit the gateway enforces between turns, reached inside one.
  if (ended.budgetExceeded) return TURN_BUDGET_EXCEEDED_REASON;
  // The proxy's refusal of a spent session stays the engine's own reason:
  // finalize judges it against the session's spend, which no wording of
  // the refusal can get wrong.
  return ended.failure?.reason ?? "error";
}

function clearTurnTimers(turn: Turn): void {
  for (const timer of turn.timers.splice(0)) clearTimeout(timer);
}

/**
 * A terminal this worker decided because the engine gave none it can
 * trust; `ended` keeps what the engine did report.
 */
function unknownOutcome(
  reason: string,
  ended: Pick<Settlement, "costUsd" | "result" | "usage"> = {
    result: null,
    usage: null,
  },
): Settlement {
  return { ...ended, reason, status: "outcome_unknown", synthetic: true };
}

function releaseReason(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "INCOMPATIBLE_CHECKPOINT"
  ) {
    return "incompatible_checkpoint";
  }
  return describe(error);
}
