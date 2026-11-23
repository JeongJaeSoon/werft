import { describe, expect, test } from "bun:test";
import type { CatalogProvider } from "../catalog/catalog.ts";
import {
  OutboundRefusedError,
  type OutboundRequest,
  type OutboundResponse,
} from "../ports/outbound-http.ts";
import { listProviderModels, ModelDiscoveryError } from "./model-discovery.ts";

const KEY = "example-model-key";
const ref = { stored: "connection:c" } as const;

const anthropic: CatalogProvider = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.invalid/",
  auth: { kind: "api_key", value: KEY, ref },
};
const openai: CatalogProvider = {
  kind: "openai_responses",
  endpoint: "https://api.openai.invalid",
  auth: { kind: "api_key", value: KEY, ref },
};
const litellm = (kind: "api_key" | "bearer"): CatalogProvider => ({
  kind: "litellm",
  endpoint: "http://litellm.internal:4000",
  auth: { kind, value: KEY, ref },
});

const answer = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): OutboundResponse => ({
  status,
  headers: new Headers(headers),
  text: typeof body === "string" ? body : JSON.stringify(body),
});

function fake(answers: ReadonlyArray<OutboundResponse | Error>) {
  const sent: OutboundRequest[] = [];
  return {
    sent,
    http: async (request: OutboundRequest) => {
      sent.push(request);
      const next = answers[Math.min(sent.length - 1, answers.length - 1)];
      if (next === undefined) throw new Error("no answer");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelDiscoveryError) {
      return {
        reason: error.reason,
        status: error.status,
        message: error.message,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("listProviderModels", () => {
  test("Anthropic: x-api-key and anthropic-version, page by page by after_id, display names kept", async () => {
    const { sent, http } = fake([
      answer({
        data: [
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          { id: "claude-haiku-5", display_name: "  " },
        ],
        has_more: true,
        last_id: "claude-haiku-5",
      }),
      answer({
        data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
        has_more: false,
        last_id: "claude-opus-5",
      }),
    ]);
    expect(await listProviderModels(anthropic, http)).toEqual({
      models: [
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        { id: "claude-haiku-5", display_name: null },
        { id: "claude-opus-5", display_name: "Claude Opus 5" },
      ],
      skipped: 0,
      truncated: false,
    });
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.anthropic.invalid/v1/models?limit=1000",
      "https://api.anthropic.invalid/v1/models?limit=1000&after_id=claude-haiku-5",
    ]);
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.headers?.["x-api-key"]).toBe(KEY);
    expect(sent[0]?.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(sent[0]?.headers?.authorization).toBeUndefined();
  });

  test("Anthropic: stops after ten pages and says the list was cut", async () => {
    let page = 0;
    const sent: string[] = [];
    const listed = await listProviderModels(anthropic, async (request) => {
      sent.push(request.url);
      page += 1;
      return answer({
        data: [{ id: `model-${page}` }],
        has_more: true,
        last_id: `model-${page}`,
      });
    });
    expect(sent).toHaveLength(10);
    expect(listed.models).toHaveLength(10);
    expect(listed.truncated).toBe(true);
  });

  test("OpenAI: a bearer key, families an agent cannot talk to skipped and counted", async () => {
    const { sent, http } = fake([
      answer({
        object: "list",
        data: [
          { id: "gpt-5.5", object: "model" },
          { id: "text-embedding-3-large" },
          { id: "tts-1-hd" },
          { id: "whisper-1" },
          { id: "gpt-4o-transcribe" },
          { id: "dall-e-3" },
          { id: "gpt-image-1" },
          { id: "omni-moderation-latest" },
          { id: "gpt-realtime" },
          { id: "gpt-audio" },
          { id: "davinci-002" },
          { id: "babbage-002" },
          { id: "o4-mini" },
          { id: "gpt-5.5" },
        ],
      }),
    ]);
    expect(await listProviderModels(openai, http)).toEqual({
      models: [
        { id: "gpt-5.5", display_name: null },
        { id: "o4-mini", display_name: null },
      ],
      skipped: 11,
      truncated: false,
    });
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.openai.invalid/v1/models",
    ]);
    expect(sent[0]?.headers?.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.headers?.["x-api-key"]).toBeUndefined();
  });

  test("LiteLLM: ids only, nothing filtered, the auth shape the sessions use", async () => {
    for (const [kind, header, value] of [
      ["api_key", "x-api-key", KEY],
      ["bearer", "authorization", `Bearer ${KEY}`],
    ] as const) {
      const { sent, http } = fake([
        answer({
          data: [
            { id: "team-claude", display_name: "not read" },
            { id: "text-embedding-3-large" },
            { id: "  team-gpt  " },
            { id: 7 },
            "loose",
            { id: "x".repeat(129) },
          ],
        }),
      ]);
      expect(await listProviderModels(litellm(kind), http)).toEqual({
        models: [
          { id: "team-claude", display_name: null },
          { id: "text-embedding-3-large", display_name: null },
          { id: "team-gpt", display_name: null },
        ],
        skipped: 1,
        truncated: false,
      });
      expect(sent[0]?.url).toBe("http://litellm.internal:4000/v1/models");
      expect(sent[0]?.headers?.[header]).toBe(value);
    }
  });

  test("the provider's answers map to a reason, and a status where it answered", async () => {
    const cases: Array<[OutboundResponse | Error, string, number | null]> = [
      [answer("no", 401), "provider_unauthorized", 401],
      [answer("no", 403), "provider_unauthorized", 403],
      [
        answer("", 302, { location: "https://elsewhere.invalid" }),
        "provider_answered",
        302,
      ],
      [answer("missing", 404), "provider_answered", 404],
      [answer("slow down", 429), "provider_answered", 429],
      [answer("<html>"), "provider_failed", null],
      [answer({ models: [] }), "provider_failed", null],
      [
        new OutboundRefusedError("unreachable", "down"),
        "provider_unreachable",
        null,
      ],
      [
        new OutboundRefusedError("answered", "Provider answered 502"),
        "provider_unreachable",
        null,
      ],
      [
        new OutboundRefusedError("address_not_allowed", "private"),
        "address_not_allowed",
        null,
      ],
    ];
    for (const [given, expected, status] of cases) {
      const refused = await reason(
        listProviderModels(openai, fake([given]).http),
      );
      expect<unknown[]>([refused.reason, refused.status]).toEqual([
        expected,
        status,
      ]);
    }
  });

  test("a provider that sends the key back is refused whole, escaped or not, and the key is in no message", async () => {
    const escaped = (text: string) =>
      [...text]
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
    for (const given of [
      // Cut at 200 characters, this name would keep all of the key but its last character.
      answer(
        `{"data":[{"id":"m","display_name":"${"x".repeat(200 - KEY.length + 1)}${escaped(KEY)}"}]}`,
      ),
      answer(`{"data":[{"id":"m"}],"note":"${escaped(KEY)}"}`),
      answer({ data: [{ id: `model-${KEY}` }] }),
      answer({ data: [{ id: "m" }] }, 200, { "x-echo": KEY }),
      answer(
        `{"data":[{"id":"m","display_name":"${[...KEY].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}]}`,
      ),
    ]) {
      const refused = await reason(
        listProviderModels(anthropic, fake([given]).http),
      );
      expect(refused.reason).toBe("credential_reflected");
      expect(refused.message).not.toContain(KEY);
    }
    const unauthorized = await reason(
      listProviderModels(anthropic, fake([answer(`bad key ${KEY}`, 401)]).http),
    );
    expect(unauthorized.message).not.toContain(KEY);
  });
});
