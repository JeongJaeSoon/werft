import type { AuthorizationSubject } from "@werft-ai/contracts";
import { z } from "zod";
import type { AuthorizationPolicy } from "../../musterrolle/index.ts";
import {
  type WerftMcpCall,
  type WerftMcpPart,
  type WerftMcpPartContext,
  werftTool,
} from "../part.ts";

/**
 * What the status tool reads about one session, all of it already the
 * session's or its agent's. No column that holds a secret is read: a
 * credential is told only by whether it is set.
 */
export type WerftStatusFacts = {
  workspaceId: string;
  agentId: string;
  /**
   * The person asking: the requester of the attempt's running turn (its
   * root's for a push follow-up), else whoever started the session. Null
   * when none is a person, such as a key's session.
   */
  requesterUserId: string | null;
  github: {
    /** The workspace has a GitHub App with an installation not suspended. */
    app: boolean;
    /** The agent's GitHub switch, now and as the session started. */
    agentEnabled: boolean;
    /** The repositories the session's GitHub settings name. */
    repositories: readonly { owner: string; name: string }[];
  };
  slack: {
    /** The agent has a Slack app: one Werft created, or a linked identity. */
    app: boolean;
    /** The agent's bot identity is active, so the app is installed. */
    identity: boolean;
    /** The channels the agent listens in. */
    channels: readonly {
      /** Null for a channel no conversation has started in yet. */
      conversationId: string | null;
      channelId: string;
      /** The name last seen; null when none was kept. */
      name: string | null;
      private: boolean;
      listen: "free" | "mention";
    }[];
  };
  /** The workspace MCP servers the session started with. */
  workspaceMcpServers: readonly string[];
  /** The skill bundles on the session. */
  skills: readonly { name: string; scope: "workspace" | "agent" | "session" }[];
  /** The engine tools the release allows. */
  tools: readonly string[];
};

export interface WerftStatusStore {
  /** Null when the session pins no agent release. */
  factsOf(call: WerftMcpCall): Promise<WerftStatusFacts | null>;
}

export const WERFT_STATUS_TOOL = "get_status";

// Every console link reads this one site, as the console's does.
const DOCS_SITE_URL = "https://jeongjaesoon.github.io/werft/";
const docsOf = (page: string) => ({
  ko: `${DOCS_SITE_URL}ko/${page}/`,
  en: `${DOCS_SITE_URL}en/${page}/`,
  ja: `${DOCS_SITE_URL}ja/${page}/`,
});

type State = "connected" | "not_connected" | "not_allowed";

function setupOf(agentId: string) {
  const agent = (tab: string) => `/agents/${agentId}?tab=${tab}`;
  return {
    githubApp: {
      menu: "Settings > Workspace > Integrations > GitHub",
      path: "/settings/workspace/integrations/github",
      docs: docsOf("integrations/github"),
    },
    githubAgent: {
      menu: "Agents > this agent > GitHub",
      path: agent("github"),
      docs: docsOf("integrations/github"),
    },
    slack: {
      menu: "Agents > this agent > Slack",
      path: agent("slack"),
      docs: docsOf("integrations/slack"),
    },
    mcp: {
      menu: "Settings > Workspace > MCP servers, then Agents > this agent > Access",
      path: agent("access"),
      docs: docsOf("agents/permissions"),
    },
    skills: {
      menu: "Settings > Workspace > Skills, then Agents > this agent > Access",
      path: agent("access"),
      docs: docsOf("agents/permissions"),
    },
    tools: {
      menu: "Agents > this agent > Release",
      path: agent("release"),
      docs: docsOf("agents/permissions"),
    },
  };
}

/** The requester as the authorization policy judges them, re-read there. */
function subjectOf(
  facts: WerftStatusFacts,
  userId: string,
): AuthorizationSubject {
  return {
    // The policy re-reads the role and holds the scopes to it; a member with
    // no scope is only where that reading starts.
    principal: {
      kind: "user",
      id: userId,
      workspace_id: facts.workspaceId,
      role: "member",
      scopes: [],
    },
    actor_user_id: userId,
    surface: { kind: "api" },
  };
}

/**
 * What the requester may see beyond the states and menus (decision 26):
 * repository and channel names when they are inside the agent, as its
 * settings screen asks, and a private channel only while they are its
 * member. Whatever cannot be confirmed is hidden.
 */
