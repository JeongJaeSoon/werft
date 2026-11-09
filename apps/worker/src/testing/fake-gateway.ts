import {
  type ApiErrorCode,
  type AppendEventsRequest,
  type AppendEventsResponse,
  type BootstrapClaimRequest,
  type BootstrapClaimResponse,
  budgetEndedTerminal,
  type CheckpointRef,
  type CheckpointRequest,
  type CheckpointRequestResponse,
  type ControlIntent,
  type FinalizeRequest,
  type FinalizeResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type InvalidateApprovalCheckpointRequest,
  type InvalidateApprovalCheckpointResponse,
  type NextInputRequest,
  type NextInputResponse,
  type ParkDeclinedRequest,
  type ParkDeclinedResponse,
  type ParkedDelivery,
  type PendingControlRequest,
  type PendingControlResponse,
  type PendingSettlement,
  type PermissionGrant,
  type PostSessionAnswerRequest,
  type RegisterPendingRequest,
  type RegisterPendingResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type RepositoryAttachOrder,
  type RepositoryAttachResult,
  type RestorePlanRequest,
  type RestorePlanResponse,
  type RuntimeConfig,
  type SessionEventPayload,
  type SessionRuntime,
  type WorkerEvent,
  type WorkerReadyRequest,
  type WorkerReadyResponse,
  type WorkspaceDescriptor,
} from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";

import type { WorkerGatewaySession } from "../worker-host.ts";

/** What the fake claim hands out for the object store route. */
export const FAKE_OBJECT_STORE_TOKEN = "weo_fake-object-store-token";

/**
 * The checkpoint half of the gateway, for a test that binds it to the real
 * CheckpointService. `commit` runs for a first-time finalize that carries a
 * checkpoint, before the turn is recorded; throwing refuses the finalize.
 */
export type FakeCheckpointProtocol = {
  commit(
    request: FinalizeRequest & { checkpoint: CheckpointRef },
  ): Promise<void>;
  requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse>;
  restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse>;
};

export type FakeWorkerGatewayOptions = {
  attemptId?: string;
  /** Absent: an in-memory pointer that accepts any checkpoint at the next revision. */
  checkpoints?: FakeCheckpointProtocol;
  /** Where this session's turn numbering carries on from. */
  firstTurn?: number;
  leaseTtlMs?: number;
  /** The owner partition the claim names as the checkpoint principal. */
  ownerScope?: string;
  /** What the claim says the session has left to spend; null for none. */
  remainingBudgetUsd?: number | null;
  restore?: CheckpointRef | null;
  runtime?: SessionRuntime;
  runtimeConfig?: RuntimeConfig;
  sessionId?: string;
  /** The repository the claim names; a placeholder nothing clones by default. */
  workspace?: WorkspaceDescriptor;
};

type CoAuthor = { name: string; email: string } | null;
type Queued = {
  inputId: string;
  message: string;
  turnId: string;
  coAuthor?: CoAuthor;
};

/**
 * An in-memory stand-in for the Worker Gateway that keeps the parts of the
 * protocol a worker can get wrong: the event stream refuses a gap the way the
 * real `commitEventsAtomic` does, finalize is idempotent per key, and answers
 * only come back through `pendingControl`.
 *
 * It ships next to the worker rather than in testkit because the direct-local
 * suite and the unit suite both drive it, and testkit may not be a runtime
 * dependency of an app.
 */
