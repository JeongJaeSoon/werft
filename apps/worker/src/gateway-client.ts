import {
  type AppendEventsRequest,
  type AppendEventsResponse,
  apiErrorResponseSchema,
  appendEventsResponseSchema,
  type BootstrapClaimRequest,
  type BootstrapClaimResponse,
  bootstrapClaimResponseSchema,
  type CheckpointRequest,
  type CheckpointRequestResponse,
  checkpointRequestResponseSchema,
  type FinalizeRequest,
  type FinalizeResponse,
  finalizeResponseSchema,
  type HeartbeatRequest,
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type InvalidateApprovalCheckpointRequest,
  type InvalidateApprovalCheckpointResponse,
  invalidateApprovalCheckpointResponseSchema,
  type NextInputRequest,
  type NextInputResponse,
  nextInputResponseSchema,
  type ParkDeclinedRequest,
  type ParkDeclinedResponse,
  type PendingControlRequest,
  type PendingControlResponse,
  type ProtectedCommitsRequest,
  type ProtectedCommitsResponse,
  parkDeclinedResponseSchema,
  pendingControlResponseSchema,
  protectedCommitsResponseSchema,
  type RegisterPendingRequest,
  type RegisterPendingResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type RestorePlanRequest,
  type RestorePlanResponse,
  registerPendingResponseSchema,
  releaseResponseSchema,
  requestBodyInvalidDetailsSchema,
  restorePlanResponseSchema,
  type WorkerCapabilities,
  type WorkerReadyRequest,
  type WorkerReadyResponse,
  workerReadyResponseSchema,
} from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";
import { messageOf as message } from "./message-of.ts";

import type { WorkerGatewaySession } from "./worker-host.ts";

// The capability keys a control-host older than the key refuses as a 400.
// `approval_remember` is not among them: no server old enough exists.
const REFUSABLE_CAPABILITIES = [
  "platform_tool_trust",
  "user_env",
  "permission_rules",
  "engine_settings",
  "response_language",
] as const;

// Only what a response body has to answer, so the worker never imports zod.
type Decoder<T> = { parse(value: unknown): T };

/** Only the call this client makes, so a test double need not be a whole fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpWorkerGatewayClientOptions = {
  baseUrl: string;
  /** The launch nonce to start with; `useCredential` swaps in the session token. */
  credential: string;
  fetch?: FetchLike;
  requestTimeoutMs: number;
};

/**
 * The client half of the worker protocol. The API mounts it
 * under `/internal`, and the launcher hands out the bare origin, so the
 * prefix is this client's to add. The worker
 * container reaches the gateway through the egress proxy, which fetch reads
 * out of the proxy environment variables the launcher sets; nothing here
 * addresses the daemon host.
 */
export class HttpWorkerGatewayClient implements WorkerGatewaySession {
  private credential: string;
  private readonly baseUrl: string;
  private readonly call: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpWorkerGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credential = options.credential;
    this.call =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  useCredential(credential: string): void {
    this.credential = credential;
  }

  bootstrapClaim(
    request: BootstrapClaimRequest,
  ): Promise<BootstrapClaimResponse> {
    return this.withCapabilityFallback(request, (body) =>
      this.post("/bootstrap-claim", body, bootstrapClaimResponseSchema),
    );
  }

  // A control-host older than a capability key refuses the whole body for that
  // one key. Rather than leave the worker to exit while the two sides are
  // mid-deploy, send once more without the keys it named: for
  // `platform_tool_trust` the server then hands out no `trusted`, and the
  // tools stay behind the engine's permission stage; for `user_env` it sends
  // no `env` (and a session that needs one waits, see the claim). Once
  // refused, a key stays off for this client's lifetime.
  private readonly refusedCapabilities = new Set<string>();

  private async withCapabilityFallback<
    R extends { capabilities?: WorkerCapabilities | undefined },
    T,
  >(request: R, send: (body: R) => Promise<T>): Promise<T> {
    const without = (): R => {
      const kept = { ...(request.capabilities ?? {}) } as Record<
        string,
        unknown
      >;
      for (const key of this.refusedCapabilities) delete kept[key];
      return { ...request, capabilities: kept as WorkerCapabilities };
    };
    // Keys refused earlier are left out of every request, and a key sent now
    // that the server refuses is still answered by one more try: an earlier
    // refusal must not use up the fallback for another key.
    const first = this.refusedCapabilities.size > 0 ? without() : request;
    try {
      return await send(first);
    } catch (error) {
      const refused = REFUSABLE_CAPABILITIES.filter(
        (key) =>
          first.capabilities?.[key] !== undefined &&
          refusesCapability(error, key),
      );
      if (refused.length === 0) throw error;
      for (const key of refused) this.refusedCapabilities.add(key);
      return send(without());
    }
  }