async function visibleTo(
  authorization: AuthorizationPolicy,
  facts: WerftStatusFacts,
  requestId: string,
): Promise<{ details: boolean; privateChannels: ReadonlySet<string> }> {
  const none = { details: false, privateChannels: new Set<string>() };
  const userId = facts.requesterUserId;
  if (userId === null) return none;
  const subject = subjectOf(facts, userId);
  try {
    const decision = await authorization.authorize(
      {
        subject,
        action: "agent.read",
        resource: {
          kind: "agent",
          id: facts.agentId,
          owner_scope: facts.workspaceId,
        },
        request_id: requestId,
      },
      { record: false },
    );
    if (decision.outcome !== "allow") return none;
  } catch {
    return none;
  }
  const askPrivate = facts.slack.channels.some((channel) => channel.private);
  let privateChannels: string[] = [];
  if (askPrivate && authorization.privateChannelsOf !== undefined) {
    try {
      privateChannels = await authorization.privateChannelsOf(
        subject,
        facts.workspaceId,
      );
    } catch {
      privateChannels = [];
    }
  }
  return {
    details: true,
    privateChannels: new Set(privateChannels.map((id) => id.toLowerCase())),
  };
}

/** The status an answer carries; a test reads the same shape. */
export async function werftStatusOf(
  deps: { authorization: AuthorizationPolicy; version: string },
  facts: WerftStatusFacts,
  requestId: string,
) {
  const seen = await visibleTo(deps.authorization, facts, requestId);
  const setup = setupOf(facts.agentId);
  const github = facts.github;
  const githubState: State = !github.app
    ? "not_connected"
    : github.agentEnabled && github.repositories.length > 0
      ? "connected"
      : "not_allowed";
  const slack = facts.slack;
  const slackState: State = slack.identity ? "connected" : "not_connected";
  const channels = slack.channels.filter(
    (channel) =>
      !channel.private ||
      (channel.conversationId !== null &&
        seen.privateChannels.has(channel.conversationId.toLowerCase())),
  );
  return {
    werft: { version: deps.version },
    details: seen.details ? "shown" : "hidden",
    github: {
      state: githubState,
      app: github.app ? "connected" : "not_connected",
      agent: github.agentEnabled ? "on" : "off",
      ...(seen.details
        ? {
            repositories: github.repositories.map(
              (repository) => `${repository.owner}/${repository.name}`,
            ),
          }
        : {}),
      setup: github.app ? setup.githubAgent : setup.githubApp,
    },
    slack: {
      state: slackState,
      app: slack.app ? "connected" : "not_connected",
      identity: slack.identity ? "connected" : "not_connected",
      ...(seen.details
        ? {
            channels: channels.map((channel) => ({
              id: channel.channelId,
              name: channel.name,
              private: channel.private,
              listen: channel.listen,
            })),
          }
        : {}),
      setup: setup.slack,
    },
    mcp_servers: {
      servers: [
        ...facts.workspaceMcpServers.map((name) => ({
          name,
          kind: "workspace",
        })),
        ...(githubState === "connected"
          ? [{ name: "github", kind: "built_in" }]
          : []),
        { name: "werft", kind: "built_in" },
      ],
      setup: setup.mcp,
    },
    skills: {
      skills: facts.skills.map((skill) => ({
        name: skill.name,
        scope: skill.scope,
      })),
      setup: setup.skills,
    },
    tools: { tools: [...facts.tools], setup: setup.tools },
  };
}

const DESCRIPTION = [
  "What this agent is connected to in Werft and what it may use, read now: GitHub (the workspace's GitHub App, this agent's switch and repositories), Slack (the agent's app, its bot identity and the channels it listens in), the MCP servers, skills and tools this session runs with, and the Werft version.",
  "Each integration says connected, not_connected or not_allowed (connected for the workspace but not for this agent), with the console menu and documentation where it is set up.",
  "Use it before answering how to connect or set up anything in Werft, and whenever it is unclear whether this agent can reach something: it reads only and is cheap. Prefer it over general CLI advice such as gh auth login.",
  "Repository and channel names appear only when the person asking may see them; a private channel only to its members. It never returns a token, key or other secret, only whether one is set.",
  'Example questions: "Can you use GitHub?", "Which repositories can you push to?", "Which Slack channels do you listen in?", "What tools do you have?", "Which Werft version is this?"',
].join(" ");

/** What this session's agent is connected to and may do, read only. */
export function statusPart(
  context: WerftMcpPartContext,
  deps: { store: WerftStatusStore; authorization: AuthorizationPolicy },
): WerftMcpPart {
  return {
    tools: [
      werftTool({
        name: WERFT_STATUS_TOOL,
        description: DESCRIPTION,
        input: z.object({}).strict(),
        async call(_args, call) {
          const facts = await deps.store.factsOf(call);
          if (facts === null) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "This session runs no agent release, so it has no status to read.",
                },
              ],
            };
          }
          const status = await werftStatusOf(
            { authorization: deps.authorization, version: context.version },
            facts,
            call.requestId,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(status) }],
            structuredContent: status,
          };
        },
      }),
    ],
  };
}
