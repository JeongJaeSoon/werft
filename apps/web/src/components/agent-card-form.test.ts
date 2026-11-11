import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  AGENT_CARD_LANGUAGE_VALUES as CONTRACT_LANGUAGES,
  type ConnectionOption,
} from "@werft-ai/contracts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  cardDraftOf,
  cardFromDraft,
  draftFromCard,
  EMPTY_DRAFT,
  modelOptions,
} from "./agent-card-form.tsx";

const connection = (id: string, models: string[]): ConnectionOption => ({
  id,
  kind: "anthropic",
  billing: "metered",
  models,
  model_successors: {},
});

const CARD: AgentCard = {
  role: "결제 문의 담당",
  instructions: "결제 문의에 답한다.",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
  rules: [],
};

describe("카드 폼 변환", () => {
  test("언어 목록은 contracts의 것이다", () => {
    expect(AGENT_CARD_LANGUAGE_VALUES).toEqual(CONTRACT_LANGUAGES);
  });

  test("카드를 폼으로 옮겼다가 되돌리면 같은 카드다", () => {
    expect<unknown>(cardFromDraft(draftFromCard(CARD), CARD)).toEqual(CARD);
  });

  test("카드에는 도구 칸이 없다: 새 카드의 capabilities는 mcp와 forbidden뿐이다", () => {
    const card = cardFromDraft({ ...EMPTY_DRAFT, model: " m " });
    expect<unknown>(card.capabilities).toEqual({ mcp: null, forbidden: [] });
    expect(card.model).toBe("m");
  });

  test("편집기가 없는 MCP 금지·정책은 원래 카드의 것을 그대로 싣는다", () => {
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        mcp: [{ server: "fake" }],
        forbidden: ["mcp__fake__delete"],
        tool_policy: { per_tool: { mcp__fake__search: "allow" } },
      },
    };
    expect<unknown>(cardFromDraft(draftFromCard(base), base)).toEqual(base);
  });

  test("모델 선택지는 연결이 제공하는 모델을 하나씩 둔다", () => {
    const main = connection("anthropic-main", [
      "claude-haiku-5",
      "claude-sonnet-5",
    ]);
    expect(modelOptions(main, "")).toEqual([
      { model: "claude-haiku-5", offered: true },
      { model: "claude-sonnet-5", offered: true },
    ]);
    expect(modelOptions(main, "claude-sonnet-5")).toHaveLength(2);
  });

  test("연결이 제공하지 않는 지금 모델은 제공되지 않는 선택지로 남는다", () => {
    expect(
      modelOptions(connection("anthropic-main", ["claude-sonnet-5"]), "gpt-x"),
    ).toEqual([
      { model: "claude-sonnet-5", offered: true },
      { model: "gpt-x", offered: false },
    ]);
    expect(modelOptions(undefined, "gpt-x")).toEqual([
      { model: "gpt-x", offered: false },
    ]);
  });

  test("편집기가 없는 rules는 원래 카드의 것을 그대로 싣는다", () => {
    const rules: AgentCard["rules"] = [
      { id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" },
    ];
    const base = { ...CARD, rules };
    expect(cardFromDraft(draftFromCard(base), base).rules).toBe(rules);
    expect(cardFromDraft(EMPTY_DRAFT).rules).toEqual([]);
  });

  test("편집기에 칸이 없는 필드는 칸 하나를 바꿔 저장해도 남는다", () => {
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        ...CARD.capabilities,
        mcp: [{ server: "fake" }],
        tool_policy: { per_tool: { mcp__fake__search: "ask" } },
        credential_refs: ["github/app", "slack:bot"],
      },
      rules: [{ id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" }],
    };
    const draft = { ...draftFromCard(base), language: "en" as const };
    expect<unknown>(cardFromDraft(draft, base)).toEqual({
      ...base,
      language: "en",
    });
  });

  test("편집기의 칸은 모두 바꾼 값으로 저장된다", () => {
    const tool_policy = { per_tool: { mcp__fake__write: "ask" as const } };
    const rules: AgentCard["rules"] = [
      { id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" },
    ];
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        mcp: null,
        forbidden: ["mcp__fake__delete"],
        tool_policy,
        credential_refs: ["github/app"],
      },
      rules,
    };
    const card = cardFromDraft(
      {
        language: "en",
        model: "claude-haiku-5",
      },
      base,
    );
    expect<unknown>(card).toEqual({
      role: CARD.role,
      instructions: CARD.instructions,
      language: "en",
      model: "claude-haiku-5",
      capabilities: {
        mcp: null,
        forbidden: ["mcp__fake__delete"],
        tool_policy,
        credential_refs: ["github/app"],
      },
      rules,
    });
  });

  test("도구 체크 목록이 있던 때 저장된 입력은 그 칸을 버리고 읽고, 모양이 다르면 버린다", () => {
    expect(
      cardDraftOf({
        ...EMPTY_DRAFT,
        toolsMode: "list",
        tools: "Read\n Grep \n",
        forbidden: "Bash",
      }),
    ).toEqual(EMPTY_DRAFT);
    expect(cardDraftOf(EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
    // Input kept before the role and instructions fields left the form.
    expect(
      cardDraftOf({ ...EMPTY_DRAFT, role: "역할", instructions: "지시" }),
    ).toEqual(EMPTY_DRAFT);
    // Input kept while the agent instructions field existed.
    expect(
      cardDraftOf({ ...EMPTY_DRAFT, agentInstructions: "짧게 답한다." }),
    ).toEqual(EMPTY_DRAFT);
    expect(cardDraftOf({ ...EMPTY_DRAFT, language: "fr" })).toBeNull();
    expect(cardDraftOf("x")).toBeNull();
  });

  test("새 카드(base 없음)는 편집기 칸과 기본값만 싣고 역할·지시 사항은 없다", () => {
    expect<unknown>(cardFromDraft({ ...EMPTY_DRAFT, model: "m" })).toEqual({
      language: "follow-user",
      model: "m",
      capabilities: { mcp: null, forbidden: [] },
      rules: [],
    });
  });

  test("카드 언어는 사용자 언어 따라가기와 ko·en·ja를 고를 수 있고, 저장된 카드는 가진 값을 그대로 둔다", () => {
    expect(AGENT_CARD_LANGUAGE_VALUES).toEqual([
      "follow-user",
      "ko",
      "en",
      "ja",
    ]);
    for (const language of AGENT_CARD_LANGUAGE_VALUES) {
      expect(cardDraftOf({ ...EMPTY_DRAFT, language })).toEqual({
        ...EMPTY_DRAFT,
        language,
      });
    }
    expect(draftFromCard({ ...CARD, language: "ko" }).language).toBe("ko");
  });
});
