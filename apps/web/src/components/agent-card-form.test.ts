import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  AGENT_CARD_LANGUAGE_VALUES as CONTRACT_LANGUAGES,
  type ProfileSummary,
} from "@werft-ai/contracts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  cardDraftOf,
  cardFromDraft,
  draftFromCard,
  EMPTY_DRAFT,
  modelOptions,
  previewProfiles,
} from "./agent-card-form.tsx";

const profile = (id: string, model: string): ProfileSummary => ({
  id,
  source: "operator",
  model,
  models: [model],
  tools: [],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  billing: "none",
  repository_mode: "required",
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

  test("모델 선택지는 카탈로그의 모델을 한 번씩, 그 모델을 쓰는 profile과 함께 둔다", () => {
    const profiles = [
      profile("coding-fast", "claude-haiku-5"),
      profile("coding-local", "claude-sonnet-5"),
      profile("coding-review", "claude-sonnet-5"),
    ];
    expect(modelOptions(profiles, "")).toEqual([
      { model: "claude-haiku-5", profileIds: ["coding-fast"] },
      {
        model: "claude-sonnet-5",
        profileIds: ["coding-local", "coding-review"],
      },
    ]);
    expect(modelOptions(profiles, "claude-sonnet-5")).toHaveLength(2);
  });

  test("카탈로그에 없는 지금 모델은 profile 없는 선택지로 남는다", () => {
    expect(
      modelOptions([profile("coding-local", "claude-sonnet-5")], "gpt-x"),
    ).toEqual([
      { model: "claude-sonnet-5", profileIds: ["coding-local"] },
      { model: "gpt-x", profileIds: [] },
    ]);
    expect(modelOptions([], "gpt-x")).toEqual([
      { model: "gpt-x", profileIds: [] },
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
      language: "ko",
      model: "m",
      capabilities: { mcp: null, forbidden: [] },
      rules: [],
    });
  });
});

describe("미리보기 프로필", () => {
  const withTools = (
    id: string,
    tools: string[],
    over: Partial<ProfileSummary> = {},
  ): ProfileSummary => ({
    ...profile(id, "claude-sonnet-5"),
    repository_mode: "optional",
    tools,
    ...over,
  });
  const wide = withTools("wide", ["Read", "Edit", "Bash"]);
  const narrow = withTools("narrow", ["Read", "Edit"]);
  const required = withTools("required", ["Read", "Bash"], {
    repository_mode: "required",
  });
  const otherModel = withTools("haiku", ["Read"], {
    model: "claude-haiku-5",
    models: ["claude-haiku-5"],
  });
  const secondModel = withTools("both", ["Read"], {
    model: "claude-haiku-5",
    models: ["claude-haiku-5", "claude-sonnet-5"],
  });
  const profiles = [wide, required, otherModel, narrow, secondModel];
  const releasable = (p: ProfileSummary) => p.repository_mode !== "required";

  test("미리보기 후보는 카드 모델을 돌리는 프로필이고, 마법사는 릴리스할 수 있는 것을 먼저 둔다", () => {
    expect(
      previewProfiles(profiles, "claude-sonnet-5").map((p) => p.id),
    ).toEqual(["wide", "required", "narrow", "both"]);
    expect(
      previewProfiles(profiles, "claude-sonnet-5", releasable).map((p) => p.id),
    ).toEqual(["wide", "narrow", "both"]);
    // None it can release: the flow sends that card to the releases tab.
    expect(
      previewProfiles([required], "claude-sonnet-5", releasable).map(
        (p) => p.id,
      ),
    ).toEqual(["required"]);
  });
});