export class FakeWorkerGateway implements WorkerGatewaySession {
  readonly batches: AppendEventsRequest[] = [];
  readonly calls: string[] = [];
  /** Every pending-control poll, as sent. */
  readonly pollRequests: PendingControlRequest[] = [];
  readonly events: WorkerEvent[] = [];
  readonly finalized: FinalizeRequest[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly readies: WorkerReadyRequest[] = [];
  readonly releases: ReleaseRequest[] = [];
  /** Every registration that landed, in order, keyed by nothing: replays repeat. */
  readonly registrations: RegisterPendingRequest[] = [];
  /** Every park the worker declined, in order. */
  readonly parkDeclines: ParkDeclinedRequest[] = [];
  readonly invalidations: InvalidateApprovalCheckpointRequest[] = [];
  /** Set, invalidateApprovalCheckpoint throws it. */
  invalidationFailure: Error | undefined;
  /** Thrown by the next registerPending calls, one each, after recording them. */
  readonly registerFailures: Error[] = [];
  /** How each parked request's answer reached the turn that resumed it. */
  readonly delivered: ParkedDelivery[] = [];
  /** Handed to the claim as its `grants`; absent while empty. */
  grants: PermissionGrant[] = [];
  /** How each registered request ended, as the worker reported it. */
  readonly settled: PendingSettlement[] = [];
  credential: string | undefined;
  /** Set to make the next heartbeat answer with this code. */
  heartbeatFailure: ApiErrorCode | undefined;
  /** Reported back by every heartbeat; raising it fences the worker out. */
  authRevision = 0;
  /**
   * What the gateway does for a draining attempt: hand it no new input.
   * Cleared, it stands in for a poll that read the queue before the draining
   * heartbeat committed.
   */
  refuseDraining = true;
  /** Set to answer every poll, and record each finalize, the way the gateway does for a session past its cost limit. */
  overBudget = false;
  private draining = false;
  /** Set by an `outcome_unknown` terminal: the real gateway holds input back then. */
  private recoveryRequired = false;
  /** Thrown by every append while set. */
  appendFailure: WorkerGatewayRequestError | undefined;
  /** Thrown by every first-time finalize while set. */
  finalizeFailure: WorkerGatewayRequestError | undefined;
  /** Handed out by every pendingControl poll while set. */
  control: ControlIntent | null = null;
  /** Attachments handed out by every poll until a report names them. */
  attachOrders: RepositoryAttachOrder[] = [];
  /** Every attachment report the worker sent, resent ones included. */
  readonly attachReports: RepositoryAttachResult[] = [];
  /** Thrown by a release that answers a pause while set, as a refusal would be. */
  pauseRefusal: WorkerGatewayRequestError | undefined;
  /** Set to refuse `stop_kind` the way a strict gateway older than it does. */
  predatesStopKind = false;
  /** Every checkpoint request the worker made, rejected ones included. */
  readonly checkpointRequests: CheckpointRequest[] = [];
  readonly restorePlans: RestorePlanRequest[] = [];
  /** The in-memory pointer, when no protocol is bound: null until a commit. */
  checkpointRevision: number | null = null;
  private readonly checkpointProtocol: FakeCheckpointProtocol | undefined;
  /** Thrown by the ready report while set, as a failed resume would be. */
  readyFailure: WorkerGatewayRequestError | undefined;

  private readonly controls: ControlIntent[] = [];
  private readonly answers: Array<{
    answer: PostSessionAnswerRequest;
    sequence: number;
    input_hash: string;
  }> = [];
  private readonly options: Required<
    Omit<FakeWorkerGatewayOptions, "checkpoints" | "restore" | "workspace">
  > &
    Pick<FakeWorkerGatewayOptions, "restore" | "workspace">;
  private readonly queue: Queued[] = [];
  private acceptedThrough = 0;
  private nextTurn: number;
  private waiting: Array<() => void> = [];

  constructor(options: FakeWorkerGatewayOptions = {}) {
    this.nextTurn = options.firstTurn ?? 1;
    this.checkpointProtocol = options.checkpoints;
    this.options = {
      attemptId: options.attemptId ?? "att_fake",
      firstTurn: options.firstTurn ?? 1,
      leaseTtlMs: options.leaseTtlMs ?? 30_000,
      ownerScope: options.ownerScope ?? "fake-owner",
      remainingBudgetUsd:
        options.remainingBudgetUsd === undefined
          ? 25
          : options.remainingBudgetUsd,
      restore: options.restore ?? null,
      runtime: options.runtime ?? {
        kind: "claude_agent_sdk",
        version: "0.3.319",
        profile_id: "fake-profile",
      },
      runtimeConfig: options.runtimeConfig ?? {
        model: "fake-model",
        tools: [],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "http://127.0.0.1:4000",
          auth: { kind: "egress_token", token: "placeholder" },
        },
      },
      sessionId: options.sessionId ?? "11111111-1111-4111-8111-111111111111",
      ...(options.workspace === undefined
        ? {}
        : { workspace: options.workspace }),
    };
  }

  /** Puts one message on the session queue and returns the turn it became. */
  enqueue(message: string, options: { coAuthor?: CoAuthor } = {}): string {
    const turnId = String(this.nextTurn);
    this.nextTurn += 1;
    this.queue.push({
      inputId: `msg-${turnId}`,
      message,
      turnId,
      ...(options.coAuthor === undefined ? {} : { coAuthor: options.coAuthor }),
    });
    for (const wake of this.waiting.splice(0)) wake();
    return turnId;
  }

