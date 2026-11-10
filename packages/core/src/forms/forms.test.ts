import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  acceptInviteRequestSchema,
  createAgentRequestSchema,
  createInviteRequestSchema,
} from "@werft-ai/contracts";
import {
  type AgentCardDraft,
  acceptInviteStep,
  agentCardStep,
  agentIdentityStep,
  agentReleaseStep,
  inviteStep,
} from "./index.ts";

const BASE: AgentCard = {
  role: "Support agent",
  instructions: "Answer refund questions.",
  language: "en",
  model: "claude-sonnet-5",
  capabilities: {
    mcp: null,
    forbidden: ["mcp__docs__delete"],
    tool_policy: { per_tool: { mcp__docs__search: "ask" } },
    credential_refs: ["github/app", "slack:bot"],
  },
  rules: [{ id: "r1", text: "Hand refunds to a person.", source: "user" }],
};

const DRAFT: AgentCardDraft = {
  language: "en",
  model: "claude-sonnet-5",
};

const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join(".")) ?? [];

describe("steps validate trimmed values", () => {
  test("whitespace alone is empty", () => {
    const result = agentIdentityStep.safeParse({
      slug: "   ",
      name: " \t ",
      description: "  ",
    });
    expect(
      result.error?.issues
        .filter((issue) => issue.code === "too_small")
        .map((issue) => issue.path.join(".")),
    ).toEqual(["slug", "name"]);
  });

  test("the release step needs a connection and sends it and the repository trimmed", () => {
    expect(
      agentReleaseStep.safeParse({
        connection_id: "  ",
        repository_id: "",
      }).success,
    ).toBe(false);
    expect(
      agentReleaseStep.parse({
        connection_id: " anthropic-main ",
        repository_id: " sample-app ",
      }),
    ).toEqual({
      connection_id: "anthropic-main",
      repository_id: "sample-app",
    });
  });

  test("the value sent is the trimmed one", () => {
    expect(
      agentIdentityStep.parse({
        slug: "  refunds ",
        name: " Refunds  ",
        description: " Answers refund questions.\n",
      }),
    ).toEqual({
      slug: "refunds",
      name: "Refunds",
      description: "Answers refund questions.",
    });
    expect(
      inviteStep.parse({ email: " ada@example.com ", role: "member" }),
    ).toEqual({ email: "ada@example.com", role: "member" });
  });

  test("the contract's own limits apply after the trim", () => {
    const long = `  ${"a".repeat(64)}  `;
    const identity = { name: "x", description: "" };
    expect(
      agentIdentityStep.safeParse({ ...identity, slug: long }).success,
    ).toBe(true);
    expect(
      agentIdentityStep.safeParse({ ...identity, slug: `${long}a` }).success,
    ).toBe(false);
    expect(
      agentIdentityStep.safeParse({ ...identity, slug: "Not Kebab" }).success,
    ).toBe(false);
    const description = ` ${"d".repeat(2_000)} `;
    expect(
      agentIdentityStep.safeParse({ ...identity, slug: "x", description })
        .success,
    ).toBe(true);
    expect(
      paths(
        agentIdentityStep.safeParse({
          ...identity,
          slug: "x",
          description: `${description}d`,
        }),
      ),
    ).toEqual(["description"]);
  });

  test("a card field of whitespace fails on that field", () => {
    const result = agentCardStep().safeParse({ ...DRAFT, model: "   " });
    expect(paths(result)).toEqual(["model"]);
  });
});