  nextInput(request: NextInputRequest): Promise<NextInputResponse> {
    return this.post("/next-input", request, nextInputResponseSchema);
  }

  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.post("/heartbeat", request, heartbeatResponseSchema);
  }

  appendEvents(request: AppendEventsRequest): Promise<AppendEventsResponse> {
    return this.post("/append-events", request, appendEventsResponseSchema);
  }

  registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    return this.post(
      "/register-pending",
      request,
      registerPendingResponseSchema,
    );
  }

  pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse> {
    return this.withCapabilityFallback(request, (body) =>
      this.post("/pending-control", body, pendingControlResponseSchema),
    );
  }

  parkDeclined(request: ParkDeclinedRequest): Promise<ParkDeclinedResponse> {
    return this.post("/park-declined", request, parkDeclinedResponseSchema);
  }

  invalidateApprovalCheckpoint(
    request: InvalidateApprovalCheckpointRequest,
  ): Promise<InvalidateApprovalCheckpointResponse> {
    return this.post(
      "/invalidate-approval-checkpoint",
      request,
      invalidateApprovalCheckpointResponseSchema,
    );
  }

  requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse> {
    return this.post(
      "/checkpoint-request",
      request,
      checkpointRequestResponseSchema,
    );
  }

  protectedCommits(
    request: ProtectedCommitsRequest,
  ): Promise<ProtectedCommitsResponse> {
    return this.post(
      "/protected-commits",
      request,
      protectedCommitsResponseSchema,
    );
  }

  restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse> {
    return this.post("/restore-plan", request, restorePlanResponseSchema);
  }

  ready(request: WorkerReadyRequest): Promise<WorkerReadyResponse> {
    return this.post("/ready", request, workerReadyResponseSchema);
  }

  finalize(request: FinalizeRequest): Promise<FinalizeResponse> {
    return this.post("/finalize", request, finalizeResponseSchema);
  }

  release(request: ReleaseRequest): Promise<ReleaseResponse> {
    return this.post("/release", request, releaseResponseSchema);
  }

  async extensionBundle(
    attemptId: string,
    digest: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    const path = `/attempts/${encodeURIComponent(attemptId)}/extensions/${encodeURIComponent(digest)}`;
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.call(`${this.baseUrl}/internal/worker${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.credential}` },
        signal:
          options.signal === undefined
            ? timeout
            : AbortSignal.any([timeout, options.signal]),
      });
    } catch (error) {
      throw new WorkerGatewayRequestError(
        0,
        null,
        `GET ${path} did not reach the gateway: ${message(error)}`,
        true,
      );
    }
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {}
      const refusal = failure(path, response.status, payload, "GET");
      throw new WorkerGatewayRequestError(
        refusal.status,
        refusal.code,
        refusal.message,
        isTransientStatus(response.status),
        refusal.details,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel();
      throw new WorkerGatewayRequestError(
        response.status,
        null,
        `GET ${path} announces ${declared} bytes, over the ${options.maxBytes} byte limit`,
        false,
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = response.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (part === undefined || part.done) break;
        total += part.value.byteLength;
        if (total > options.maxBytes) {
          await reader?.cancel();
          throw new WorkerGatewayRequestError(
            response.status,
            null,
            `GET ${path} sent more than the ${options.maxBytes} byte limit`,
            false,
          );
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof WorkerGatewayRequestError) throw error;
      throw new WorkerGatewayRequestError(
        response.status,
        null,
        `GET ${path} broke off: ${message(error)}`,
        true,
      );
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  private async post<T>(
    path: string,
    body: unknown,
    decoder: Decoder<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.call(`${this.baseUrl}/internal/worker${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      // A socket that never answered says nothing about whether the write
      // landed, so it is retryable and the caller replays the idempotent key.
      throw new WorkerGatewayRequestError(
        0,
        null,
        `POST ${path} did not reach the gateway: ${message(error)}`,
        true,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // A 2xx whose body broke off says the write may have landed, not that
      // it was refused: the caller replays the idempotent key.
      if (response.ok) {
        throw new WorkerGatewayRequestError(
          response.status,
          null,
          `POST ${path} answered a body that could not be read: ${message(error)}`,
          true,
        );
      }
    }
    if (!response.ok) throw failure(path, response.status, payload);
    try {
      return decoder.parse(payload);
    } catch (error) {
      throw new WorkerGatewayRequestError(
        response.status,
        null,
        `POST ${path} answered a body this worker cannot read: ${message(error)}`,
        false,
      );
    }
  }
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function failure(
  path: string,
  status: number,
  payload: unknown,
  method = "POST",
): WorkerGatewayRequestError {
  const parsed = apiErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    // 5xx without a body is still the gateway being unavailable rather than
    // this request being wrong, so it stays retryable.
    return new WorkerGatewayRequestError(
      status,
      null,
      `${method} ${path} failed with HTTP ${status}`,
      isTransientStatus(status),
    );
  }
  const { code, message: detail, retryable, details } = parsed.data.error;
  return new WorkerGatewayRequestError(
    status,
    code,
    `${method} ${path} failed with ${code}: ${detail}`,
    retryable,
    details ?? undefined,
  );
}

/**
 * Whether a 400 is a control-host older than `platform_tool_trust` refusing
 * that one key of the strict `capabilities` object. Read from the structured
 * `details.issues` (an issue at path `capabilities` that names the key); a
 * body without them, or any other refusal, is not this.
 */
function refusesCapability(error: unknown, key: string): boolean {
  if (
    !(error instanceof WorkerGatewayRequestError) ||
    error.status !== 400 ||
    error.code !== "BAD_REQUEST"
  ) {
    return false;
  }
  const parsed = requestBodyInvalidDetailsSchema.safeParse(error.details);
  return (
    parsed.success &&
    parsed.data.issues.some(
      (issue) =>
        issue.path === "capabilities" && issue.message.includes(`"${key}"`),
    )
  );
}