  /**
   * Makes an answer available to the next `pendingControl` poll, bound to
   * the arguments the request was registered with, as the real one is.
   */
  answer(answer: PostSessionAnswerRequest): void {
    const registered = this.registrations.find(
      (entry) => entry.request_id === answer.request_id,
    );
    this.answers.push({
      answer,
      sequence: this.answers.length + 1,
      input_hash: registered?.input_hash ?? "0".repeat(64),
    });
  }

  /**
   * Stores an interrupt intent for a turn. Like the real gateway it is
   * handed out on every poll until its turn is finalized, which settles it.
   */
  interrupt(turnId: string): ControlIntent {
    const control: ControlIntent = {
      control_id: `ctl-${this.controls.length + 1}`,
      kind: "interrupt",
      target_turn_id: turnId,
      issued_at: new Date().toISOString(),
    };
    this.controls.push(control);
    return control;
  }

  /** The id the worker gave the callback the engine raised for this tool use. */
  requestIdFor(toolUseId: string): string {
    const event = this.questions().find(
      (candidate) =>
        candidate.event === "question" &&
        candidate.data.tool_use_id === toolUseId,
    );
    if (event?.event !== "question") {
      throw new Error(`No question event for ${toolUseId}`);
    }
    return event.data.request_id;
  }

  /** The registrations the worker made, newest last, without replays. */
  registered(): RegisterPendingRequest[] {
    return this.registrations.filter(
      (entry, index) =>
        this.registrations.findIndex(
          (other) => other.request_id === entry.request_id,
        ) === index,
    );
  }

  /**
   * The `question` events the gateway wrote for this attempt's
   * registrations, in stream order, as the real one does with the row.
   */
  questions(): SessionEventPayload[] {
    return this.registered().flatMap((entry) =>
      entry.announce === undefined
        ? []
        : [
            {
              event: "question" as const,
              data: {
                request_id: entry.request_id,
                tool_use_id: entry.announce.tool_use_id,
                kind: entry.request.kind,
                tool: entry.announce.tool,
                input:
                  entry.request.kind === "permission"
                    ? entry.request.input
                    : { questions: entry.request.questions },
              },
            },
          ],
    );
  }

  useCredential(credential: string): void {
    this.credential = credential;
    this.calls.push("useCredential");
  }

  async bootstrapClaim(
    request: BootstrapClaimRequest,
  ): Promise<BootstrapClaimResponse> {
    this.calls.push("bootstrapClaim");
    return {
      session_id: this.options.sessionId,
      turn_id: null,
      attempt_id: this.options.attemptId,
      lease_epoch: 1,
      execution_generation: request.execution_generation,
      auth_revision: this.authRevision,
      session_credential: "wsc_fake",
      lease_expires_at: this.leaseExpiresAt(),
      lease_remaining_ms: this.options.leaseTtlMs,
      runtime: this.options.runtime,
      profile_fingerprint: `sha256:${"0".repeat(64)}`,
      runtime_config: this.options.runtimeConfig,
      workspace: this.options.workspace ?? {
        repository: {
          id: "fake-repository",
          url: "https://git.example.test/fake.git",
          branch: "main",
        },
      },
      object_store: {
        access: { kind: "egress_token", token: FAKE_OBJECT_STORE_TOKEN },
      },
      principal: { owner_scope: this.options.ownerScope },
      restore: this.options.restore ?? null,
      remaining_budget_usd: this.options.remainingBudgetUsd,
      ...(this.grants.length === 0 ? {} : { grants: [...this.grants] }),
    };
  }

