import {
  apiErrorResponseSchema,
  CONVERSATION_RUNTIME_ROUTE_PREFIX,
  type ConversationReadTool,
  type ConversationReadToolResponse,
  type ConversationRuntimeId,
  type ConversationRuntimeTurn,
  type ConversationTurnResult,
  conversationNextTurnResponseSchema,
  conversationReadToolResponseSchema,
  conversationTurnResultResponseSchema,
} from "@werft-ai/contracts";

/**
 * Where the runtime's turns come from and their results go. Transport-free,
 * so the loop is the same whatever carries it.
 */
export interface ConversationTurnSource {
  /** The next turn, leased to this runtime; null when none came within the wait. */
  next(signal: AbortSignal): Promise<ConversationRuntimeTurn | null>;
  /**
   * Reports a turn this runtime holds. `refused` when the control host no
   * longer takes it (the lease ended, or the turn is another's): final, never
   * retried. Throws when the report did not arrive, which the caller retries.
   */
  report(
    turn: Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">,
    result: ConversationTurnResult,
  ): Promise<"recorded" | "refused">;
  /**
   * One read tool call of a turn this runtime holds. `turn_not_held` when
   * the control host no longer takes the turn's calls. Throws when the
   * answer did not arrive.
   */
  readTool(
    turn: Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">,
    tool: ConversationReadTool,
    signal: AbortSignal,
  ): Promise<ConversationReadToolResponse | { outcome: "turn_not_held" }>;
}

/** Only the call this client makes, so a test double need not be a whole fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The runtime's half of its protocol, over the worker gateway's listener.
 * The runtime's container reaches it through the egress proxy, which fetch
 * reads out of the proxy environment variables; the bearer is the runtime's
 * own and opens these routes only.
 */
export class HttpConversationTurnSource implements ConversationTurnSource {
  private readonly baseUrl: string;
  private readonly call: FetchLike;

  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      runtimeId: ConversationRuntimeId;
      waitMs: number;
      requestTimeoutMs: number;
      fetch?: FetchLike;
    },
  ) {
    this.baseUrl = `${options.baseUrl.replace(/\/$/, "")}/internal${CONVERSATION_RUNTIME_ROUTE_PREFIX}`;
    this.call =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private post(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.call(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  async next(signal: AbortSignal): Promise<ConversationRuntimeTurn | null> {
    const response = await this.post(
      "/next-turn",
      { runtime_id: this.options.runtimeId, wait_ms: this.options.waitMs },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(
          this.options.waitMs + this.options.requestTimeoutMs,
        ),
      ]),
    );
    if (!response.ok) throw await refusal(response);
    return conversationNextTurnResponseSchema.parse(await response.json()).turn;
  }

  async report(
    turn: Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">,
    result: ConversationTurnResult,
  ): Promise<"recorded" | "refused"> {
    const response = await this.post(
      "/turn-result",
      {
        runtime_id: this.options.runtimeId,
        turn_id: turn.turn_id,
        lease_id: turn.lease_id,
        result,
      },
      AbortSignal.timeout(this.options.requestTimeoutMs),
    );
    if (response.ok) {
      conversationTurnResultResponseSchema.parse(await response.json());
      return "recorded";
    }
    // The control host's own verdict on this report; asking again changes nothing.
    if ([403, 404, 409].includes(response.status)) {
      await response.body?.cancel();
      return "refused";
    }
    throw await refusal(response);
  }

  async readTool(
    turn: Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">,
    tool: ConversationReadTool,
    signal: AbortSignal,
  ): Promise<ConversationReadToolResponse | { outcome: "turn_not_held" }> {
    const response = await this.post(
      "/read-tool",
      {
        runtime_id: this.options.runtimeId,
        turn_id: turn.turn_id,
        lease_id: turn.lease_id,
        tool,
      },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(this.options.requestTimeoutMs),
      ]),
    );
    if (response.ok) {
      return conversationReadToolResponseSchema.parse(await response.json());
    }
    if ([403, 404, 409].includes(response.status)) {
      await response.body?.cancel();
      return { outcome: "turn_not_held" };
    }
    throw await refusal(response);
  }
}

/** The status and the API's error code; never the body, which may quote a request. */
async function refusal(response: Response): Promise<Error> {
  const parsed = apiErrorResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return new Error(
    `The control host answered ${response.status}${parsed.success ? ` ${parsed.data.error.code}` : ""}`,
  );
}
