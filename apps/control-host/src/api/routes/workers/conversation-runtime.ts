import {
  CONVERSATION_RUNTIME_ROUTE_PREFIX,
  CONVERSATION_RUNTIME_ROUTES,
} from "@werft-ai/contracts";
import type {
  ConversationReadTools,
  ConversationRuntimeTurns,
} from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";

function bearerToken(value: string | undefined): string | null {
  const match = value ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

const routePaths = new Set(
  Object.keys(CONVERSATION_RUNTIME_ROUTES).map(
    (path) => `/internal${CONVERSATION_RUNTIME_ROUTE_PREFIX}${path}`,
  ),
);

/**
 * The conversation runtime's routes, behind a bearer of its own. That
 * bearer opens nothing else under /internal, and nothing but that bearer
 * opens these: register this before the worker routes, so a runtime's bearer
 * on one of them is refused here and never reaches their credential lookup.
 * `stop` ends a waiting poll when the API shuts down.
 */
export function registerConversationRuntimeRoutes(
  router: ApiRouter,
  deps: {
    turns: ConversationRuntimeTurns;
    readTools: Pick<ConversationReadTools, "call" | "decide">;
    isRuntimeBearer: (token: string | null) => boolean;
    stop?: AbortSignal;
  },
) {
  router.use("*", async (context, next) => {
    const token = bearerToken(context.req.header("Authorization"));
    const runtime = deps.isRuntimeBearer(token);
    const own = routePaths.has(context.req.path.replace(/\/$/, ""));
    if (runtime !== own) {
      // A worker's credential on these routes, or the runtime's on any other.
      if (own && token === null) {
        throw new ApiHttpError(401, "UNAUTHORIZED", "A bearer is required");
      }
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        own
          ? "These routes take the conversation runtime's bearer"
          : "The conversation runtime's bearer opens its own routes only",
      );
    }
    await next();
  });

  router.post(
    `${CONVERSATION_RUNTIME_ROUTE_PREFIX}/next-turn`,
    async (context) => {
      const { request, response } = CONVERSATION_RUNTIME_ROUTES["/next-turn"];
      const body = await parseJsonBody(context, request);
      const turn = await deps.turns.nextTurn({
        runtimeId: body.runtime_id,
        waitMs: body.wait_ms ?? 0,
        ...(deps.stop === undefined ? {} : { stop: deps.stop }),
      });
      return jsonWithSchema(context, response, { turn });
    },
  );

  router.post(
    `${CONVERSATION_RUNTIME_ROUTE_PREFIX}/turn-result`,
    async (context) => {
      const { request, response } = CONVERSATION_RUNTIME_ROUTES["/turn-result"];
      const body = await parseJsonBody(context, request);
      const reported = await deps.turns.turnResult({
        runtimeId: body.runtime_id,
        turnId: body.turn_id,
        leaseId: body.lease_id,
        result: body.result,
      });
      switch (reported) {
        case "recorded":
          return jsonWithSchema(context, response, { recorded: true });
        case "duplicate":
          return jsonWithSchema(context, response, { recorded: false });
        case "unknown_turn":
          throw new ApiHttpError(404, "NOT_FOUND", "No such turn");
        case "not_holder":
          throw new ApiHttpError(
            403,
            "FORBIDDEN",
            "The turn is not leased to this runtime under this lease",
          );
        case "lease_expired":
          throw new ApiHttpError(
            409,
            "REQUEST_EXPIRED",
            "The lease ended before the report: the turn is closed as failed",
          );
        case "conflict":
          throw new ApiHttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The turn was already reported with another result",
          );
      }
    },
  );

  router.post(
    `${CONVERSATION_RUNTIME_ROUTE_PREFIX}/read-tool`,
    async (context) => {
      const { request, response } = CONVERSATION_RUNTIME_ROUTES["/read-tool"];
      const body = await parseJsonBody(context, request);
      const answered = await deps.readTools.call({
        runtimeId: body.runtime_id,
        turnId: body.turn_id,
        leaseId: body.lease_id,
        tool: body.tool,
      });
      switch (answered.outcome) {
        case "read":
        case "refused":
          return jsonWithSchema(context, response, answered);
        case "unknown_turn":
          throw new ApiHttpError(404, "NOT_FOUND", "No such turn");
        case "not_holder":
          throw new ApiHttpError(
            403,
            "FORBIDDEN",
            "The turn is not leased to this runtime under this lease",
          );
        case "lease_expired":
          throw new ApiHttpError(
            409,
            "REQUEST_EXPIRED",
            "The turn's lease is over: it reads nothing more",
          );
      }
    },
  );

  router.post(
    `${CONVERSATION_RUNTIME_ROUTE_PREFIX}/decision-tool`,
    async (context) => {
      const { request, response } =
        CONVERSATION_RUNTIME_ROUTES["/decision-tool"];
      const body = await parseJsonBody(context, request);
      const answered = await deps.readTools.decide({
        runtimeId: body.runtime_id,
        turnId: body.turn_id,
        leaseId: body.lease_id,
        decision: body.decision,
      });
      switch (answered.outcome) {
        case "accepted":
        case "refused":
          return jsonWithSchema(context, response, answered);
        case "unknown_turn":
          throw new ApiHttpError(404, "NOT_FOUND", "No such turn");
        case "not_holder":
          throw new ApiHttpError(
            403,
            "FORBIDDEN",
            "The turn is not leased to this runtime under this lease",
          );
        case "lease_expired":
          throw new ApiHttpError(
            409,
            "REQUEST_EXPIRED",
            "The turn's lease is over: it decides nothing more",
          );
      }
    },
  );
}