  async nextInput(request: NextInputRequest): Promise<NextInputResponse> {
    this.calls.push("nextInput");
    if (this.overBudget) {
      return {
        input: null,
        lease_expires_at: this.leaseExpiresAt(),
        draining: true,
        reason: "BUDGET_EXCEEDED",
      };
    }
    // Like the real gateway, a draining attempt's poll comes back at once.
    const handsNothing =
      (this.draining && this.refuseDraining) || this.recoveryRequired;
    if (
      !handsNothing &&
      this.queue.length === 0 &&
      (request.wait_ms ?? 0) > 0
    ) {
      await Promise.race([
        new Promise<void>((resolve) => this.waiting.push(resolve)),
        Bun.sleep(request.wait_ms ?? 0),
      ]);
    }
    const next = handsNothing ? undefined : this.queue.shift();
    return {
      input:
        next === undefined
          ? null
          : {
              turn_id: next.turnId,
              input_id: next.inputId,
              message: next.message,
              delivery_started_at: new Date().toISOString(),
              ...(next.coAuthor === undefined
                ? {}
                : { co_author: next.coAuthor }),
            },
      lease_expires_at: this.leaseExpiresAt(),
    };
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.calls.push("heartbeat");
    this.heartbeats.push(request);
    if (request.attempt_state === "draining") {
      this.draining = true;
      if (this.refuseDraining) {
        for (const wake of this.waiting.splice(0)) wake();
      }
    }
    if (this.heartbeatFailure !== undefined) {
      throw new WorkerGatewayRequestError(
        this.heartbeatFailure === "UNAUTHORIZED" ? 401 : 409,
        this.heartbeatFailure,
        `heartbeat failed with ${this.heartbeatFailure}`,
        false,
      );
    }
    return {
      lease_expires_at: this.leaseExpiresAt(),
      lease_remaining_ms: this.options.leaseTtlMs,
      auth_revision: this.authRevision,
      control_pending: this.control !== null || this.attachOrders.length > 0,
    };
  }

  async appendEvents(
    request: AppendEventsRequest,
  ): Promise<AppendEventsResponse> {
    this.calls.push("appendEvents");
    if (this.appendFailure !== undefined) throw this.appendFailure;
    for (const event of request.events) {
      if (event.source_sequence !== this.acceptedThrough + 1) {
        throw new WorkerGatewayRequestError(
          400,
          "BAD_REQUEST",
          `Events must continue the durable prefix; resume from source_sequence ${this.acceptedThrough + 1}`,
          false,
        );
      }
      this.acceptedThrough = event.source_sequence;
      this.events.push(event);
    }
    this.batches.push(request);
    return {
      accepted_through: this.acceptedThrough,
      cursor: `cursor-${this.acceptedThrough}`,
    };
  }

