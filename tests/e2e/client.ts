/**
 * What tests/e2e drives the stack with: the public /v1 API over HTTP and
 * nothing else — no database, no bucket, no import from apps/. A step that
 * needs more than a curl user has is not a quickstart step. The one
 * exception is test scaffolding, not product: the fake Messages API's
 * control port, which says when a scripted model call is in flight.
 */
import { createHash } from "node:crypto";

export type E2eEnv = { apiKey: string; apiUrl: string; messagesUrl: string };

/**
 * The stack tests/e2e/run.sh started; the suite never starts one. A stack on
 * a real or local model runs no fake Messages API, so its suite passes
 * `needsMessages: false` and gets an empty messagesUrl.
 */
export function e2eEnv({ needsMessages = true } = {}): E2eEnv {
  const apiUrl = process.env.E2E_API_URL;
  const apiKey = process.env.E2E_API_KEY;
  const messagesUrl = process.env.E2E_MESSAGES_URL ?? "";
  if (!apiUrl || !apiKey || (needsMessages && !messagesUrl)) {
    throw new Error(
      `E2E_API_URL, E2E_API_KEY${needsMessages ? " and E2E_MESSAGES_URL" : ""} are unset: run tests/e2e/run.sh, or source its vars.sh (E2E_UP_ONLY=1)`,
    );
  }
  return { apiKey, apiUrl, messagesUrl };
}

export const PROFILE_ID = "claude-coding-local";
export const REPOSITORY_ID = "sample-app";
export const NO_REPOSITORY_PROFILE_ID = "general";

/**
 * Derived from the bootstrap token, so every suite on one stack, and a
 * second run on it, logs in as the people the first one made.
 */
export function passwordOf(bootstrapToken: string, email: string): string {
  return createHash("sha256")
    .update(`${bootstrapToken}:${email}`)
    .digest("base64url")
    .slice(0, 24);
}

/**
 * The session cookie of the stack's first owner, in the `verify` workspace
 * tests/fixtures/settings/fake-model.json allows. A stack bootstraps once, so
 * every suite asks for the same owner: the first call makes it, the rest get
 * 409 and log in.
 */
export async function firstOwnerCookie(
  apiUrl: string,
  bootstrapToken: string,
): Promise<string> {
  const email = "e2e-owner@example.test";
  const password = passwordOf(bootstrapToken, email);
  const post = (path: string, body: unknown) =>
    fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-requested-with": "werft-web",
      },
      body: JSON.stringify(body),
    });
  const booted = await post("/v1/auth/bootstrap", {
    bootstrap_token: bootstrapToken,
    email,
    password,
    display_name: "E2E Owner",
    workspace_name: "Verify",
    workspace_slug: "verify",
  });
  if (booted.status !== 201 && booted.status !== 409) {
    throw new Error(`bootstrap answered ${booted.status}`);
  }
  const login = await post("/v1/auth/login", { email, password });
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-werft_session="))
    ?.split(";")[0];
  if (login.status !== 200 || !cookie) {
    throw new Error(
      `the first owner could not log in (${login.status}): another owner bootstrapped this stack`,
    );
  }
  return cookie;
}

export type Step = {
  delayMs?: number;
  input: Record<string, unknown>;
  tool: string;
};

/**
 * A prompt the compose fake Messages API plays as written
 * (packages/testkit/src/scripted-messages.ts): each step is one tool call,
 * then the final text ends the turn.
 */
export function scripted(
  id: string,
  steps: Step[],
  final: string,
  finalDelayMs?: number,
): string {
  const spec = {
    id,
    steps,
    final,
    ...(finalDelayMs === undefined ? {} : { finalDelayMs }),
  };
  return `GATE-SPEC ${JSON.stringify(spec)}`;
}

export const bash = (command: string): Step => ({
  tool: "Bash",
  input: { command, description: command },
});

export const write = (path: string, content: string): Step => ({
  tool: "Write",
  input: { file_path: path, content },
});

export type ApiResponse<T> = { body: T; headers: Headers; status: number };

export type ErrorBody = {
  error: {
    code: string;
    details?: Record<string, unknown>;
    message: string;
    retryable: boolean;
  };
};

export type SessionDetail = {
  admission_state: string;
  attention: ({ code: string } & Record<string, unknown>) | null;
  checkpoint_revision: number | null;
  current_turn_id: string | null;
  durability: {
    checkpoint_pending_reason: string | null;
    checkpoint_revision: number | null;
    last_checkpointed_turn_id: string | null;
    last_completed_turn_id: string | null;
  };
  id: string;
  pending_request_count: number;
  queued_turn_count: number;
  repository_id: string | null;
  revision: number;
  status: string;
};

