import { describe, expect, test } from "bun:test";
import type { SessionCatalog } from "../catalog/catalog.ts";
import {
  type OutboundRequest,
  type OutboundResponse,
  WorkspaceMcpOutboundError,
} from "../ports/outbound-http.ts";
import { testCatalog, testConnection } from "../testing/catalog-fakes.ts";
import type {
  SessionTitleStore,
  TitleRequestIssue,
} from "./ports/session-title-store.ts";
import {
  createSessionTitler,
  hashTitleToken,
  titleOf,
} from "./session-titler.ts";

const catalog: SessionCatalog = testCatalog();
const session = { sessionId: "s-1", attemptId: "att-1" };
const issued: TitleRequestIssue = {
  outcome: "issued",
  message: "Fix the flaky checkout test",
  result: "Done: the retry was racing the cart.",
  connectionId: "conn-1",
  model: "claude-sonnet-5",
};

const answered = (status: number, body: unknown): OutboundResponse => ({
  status,
  text: typeof body === "string" ? body : JSON.stringify(body),
  headers: new Headers(),
});

function harness(options: {
  issue?: TitleRequestIssue;
  answer?: () => OutboundResponse;
  catalog?: SessionCatalog;
}) {
  const settled: Array<{ tokenHash: Uint8Array; title: string | null }> = [];
  const issuedHashes: Uint8Array[] = [];
  const calls: OutboundRequest[] = [];
  const errors: unknown[] = [];
  const store: SessionTitleStore = {
    async issueAtomic(input) {
      issuedHashes.push(input.tokenHash);
      return options.issue ?? issued;
    },
    authorizeAtomic: async () => ({ outcome: "invalid_token" }),
    async settleAtomic(input) {
      settled.push({ tokenHash: input.tokenHash, title: input.title });
      return { outcome: input.title === null ? "kept" : "applied" };
    },
  };
  const titler = createSessionTitler({
    store,
    catalog: options.catalog ?? catalog,
    egressUrl: "http://egress-proxy:3129/",
    http: async (request) => {
      calls.push(request);
      return (
        options.answer?.() ??
        answered(200, {
          content: [{ type: "text", text: "<title>Checkout fix</title>" }],
        })
      );
    },
    onError: (error) => errors.push(error),
  });
  return { titler, settled, issuedHashes, calls, errors };
}

describe("createSessionTitler", () => {
  test("asks the proxy's provider route with the request's own token and writes the answer", async () => {
    const { titler, settled, issuedHashes, calls } = harness({});
    expect(await titler.afterFirstTurn(session)).toBe("applied");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("http://egress-proxy:3129/provider/v1/messages");
    expect(call?.method).toBe("POST");
    expect(call?.timeoutMs).toBe(25_000);
    const headers = call?.headers ?? {};
    expect(hashTitleToken(headers["x-api-key"] ?? "")).toEqual(
      issuedHashes[0] as Uint8Array,
    );
    const body = JSON.parse(call?.body ?? "");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain("Fix the flaky checkout test");
    expect(body.messages[0].content).toContain("racing the cart");
    expect(settled).toEqual([
      { tokenHash: issuedHashes[0] as Uint8Array, title: "Checkout fix" },
    ]);
  });

  test("a Responses connection is not asked: the derived title stays", async () => {
    const { titler, calls, settled } = harness({
      catalog: testCatalog({
        connections: {
          "conn-1": testConnection({
            provider: {
              kind: "openai_responses",
              endpoint: "https://api.openai.invalid",
              auth: {
                kind: "api_key",
                value: "k",
                ref: { stored: "connection:conn-1" },
              },
            },
          }),
        },
      }),
    });
    expect(await titler.afterFirstTurn(session)).toBe("kept");
    expect(calls).toHaveLength(0);
    expect(settled.map((entry) => entry.title)).toEqual([null]);
  });

  test("a refused call settles with no title and reports why", async () => {
    const { titler, settled, errors } = harness({
      answer: () => {
        throw new WorkspaceMcpOutboundError(
          "answered",
          "Provider answered 529",
          {
            status: 529,
          },
        );
      },
    });
    expect(await titler.afterFirstTurn(session)).toBe("kept");
    expect(settled.map((entry) => entry.title)).toEqual([null]);
    expect(String(errors[0])).toContain("529");
  });

  test("a redirect or a 4xx is not a title: the derived one stays", async () => {
    for (const status of [302, 403]) {
      const { titler, settled, errors } = harness({
        answer: () => answered(status, ""),
      });
      expect(await titler.afterFirstTurn(session)).toBe("kept");
      expect(settled.map((entry) => entry.title)).toEqual([null]);
      expect(String(errors[0])).toContain(String(status));
    }
  });

  test("an untagged answer settles with no title so the derived one stays", async () => {
    const { titler, settled } = harness({
      answer: () =>
        answered(200, {
          content: [{ type: "text", text: "제목: 사용자가 묻는 질문 분석" }],
        }),
    });
    await titler.afterFirstTurn(session);
    expect(settled.map((entry) => entry.title)).toEqual([null]);
  });

  test("a thrown request never rejects", async () => {
    const { titler, settled } = harness({
      answer: () => {
        throw new TypeError("connection refused");
      },
    });
    expect(await titler.afterFirstTurn(session)).toBe("kept");
    expect(settled.map((entry) => entry.title)).toEqual([null]);
  });

  test("a session the store skips is not asked about", async () => {
    const { titler, calls, settled } = harness({
      issue: { outcome: "skipped" },
    });
    expect(await titler.afterFirstTurn(session)).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(settled).toHaveLength(0);
  });

  test("a connection gone from the catalog keeps the derived title", async () => {
    const { titler, calls, settled } = harness({
      catalog: { connections: {}, repositories: {} },
    });
    expect(await titler.afterFirstTurn(session)).toBe("kept");
    expect(calls).toHaveLength(0);
    expect(settled.map((entry) => entry.title)).toEqual([null]);
  });
});

describe("titleOf", () => {
  const answer = (text: string) => ({ content: [{ type: "text", text }] });

  test("keeps the first line, without quotes or a closing period", () => {
    expect(titleOf(answer('<title>"Fix checkout."</title>\n'))).toBe(
      "Fix checkout",
    );
    expect(titleOf(answer("<title>「결제 테스트 수정」</title>"))).toBe(
      "결제 테스트 수정",
    );
  });

  test("an answer that explains itself instead of titling is no title", () => {
    // Shape of the leak seen in a session list: a label plus the model's own
    // analysis of the request, on one line.
    const leaked =
      '접근 가능한 저장소 제목: 사용자가 묻는 "어떤 저장소들에 접근 가능해"는 Korean question about accessible repositories';
    expect(titleOf(answer(leaked))).toBeNull();
    // Ambiguous shapes are refused rather than guessed at.
    expect(
      titleOf(answer(`<title>${leaked}\n저장소 접근 문의</title>`)),
    ).toBeNull();
    expect(
      titleOf(
        answer(`<title>${leaked}</title>\n<title>저장소 접근 문의</title>`),
      ),
    ).toBeNull();
  });

  test("cuts a long answer like a derived title", () => {
    const title = titleOf(answer(`<title>${"word ".repeat(40)}</title>`));
    expect(title?.endsWith("…")).toBe(true);
    expect([...(title ?? "")].length).toBeLessThanOrEqual(80);
  });

  test("an empty or malformed answer is no title", () => {
    expect(titleOf(answer("  \n "))).toBeNull();
    expect(titleOf(answer("<title> </title>"))).toBeNull();
    expect(titleOf({ content: [{ type: "tool_use" }] })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });
});
