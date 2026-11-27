import { describe, expect, test } from "bun:test";
import { createAuthorizationPolicy } from "../../musterrolle/policy.ts";
import { createWerftMcpServer } from "../server.ts";
import {
  statusPart,
  WERFT_STATUS_TOOL,
  type WerftStatusFacts,
  werftStatusOf,
} from "./status.ts";

const WORKSPACE = "6f1f3b1e-0000-4000-8000-000000000001";
const AGENT = "6f1f3b1e-0000-4000-8000-0000000000a1";
const INSIDER = "6f1f3b1e-0000-4000-8000-0000000000b1";
const OUTSIDER = "6f1f3b1e-0000-4000-8000-0000000000b2";
const PRIVATE_CONVERSATION = "6f1f3b1e-0000-4000-8000-0000000000c1";
const OTHER_PRIVATE_CONVERSATION = "6f1f3b1e-0000-4000-8000-0000000000c2";
const PUBLIC_CONVERSATION = "6f1f3b1e-0000-4000-8000-0000000000c3";

function factsFor(
  requesterUserId: string | null,
  change: Partial<WerftStatusFacts> = {},
): WerftStatusFacts {
  return {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    requesterUserId,
    // The requester's own DM unless a test moves it.
    replyTo:
      requesterUserId === null
        ? null
        : { kind: "dm", personUserId: requesterUserId },
    github: {
      app: true,
      agentEnabled: true,
      repositories: [{ owner: "acme", name: "api" }],
    },
    slack: {
      app: true,
      identity: true,
      channels: [
        {
          conversationId: PUBLIC_CONVERSATION,
          channelId: "C0PUBLIC",
          name: "general",
          private: false,
          listen: "free",
        },
        {
          conversationId: PRIVATE_CONVERSATION,
          channelId: "C0SECRET",
          name: "launch-plans",
          private: true,
          listen: "mention",
        },
        {
          conversationId: OTHER_PRIVATE_CONVERSATION,
          channelId: "C0OTHER",
          name: "board",
          private: true,
          listen: "free",
        },
        {
          conversationId: null,
          channelId: "C0NEW",
          name: null,
          private: true,
          listen: "free",
        },
      ],
    },
    workspaceMcpServers: ["linear"],
    skills: [{ name: "review", scope: "workspace" }],
    tools: ["Read", "Bash"],
    ...change,
  };
}

// The insider administers the agent; only C0SECRET has them as a member.
function policy(
  options: {
    fails?: boolean;
    pending?: boolean;
    inline?: string[];
    asked?: string[];
  } = {},
) {
  return createAuthorizationPolicy({
    agents: {
      async agentOf(_workspaceId, resource) {
        if (options.fails) throw new Error("store down");
        return resource.kind === "agent" ? resource.id : null;
      },
      async isAdmin(_workspaceId, agentId, userId) {
        return agentId === AGENT && userId === INSIDER;
      },
    },
    sessions: {
      async visibleTo() {
        return true;
      },
      async originOf() {
        throw new Error("not used");
      },
      async privateChannels() {
        options.asked?.push("privateChannels");
        return [
          {
            conversationId: PRIVATE_CONVERSATION,
            agentId: AGENT,
            channelId: "C0SECRET",
          },
          {
            conversationId: OTHER_PRIVATE_CONVERSATION,
            agentId: AGENT,
            channelId: "C0OTHER",
          },
        ];
      },
    },
    channelMembers: {
      async isMember({ channelId, userId }) {
        options.inline?.push(channelId);
        return channelId === "C0SECRET" && userId === INSIDER;
      },
      async membership({ channelId, userId }) {
        return channelId === "C0SECRET" && userId === INSIDER
          ? "member"
          : "not_member";
      },
      async cachedMembership({ channelId, userId }) {
        if (options.pending) return "pending";
        return channelId === "C0SECRET" && userId === INSIDER
          ? "member"
          : "not_member";
      },
    },
  });
}

const status = (facts: WerftStatusFacts, authorization = policy()) =>
  werftStatusOf({ authorization, version: "v9.9.9" }, facts, "request-1");

