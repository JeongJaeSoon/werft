import { z } from "zod";
import {
  type OutboundHttp,
  OutboundRefusedError,
  type OutboundResponse,
} from "../../ports/outbound-http.ts";

/** A call slower than this is a failed try. */
export const DECISIONS_CALL_TIMEOUT_MS = 10_000;
export const LUNA_MODEL = "gpt-6-luna";

/** One choice question; shape in decisions-api.fixture.ts. */
export type DecisionsRequest = {
  model: string;
  input: string;
  questions: [
    {
      type: "choice";
      name: string;
      instructions: string;
      choices: { value: string; description: string }[];
    },
  ];
};

const probability = z.number().min(0).max(1);

export const decisionsResponseSchema = z.object({
  answers: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        name: z.string(),
        choice: z.string(),
        probabilities: z.array(z.object({ value: z.string(), probability })),
        confidence: probability.optional(),
      }),
      z.object({ type: z.literal("refusal"), name: z.string() }),
    ]),
  ),
});

export type DecisionsResponse = z.infer<typeof decisionsResponseSchema>;
export type DecisionsAnswer = DecisionsResponse["answers"][number];

/** Carries no upstream body: an error body may name the key's last characters. */
export class DecisionsCallError extends Error {
  constructor(
    readonly reason: "timeout" | "unreachable" | "status" | "bad_response",
    readonly status: number | null = null,
  ) {
    super(
      status === null
        ? `decisions call failed: ${reason}`
        : `decisions call answered ${status}`,
    );
    this.name = "DecisionsCallError";
  }
}

function failed(error: unknown): DecisionsCallError {
  if (!(error instanceof OutboundRefusedError)) {
    return new DecisionsCallError("unreachable");
  }
  if (error.reason === "answered" && error.detail.status !== undefined) {
    return new DecisionsCallError("status", error.detail.status);
  }
  return new DecisionsCallError(
    error.detail.timedOut ? "timeout" : "unreachable",
  );
}

export type DecisionsClient = {
  decide(token: string, request: DecisionsRequest): Promise<DecisionsResponse>;
};

/**
 * Calls the Decisions API through the egress proxy's judgment route with a
 * judgment token; the proxy puts the connection's key on it and charges the
 * judgment.
 */
export function createDecisionsClient(deps: {
  // The proxy's credential listener, e.g. http://egress-proxy:3129.
  egressUrl: string;
  /** Held to the egress proxy's host alone. */
  http: OutboundHttp;
  timeoutMs?: number;
}): DecisionsClient {
  const timeoutMs = deps.timeoutMs ?? DECISIONS_CALL_TIMEOUT_MS;
  const url = `${deps.egressUrl.replace(/\/+$/, "")}/decisions/v1/decisions`;
  return {
    async decide(token, request) {
      let response: OutboundResponse;
      try {
        response = await deps.http({
          url,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
          timeoutMs,
        });
      } catch (error) {
        throw failed(error);
      }
      if (response.status < 200 || response.status > 299) {
        throw new DecisionsCallError("status", response.status);
      }
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        throw new DecisionsCallError("bad_response");
      }
      const parsed = decisionsResponseSchema.safeParse(body);
      if (!parsed.success) throw new DecisionsCallError("bad_response");
      return parsed.data;
    },
  };
}