describe("the card step keeps what its base has", () => {
  test("a field the form has no input for survives an edit, earlier role and instructions included", () => {
    const card = agentCardStep(BASE).parse({ ...DRAFT, language: "ko" });
    expect<unknown>(card).toEqual({ ...BASE, language: "ko" });
  });

  test("a new card has no role or instructions", () => {
    const card = agentCardStep().parse(DRAFT);
    expect("role" in card).toBe(false);
    expect("instructions" in card).toBe(false);
  });

  test("input kept from a form that had an agent instructions field is read without it", () => {
    const card = agentCardStep().parse({
      ...DRAFT,
      agentInstructions: "Be brief.",
    });
    expect("agent_instructions" in card).toBe(false);
  });

  test("the form's inputs win over the base", () => {
    const card = agentCardStep(BASE).parse({ ...DRAFT, language: "ko" });
    expect(card.language).toBe("ko");
    expect(card.capabilities.forbidden).toEqual(["mcp__docs__delete"]);
    expect(card.capabilities.tool_policy).toEqual(
      BASE.capabilities.tool_policy,
    );
    expect(card.rules).toEqual(BASE.rules);
  });

  test("a card has no tool field to send", () => {
    const card = agentCardStep().parse(DRAFT);
    expect<unknown>(card.capabilities).toEqual({ mcp: null, forbidden: [] });
  });

  test("the MCP server set elsewhere survives a wizard edit", () => {
    const base: AgentCard = {
      ...BASE,
      capabilities: { ...BASE.capabilities, mcp: [{ server: "docs" }] },
    };
    const card = agentCardStep(base).parse(DRAFT);
    expect<unknown>(card.capabilities.mcp).toEqual([{ server: "docs" }]);
  });

  test("the MCP server and the credential names are agent settings: a card edit keeps both as they were", () => {
    const base: AgentCard = {
      ...BASE,
      capabilities: {
        ...BASE.capabilities,
        mcp: [{ server: "docs" }],
        credential_refs: ["docs-key", "wiki-key"],
      },
    };
    const saved = agentCardStep(base).parse({
      ...DRAFT,
      model: "claude-opus-5",
    });
    expect<unknown>(saved.capabilities.mcp).toEqual([{ server: "docs" }]);
    expect(saved.capabilities.credential_refs).toEqual([
      "docs-key",
      "wiki-key",
    ]);
    const again = agentCardStep(saved).parse({
      ...DRAFT,
      model: "claude-opus-5",
    });
    expect<unknown>(again).toEqual(saved);
  });

  test("without a base the contract's defaults fill in", () => {
    const card = agentCardStep().parse(DRAFT);
    expect(card.rules).toEqual([]);
    expect("tool_policy" in card.capabilities).toBe(false);
  });
});

test("the steps join into requests the contract accepts", () => {
  const identity = agentIdentityStep.parse({
    slug: " refunds",
    name: "R ",
    description: "",
  });
  // The first step's team picker adds the managing team.
  const managing_team_id = "019a0000-0000-7000-8000-0000000000c9";
  expect(
    createAgentRequestSchema.safeParse({
      ...identity,
      managing_team_id,
      card: agentCardStep(BASE).parse(DRAFT),
    }).success,
  ).toBe(true);
  expect(
    createAgentRequestSchema.safeParse({
      ...identity,
      managing_team_id,
      card: agentCardStep().parse(DRAFT),
    }).success,
  ).toBe(true);
  const invite = inviteStep.parse({ email: "a@example.com ", role: "admin" });
  expect(createInviteRequestSchema.safeParse(invite).success).toBe(true);
  const accept = acceptInviteStep.parse({
    password: " correct horse ",
    display_name: " Ada ",
  });
  expect(
    acceptInviteRequestSchema.safeParse({ token: "t".repeat(43), ...accept })
      .success,
  ).toBe(true);
});

describe("accepting an invite", () => {
  test("the password keeps its spaces; the name is trimmed", () => {
    expect(
      acceptInviteStep.parse({
        password: " correct horse ",
        display_name: " Ada ",
      }),
    ).toEqual({ password: " correct horse ", display_name: "Ada" });
  });

  test("an empty name is left out instead of failing", () => {
    const accept = acceptInviteStep.parse({
      password: "correct horse battery",
      display_name: "   ",
    });
    expect(accept.display_name).toBeUndefined();
  });

  test("a short password and a long name fail on their own paths", () => {
    expect(
      paths(
        acceptInviteStep.safeParse({
          password: "short",
          display_name: "a".repeat(65),
        }),
      ),
    ).toEqual(["password", "display_name"]);
  });
});