describe("the status tool", () => {
  test("someone inside the agent sees its repositories, public channels and the private channels they are a member of", async () => {
    const answer = await status(factsFor(INSIDER));
    expect(answer.details).toBe("shown");
    expect(answer.github).toMatchObject({
      state: "connected",
      repositories: ["acme/api"],
    });
    expect(answer.slack.channels?.map((channel) => channel.id)).toEqual([
      "C0PUBLIC",
      "C0SECRET",
    ]);
    expect(answer).not.toHaveProperty("incomplete");
  });

  // 94S-2270 (Architect answer): a model's tool call never sends Slack a
  // question. A private channel whose members are not cached is left out,
  // and the answer says only that it may be incomplete.
  test("a private channel not yet confirmed is left out, the answer says incomplete, and Slack is not asked", async () => {
    const inline: string[] = [];
    const answer = await status(
      factsFor(INSIDER),
      policy({ pending: true, inline }),
    );
    expect(answer.slack.channels?.map((channel) => channel.id)).toEqual([
      "C0PUBLIC",
    ]);
    expect(answer.incomplete).toBe(true);
    expect(inline).toEqual([]);
  });

  // 94S-2292 (Architect, 2026-11-26): membership is the requester's, and
  // the place the answer goes is looked at too. A private channel is named
  // only in that channel itself or in the requester's own DM.
  describe("names a private channel only where the answer goes", () => {
    const shownIn = async (
      replyTo: WerftStatusFacts["replyTo"],
      authorization = policy(),
    ) => {
      const answer = await status(
        factsFor(INSIDER, { replyTo }),
        authorization,
      );
      expect(answer.details).toBe("shown");
      return answer.slack.channels?.map((channel) => channel.id);
    };

    test("the requester's own DM: every private channel they are a member of", async () => {
      expect(
        await shownIn({ kind: "dm", personUserId: INSIDER.toUpperCase() }),
      ).toEqual(["C0PUBLIC", "C0SECRET"]);
    });

    test("that private channel itself: it, and no other private channel", async () => {
      expect(
        await shownIn({
          kind: "channel",
          conversationId: PRIVATE_CONVERSATION.toUpperCase(),
        }),
      ).toEqual(["C0PUBLIC", "C0SECRET"]);
    });

    test("a public channel, someone else's DM, or no conversation: no private channel, though the requester is a member, and none is asked about", async () => {
      for (const replyTo of [
        { kind: "channel", conversationId: PUBLIC_CONVERSATION },
        { kind: "dm", personUserId: OUTSIDER },
        null,
      ] as const) {
        const asked: string[] = [];
        const answer = await status(
          factsFor(INSIDER, { replyTo }),
          policy({ pending: true, asked }),
        );
        expect(answer.slack.channels?.map((channel) => channel.id)).toEqual([
          "C0PUBLIC",
        ]);
        // Nothing left out could have been shown here, so none is pending.
        expect(answer).not.toHaveProperty("incomplete");
        expect(asked).toEqual([]);
        const text = JSON.stringify(answer);
        for (const hidden of ["C0SECRET", "launch-plans", "C0OTHER", "board"]) {
          expect(text).not.toContain(hidden);
        }
      }
    });

    test("another private channel: not the one the requester is a member of, nor that one while they are not its member", async () => {
      expect(
        await shownIn({
          kind: "channel",
          conversationId: OTHER_PRIVATE_CONVERSATION,
        }),
      ).toEqual(["C0PUBLIC"]);
    });

    test("that private channel itself, not yet confirmed: left out and incomplete", async () => {
      const answer = await status(
        factsFor(INSIDER, {
          replyTo: { kind: "channel", conversationId: PRIVATE_CONVERSATION },
        }),
        policy({ pending: true }),
      );
      expect(answer.slack.channels?.map((channel) => channel.id)).toEqual([
        "C0PUBLIC",
      ]);
      expect(answer.incomplete).toBe(true);
    });
  });

  test("someone outside the agent sees each state and where to set it up, and no name", async () => {
    const answer = await status(factsFor(OUTSIDER));
    expect(answer.details).toBe("hidden");
    expect(answer.github.state).toBe("connected");
    expect(answer.slack.state).toBe("connected");
    expect("repositories" in answer.github).toBe(false);
    expect("channels" in answer.slack).toBe(false);
    expect(answer.github.setup.path).toBe(`/agents/${AGENT}?tab=github`);
    const text = JSON.stringify(answer);
    for (const name of ["acme/api", "general", "launch-plans", "board"]) {
      expect(text).not.toContain(name);
    }
  });

  test("a session no person asked in, and a policy that cannot answer, show no names", async () => {
    for (const answer of [
      await status(factsFor(null)),
      await status(factsFor(INSIDER), policy({ fails: true })),
    ]) {
      expect(answer.details).toBe("hidden");
      expect("repositories" in answer.github).toBe(false);
      expect("channels" in answer.slack).toBe(false);
    }
  });

  test("GitHub reads not connected without the workspace's app, and not allowed when this agent is off or names no repository", async () => {
    const none = await status(
      factsFor(INSIDER, {
        github: { app: false, agentEnabled: true, repositories: [] },
      }),
    );
    expect(none.github.state).toBe("not_connected");
    expect(none.github.setup.path).toBe(
      "/settings/workspace/integrations/github",
    );
    for (const github of [
      {
        app: true,
        agentEnabled: false,
        repositories: [{ owner: "a", name: "b" }],
      },
      { app: true, agentEnabled: true, repositories: [] },
    ]) {
      const answer = await status(factsFor(INSIDER, { github }));
      expect(answer.github.state).toBe("not_allowed");
      expect(answer.mcp_servers.servers.map((s) => s.name)).toEqual([
        "linear",
        "werft",
      ]);
    }
  });

  test("Slack reads not connected until the bot identity is active", async () => {
    const answer = await status(
      factsFor(INSIDER, {
        slack: { app: true, identity: false, channels: [] },
      }),
    );
    expect(answer.slack).toMatchObject({
      state: "not_connected",
      app: "connected",
      identity: "not_connected",
    });
  });

  test("the server serves it read only, with the version, the session's servers, skills and tools", async () => {
    const handle = createWerftMcpServer({
      parts: [
        statusPart(
          { version: "v9.9.9" },
          {
            store: { factsOf: async () => factsFor(INSIDER) },
            authorization: policy(),
          },
        ),
      ],
      version: "v9.9.9",
    });
    const grant = { sessionId: "session-1", attemptId: "att_1" };
    const listed = await handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "request-1",
    );
    expect(listed?.result).toMatchObject({
      tools: [{ name: WERFT_STATUS_TOOL, annotations: { readOnlyHint: true } }],
    });
    const called = await handle(
      grant,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: WERFT_STATUS_TOOL, arguments: {} },
      },
      "request-2",
    );
    const result = called?.result as {
      structuredContent: Awaited<ReturnType<typeof status>>;
    };
    expect(result.structuredContent).toMatchObject({
      werft: { version: "v9.9.9" },
      mcp_servers: {
        servers: [
          { name: "linear", kind: "workspace" },
          { name: "github", kind: "built_in" },
          { name: "werft", kind: "built_in" },
        ],
      },
      skills: { skills: [{ name: "review", scope: "workspace" }] },
      tools: { tools: ["Read", "Bash"] },
    });
  });

  test("a policy that could not read its store fails the call, to be tried again, instead of hiding names", async () => {
    const down = new Error("connection terminated");
    const undecided = createAuthorizationPolicy({
      agents: {
        async agentOf() {
          throw down;
        },
        async isAdmin() {
          return false;
        },
      },
      storageUnavailable: (error) => error === down,
    });
    const handle = createWerftMcpServer({
      parts: [
        statusPart(
          { version: "v9.9.9" },
          {
            store: { factsOf: async () => factsFor(INSIDER) },
            authorization: undecided,
          },
        ),
      ],
      version: "v9.9.9",
    });
    const called = await handle(
      { sessionId: "session-1", attemptId: "att_1" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: WERFT_STATUS_TOOL, arguments: {} },
      },
      "request-1",
    );
    expect(called?.result).toMatchObject({
      isError: true,
      content: [
        {
          text: "The Werft server could not answer this call. Try it again.",
        },
      ],
    });
    expect(called?.result).not.toHaveProperty("structuredContent");
  });

  test("a session with no release gets an error answer, not a status", async () => {
    const handle = createWerftMcpServer({
      parts: [
        statusPart(
          { version: "v9.9.9" },
          { store: { factsOf: async () => null }, authorization: policy() },
        ),
      ],
      version: "v9.9.9",
    });
    const called = await handle(
      { sessionId: "session-1", attemptId: "att_1" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: WERFT_STATUS_TOOL, arguments: {} },
      },
      "request-1",
    );
    expect(called?.result).toMatchObject({ isError: true });
  });
});