  async registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    this.calls.push("registerPending");
    this.registrations.push(request);
    const failure = this.registerFailures.shift();
    if (failure !== undefined) throw failure;
    return {
      request_id: request.request_id,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      expires_in_ms: 30 * 60_000,
    };
  }

  async pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse> {
    this.calls.push("pendingControl");
    this.pollRequests.push(request);
    for (const item of request.delivered ?? []) {
      if (
        !this.delivered.some(
          (done) =>
            done.request_id === item.request_id &&
            done.outcome === item.outcome,
        )
      ) {
        this.delivered.push(item);
      }
    }
    for (const item of request.settled ?? []) {
      // Like the real gateway: a request with no row has nothing to settle,
      // and the first word on one stands.
      const known = this.registrations.some(
        (entry) => entry.request_id === item.request_id,
      );
      if (
        known &&
        !this.settled.some((done) => done.request_id === item.request_id)
      ) {
        this.settled.push(item);
      }
    }
    for (const item of request.attached ?? []) {
      this.attachReports.push(item);
      this.attachOrders = this.attachOrders.filter(
        (order) => order.receipt_id !== item.receipt_id,
      );
    }
    return {
      attachments: [...this.attachOrders],
      control:
        this.controls.find(
          (control) =>
            !this.finalized.some(
              (done) => done.turn_id === control.target_turn_id,
            ),
        ) ?? this.control,
      // Like the real gateway, a settled request is no longer handed out.
      answers: this.answers.filter(
        (entry) =>
          entry.sequence > request.answers_after &&
          !this.settled.some(
            (done) => done.request_id === entry.answer.request_id,
          ),
      ),
    };
  }

  async invalidateApprovalCheckpoint(
    request: InvalidateApprovalCheckpointRequest,
  ): Promise<InvalidateApprovalCheckpointResponse> {
    this.calls.push("invalidateApprovalCheckpoint");
    if (this.invalidationFailure !== undefined) throw this.invalidationFailure;
    this.invalidations.push(request);
    return {
      invalidated: this.registrations.some(
        (entry) => entry.checkpoint?.manifest_ref === request.manifest_ref,
      ),
    };
  }

  async parkDeclined(
    request: ParkDeclinedRequest,
  ): Promise<ParkDeclinedResponse> {
    this.calls.push("parkDeclined");
    this.parkDeclines.push(request);
    const reverted = this.control?.control_id === request.pause_control_id;
    if (reverted) this.control = null;
    return { reverted };
  }

  async finalize(request: FinalizeRequest): Promise<FinalizeResponse> {
    this.calls.push("finalize");
    const replay = this.finalized.find(
      (earlier) => earlier.finalize_key === request.finalize_key,
    );
    if (replay === undefined && this.finalizeFailure !== undefined) {
      throw this.finalizeFailure;
    }
    if (replay === undefined) {
      // The same gate finalizeAtomic applies; a replay is answered
      // from what was stored, like the real one.
      if (request.final_source_sequence !== this.acceptedThrough) {
        throw new WorkerGatewayRequestError(
          409,
          "REVISION_CONFLICT",
          `Events are durable through source_sequence ${this.acceptedThrough}, not ${request.final_source_sequence}`,
          false,
        );
      }
      if (request.checkpoint !== null) {
        await this.commitCheckpoint({
          ...request,
          checkpoint: request.checkpoint,
        });
      }
      this.finalized.push(
        this.overBudget
          ? { ...request, terminal: budgetEndedTerminal(request.terminal) }
          : request,
      );
      if (request.terminal.status === "outcome_unknown") {
        this.recoveryRequired = true;
      }
    }
    return {
      turn_id: request.turn_id,
      status: request.terminal.status,
      checkpoint_revision: request.checkpoint?.revision ?? null,
    };
  }

  async requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse> {
    this.calls.push("requestCheckpoint");
    this.checkpointRequests.push(request);
    if (this.checkpointProtocol !== undefined) {
      return this.checkpointProtocol.requestCheckpoint(request);
    }
    if (request.preparation.status === "rejected") {
      return {
        status: "blocked",
        reason: request.preparation.reason,
        detail: request.preparation.detail,
      };
    }
    const revision = (this.checkpointRevision ?? -1) + 1;
    const publish = crypto.randomUUID().replaceAll("-", "");
    return {
      status: "ready",
      revision,
      manifest_ref: `sessions/${this.options.sessionId}/checkpoints/${String(revision).padStart(10, "0")}/${this.options.attemptId}/${publish}/manifest.json`,
    };
  }

  async restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse> {
    this.calls.push("restorePlan");
    this.restorePlans.push(request);
    if (this.checkpointProtocol !== undefined) {
      return this.checkpointProtocol.restorePlan(request);
    }
    return this.options.restore === null
      ? { status: "none" }
      : {
          status: "unavailable",
          code: "CHECKPOINT_UNAVAILABLE",
          reason: "The fake gateway holds no checkpoint objects",
        };
  }

  async ready(request: WorkerReadyRequest): Promise<WorkerReadyResponse> {
    this.calls.push("ready");
    this.readies.push(request);
    if (this.readyFailure) throw this.readyFailure;
    return { activated: false };
  }

  async release(request: ReleaseRequest): Promise<ReleaseResponse> {
    this.calls.push("release");
    this.releases.push(request);
    if (request.pause_control_id !== undefined && this.pauseRefusal) {
      throw this.pauseRefusal;
    }
    if (request.stop_kind !== undefined && this.predatesStopKind) {
      throw new WorkerGatewayRequestError(
        400,
        "BAD_REQUEST",
        "POST /release failed with BAD_REQUEST: Request body is invalid",
        false,
      );
    }
    return { released: true };
  }

  /** Like finalizeAtomic's pointer CAS: the next revision or nothing. */
  private async commitCheckpoint(
    request: FinalizeRequest & { checkpoint: CheckpointRef },
  ): Promise<void> {
    if (this.checkpointProtocol !== undefined) {
      await this.checkpointProtocol.commit(request);
      return;
    }
    const expected = (this.checkpointRevision ?? -1) + 1;
    if (request.checkpoint.revision !== expected) {
      throw new WorkerGatewayRequestError(
        409,
        "REVISION_CONFLICT",
        `The checkpoint pointer stands at ${this.checkpointRevision ?? "none"}`,
        false,
      );
    }
    this.checkpointRevision = expected;
  }

  private leaseExpiresAt(): string {
    return new Date(Date.now() + this.options.leaseTtlMs).toISOString();
  }
}