export type Turn = { id: string; status: string } & Record<string, unknown>;

export type Receipt = {
  error: unknown;
  id: string;
  operation: string;
  result: Record<string, unknown> | null;
  status: "accepted" | "succeeded" | "failed" | "unknown";
};

export type PendingRequest = {
  input: Record<string, unknown>;
  kind: "permission" | "question";
  request_id: string;
  tool?: string;
  turn_id: string;
};

const TERMINAL_TURN = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
]);

export class Api {
  constructor(private readonly env: E2eEnv) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey: string | null = method === "POST"
      ? crypto.randomUUID()
      : null,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.env.apiKey}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(`${this.env.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text === "" ? null : JSON.parse(text)) as T,
    };
  }

  /** The body of a response that must have had `status`; anything else throws with it. */
  async expect<T>(
    status: number,
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string | null,
  ): Promise<T> {
    const response = await this.request<T>(method, path, body, idempotencyKey);
    if (response.status !== status) {
      throw new Error(
        `${method} ${path} answered ${response.status}, expected ${status}: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body;
  }

  /** `repositoryId: null` leaves `repository_id` out of the body. */
  createSession(
    message: string,
    idempotencyKey?: string,
    profileId = PROFILE_ID,
    repositoryId: string | null = REPOSITORY_ID,
  ) {
    return this.request<{
      receipt_id: string;
      session_id: string;
      status: string;
      turn_id: string;
    }>(
      "POST",
      "/v1/sessions",
      {
        profile_id: profileId,
        ...(repositoryId === null ? {} : { repository_id: repositoryId }),
        message,
      },
      idempotencyKey,
    );
  }

  session(id: string) {
    return this.expect<SessionDetail>(200, "GET", `/v1/sessions/${id}`);
  }

  turn(sessionId: string, turnId: string) {
    return this.expect<Turn>(
      200,
      "GET",
      `/v1/sessions/${sessionId}/turns/${turnId}`,
    );
  }

  send(sessionId: string, message: string) {
    return this.expect<{ receipt_id: string; turn_id: string }>(
      202,
      "POST",
      `/v1/sessions/${sessionId}/messages`,
      { message },
    );
  }

  async pending(sessionId: string): Promise<PendingRequest[]> {
    const body = await this.expect<{ items: PendingRequest[] }>(
      200,
      "GET",
      `/v1/sessions/${sessionId}/pending-requests`,
    );
    return body.items;
  }

  allow(sessionId: string, requestId: string) {
    return this.expect<{ receipt_id: string }>(
      202,
      "POST",
      `/v1/sessions/${sessionId}/answers`,
      { request_id: requestId, kind: "permission", action: "allow" },
    );
  }

  deny(sessionId: string, requestId: string, reason = "denied by the suite") {
    return this.expect<{ receipt_id: string }>(
      202,
      "POST",
      `/v1/sessions/${sessionId}/answers`,
      {
        request_id: requestId,
        kind: "permission",
        action: "deny",
        reason,
      },
    );
  }

  /** A control operation's first response, whatever its status. */
  control(sessionId: string, operation: string, body: unknown) {
    return this.request<
      { receipt_id: string; receipt_status: string } | ErrorBody
    >("POST", `/v1/sessions/${sessionId}/${operation}`, body);
  }

  receipt(id: string) {
    return this.expect<Receipt>(200, "GET", `/v1/receipts/${id}`);
  }

  /**
   * Waits until the fake Messages API has received the call for `step` of
   * the script `specId` (the final text is step `steps.length`), so a
   * control sent next lands while that call is in flight.
   */
  async modelCallSeen(specId: string, step: number): Promise<void> {
    await poll(`model call ${specId}#${step}`, 180_000, async () => {
      const calls = await this.modelCalls(specId);
      return calls.some((call) => call.step === step) ? true : null;
    });
  }

  /**
   * Every call the fake Messages API recorded for the script `specId`, with
   * the ids of the earlier prompts the engine sent along as history.
   */
  async modelCalls(
    specId: string,
  ): Promise<Array<{ history: string[]; step: number | null }>> {
    const response = await fetch(
      `${this.env.messagesUrl}/requests?spec=${encodeURIComponent(specId)}`,
    );
    return (await response.json()) as Array<{
      history: string[];
      step: number | null;
    }>;
  }

  /** Polls until the turn reaches a terminal status and returns it. */
  async settledTurn(
    sessionId: string,
    turnId: string,
    timeoutMs = 180_000,
  ): Promise<Turn> {
    return poll(
      `turn ${turnId} of ${sessionId} to settle`,
      timeoutMs,
      async () => {
        const turn = await this.turn(sessionId, turnId);
        return TERMINAL_TURN.has(turn.status) ? turn : null;
      },
    );
  }

  /**
   * Settles a turn, allowing every permission request it raises; any other
   * question fails it.
   */
  async settleAllowing(
    sessionId: string,
    turnId: string,
    timeoutMs = 180_000,
  ): Promise<Turn> {
    const answered = new Set<string>();
    return poll(`turn ${turnId} of ${sessionId}`, timeoutMs, async () => {
      const turn = await this.turn(sessionId, turnId);
      if (TERMINAL_TURN.has(turn.status)) return turn;
      for (const request of await this.pending(sessionId)) {
        if (request.turn_id !== turnId || answered.has(request.request_id)) {
          continue;
        }
        if (request.kind !== "permission") {
          throw new Error(`turn ${turnId} asked: ${JSON.stringify(request)}`);
        }
        answered.add(request.request_id);
        await this.allow(sessionId, request.request_id);
      }
      return null;
    });
  }

  /** Polls the session until `accept` holds for its detail. */
  async sessionUntil(
    sessionId: string,
    what: string,
    accept: (detail: SessionDetail) => boolean,
    timeoutMs = 180_000,
  ): Promise<SessionDetail> {
    return poll(`${sessionId} ${what}`, timeoutMs, async () => {
      const detail = await this.session(sessionId);
      return accept(detail) ? detail : null;
    });
  }

  async pendingUntil(
    sessionId: string,
    count: number,
    timeoutMs = 180_000,
  ): Promise<PendingRequest[]> {
    return poll(
      `${count} pending request(s) on ${sessionId}`,
      timeoutMs,
      async () => {
        const items = await this.pending(sessionId);
        return items.length >= count ? items : null;
      },
    );
  }

  async receiptUntil(
    id: string,
    accept: (receipt: Receipt) => boolean,
    timeoutMs = 180_000,
  ): Promise<Receipt> {
    return poll(`receipt ${id}`, timeoutMs, async () => {
      const receipt = await this.receipt(id);
      return accept(receipt) ? receipt : null;
    });
  }

  /**
   * Reads the SSE stream from the start until `stop` sees the event it
   * waits for, and returns every event read.
   */
  async events(
    sessionId: string,
    stop: (event: SseEvent) => boolean,
    timeoutMs = 180_000,
    /** Replays strictly after this event id; the whole history without it. */
    lastEventId?: string,
    /** Called once the server has accepted the stream, before any event is read. */
    onOpen?: () => void,
  ): Promise<SseEvent[]> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const seen: SseEvent[] = [];
    try {
      const response = await fetch(
        `${this.env.apiUrl}/v1/sessions/${sessionId}/events`,
        {
          headers: {
            authorization: `Bearer ${this.env.apiKey}`,
            ...(lastEventId === undefined
              ? {}
              : { "last-event-id": lastEventId }),
          },
          signal: abort.signal,
        },
      );
      if (response.status !== 200 || response.body === null) {
        throw new Error(`events answered ${response.status}`);
      }
      onOpen?.();
      for await (const event of parseSse(response.body)) {
        seen.push(event);
        if (stop(event)) return seen;
      }
      throw new Error(`event stream ended; saw ${describe(seen)}`);
    } catch (error) {
      if (abort.signal.aborted) {
        throw new Error(
          `no matching event in ${timeoutMs}ms; saw ${describe(seen)}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}

export type SseEvent = {
  data: { data: Record<string, unknown>; turn_id: string | null };
  event: string;
  id: string;
};

function describe(events: SseEvent[]): string {
  return events.map((event) => event.event).join(",") || "nothing";
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const fields: Record<string, string> = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const value = line.slice(colon + 1).replace(/^ /, "");
        const key = line.slice(0, colon);
        fields[key] = key in fields ? `${fields[key]}\n${value}` : value;
      }
      if (fields.event === undefined || fields.data === undefined) continue;
      yield {
        id: fields.id ?? "",
        event: fields.event,
        data: JSON.parse(fields.data),
      };
    }
  }
}

export async function poll<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | null>,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}
