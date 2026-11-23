import { describe, expect, test } from "bun:test";
import {
  OutboundRefusedError,
  type OutboundRequest,
  type OutboundResponse,
} from "../../ports/outbound-http.ts";
import {
  DECISIONS_CHOICE_RESPONSE_FIXTURE,
  DECISIONS_ERROR_RESPONSE_FIXTURE,
  DECISIONS_REFUSAL_RESPONSE_FIXTURE,
  DECISIONS_REQUEST_FIXTURE,
} from "./decisions-api.fixture.ts";
import {
  createDecisionsClient,
  DECISIONS_CALL_TIMEOUT_MS,
  DecisionsCallError,
  type DecisionsRequest,
} from "./decisions-client.ts";

const REQUEST = DECISIONS_REQUEST_FIXTURE as unknown as DecisionsRequest;

const answered = (status: number, text: string): OutboundResponse => ({
  status,
  text,
  headers: new Headers({ "content-type": "application/json" }),
});

function client(
  answer: (request: OutboundRequest) => OutboundResponse,
  timeoutMs?: number,
) {
  const seen: OutboundRequest[] = [];
  const decisions = createDecisionsClient({
    egressUrl: "http://egress-proxy:3129/",
    http: async (request) => {
      seen.push(request);
      return answer(request);
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { decisions, seen };
}

async function failure(promise: Promise<unknown>): Promise<DecisionsCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DecisionsCallError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("decisions client", () => {
  test("a call is given ten seconds", () => {
    expect(DECISIONS_CALL_TIMEOUT_MS).toBe(10_000);
  });

  test("posts the request to the proxy's judgment route with the judgment token, and parses the documented answer", async () => {
    const { decisions, seen } = client(() =>
      answered(200, JSON.stringify(DECISIONS_CHOICE_RESPONSE_FIXTURE)),
    );
    const answer = await decisions.decide("wej_token", REQUEST);
    expect(answer.answers).toEqual([
      ...DECISIONS_CHOICE_RESPONSE_FIXTURE.answers,
    ] as never);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "http://egress-proxy:3129/decisions/v1/decisions",
    );
    expect(request?.headers?.authorization).toBe("Bearer wej_token");
    expect(request?.headers?.["content-type"]).toBe("application/json");
    expect(request?.timeoutMs).toBe(DECISIONS_CALL_TIMEOUT_MS);
    expect(JSON.parse(request?.body ?? "")).toEqual(DECISIONS_REQUEST_FIXTURE);
  });

  test("parses a refusal and tolerates fields the guide does not list", async () => {
    const { decisions } = client(() =>
      answered(
        200,
        JSON.stringify({ id: "dec_1", ...DECISIONS_REFUSAL_RESPONSE_FIXTURE }),
      ),
    );
    const answer = await decisions.decide("wej_token", REQUEST);
    expect(answer.answers).toEqual([{ type: "refusal", name: "achievement" }]);
  });

  test("an error answer fails with its status only: the body, which may name the key, is never kept", async () => {
    for (const status of [302, 401, 429, 500, 503]) {
      const body = JSON.stringify(DECISIONS_ERROR_RESPONSE_FIXTURE);
      // The port throws on a 5xx, as the outbound policy does.
      const { decisions } = client(() => {
        if (status < 500) return answered(status, body);
        throw new OutboundRefusedError(
          "answered",
          `Provider answered ${status}`,
          { status },
        );
      });
      const error = await failure(decisions.decide("wej_token", REQUEST));
      expect(error.reason).toBe("status");
      expect(error.status).toBe(status);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("wxyz");
    }
  });

  test("an answer slower than the timeout fails as a timeout", async () => {
    const { decisions, seen } = client(() => {
      throw new OutboundRefusedError("unreachable", "late", {
        timedOut: true,
      });
    }, 20);
    const error = await failure(decisions.decide("wej_token", REQUEST));
    expect(error.reason).toBe("timeout");
    expect(seen[0]?.timeoutMs).toBe(20);
  });

  test("an unreachable or refused proxy fails as unreachable", async () => {
    for (const thrown of [
      new OutboundRefusedError("unreachable", "refused"),
      new OutboundRefusedError("address_not_allowed", "not the proxy"),
      new TypeError("fetch failed"),
    ]) {
      const { decisions } = client(() => {
        throw thrown;
      });
      expect(
        (await failure(decisions.decide("wej_token", REQUEST))).reason,
      ).toBe("unreachable");
    }
  });

  test("an answer of another shape fails as a bad response", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ answers: "yes" }),
      JSON.stringify({ answers: [{ type: "ranking", name: "achievement" }] }),
      JSON.stringify({
        answers: [
          {
            type: "choice",
            name: "achievement",
            choice: "yes",
            probabilities: { yes: 0.94, no: 0.06 },
          },
        ],
      }),
      JSON.stringify({
        answers: [
          {
            type: "choice",
            name: "achievement",
            choice: "yes",
            probabilities: [{ value: "yes", probability: 1.5 }],
          },
        ],
      }),
    ]) {
      const { decisions } = client(() => answered(200, body));
      expect(
        (await failure(decisions.decide("wej_token", REQUEST))).reason,
      ).toBe("bad_response");
    }
  });
});
