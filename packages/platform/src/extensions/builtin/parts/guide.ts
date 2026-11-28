import { createHash } from "node:crypto";
import { z } from "zod";
import { WERFT_FIRST_RULE } from "../instructions.ts";
import {
  type WerftMcpPart,
  type WerftMcpPartContext,
  type WerftMcpPrompt,
  werftTool,
} from "../part.ts";

/** The usage skill's name: its directory and its frontmatter `name`. */
export const WERFT_SKILL_NAME = "werft";
/** Where the skill's `SKILL.md` is read, as the Skills over MCP extension maps it. */
export const WERFT_SKILL_URI = `skill://${WERFT_SKILL_NAME}/SKILL.md`;
const SKILL_DESCRIPTION =
  "How to answer a question about Werft itself (what this agent is connected to, what it may do here, how to set something up) from the built-in werft MCP server instead of general knowledge.";

/**
 * The usage skill, one file and the same bytes in every session of a
 * version: no script, no `allowed-tools`, nothing a host runs. It names no
 * tool of another part; a tool is found by its description.
 */
export const WERFT_SKILL = `---
name: ${WERFT_SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Answering questions about Werft

Werft is the platform this agent runs on. The built-in werft MCP server answers for the installed version of Werft: its documentation, and what this agent is connected to and allowed to do right now. It only reads.

## When this applies

Questions like these are about Werft, not about a tool in general:

- "Can you use GitHub?" "Which repositories can you push to?"
- "Are you connected to Slack?" "Why did you not answer in that channel?"
- "Which MCP servers, skills or tools do you have?"
- "Why was that refused?"
- "How do I connect GitHub to this agent?" "Where do I change this setting?"

## How to answer

1. Check this agent's status on the werft server first. The check only reads and is cheap, so do it also when it is unclear whether the question is about Werft.
2. Answer from that status. For each integration, say whether it is connected, not connected, or not allowed for this agent, and name the Werft console menu where that is changed.
3. For how to set something up or change it, search the documentation on the werft server and give the page and its link.
4. Do not answer with a command-line tool's own setup steps, such as \`gh auth login\` or creating a personal token. In Werft a person connects GitHub and Slack for an agent in the Werft console; the agent does not log in by itself.

## Limits

- The werft server never returns a secret value such as a token or a key. It says only whether one is set. Do not ask for one and do not make one up.
- Some details, such as the names of private repositories or channels, are shown only to people allowed to see them. When one is left out, say that it is not shown, not that it does not exist.
`;

const SKILL_BYTES = new TextEncoder().encode(WERFT_SKILL);

/**
 * The skill's entry as the Skills over MCP extension describes it: its
 * frontmatter and a complete manifest with each file's digest, so a host
 * binds its approval to these bytes.
 */
export const WERFT_SKILL_ENTRY = {
  uri: WERFT_SKILL_URI,
  frontmatter: { name: WERFT_SKILL_NAME, description: SKILL_DESCRIPTION },
  resources: [
    {
      uri: WERFT_SKILL_URI,
      digest: `sha256:${createHash("sha256").update(SKILL_BYTES).digest("hex")}`,
      size: SKILL_BYTES.byteLength,
    },
  ],
} as const;

const READ_SKILL_DESCRIPTION = [
  `Reads this server's usage guide: how to answer a question about Werft itself. It is the same text as the skill ${WERFT_SKILL_URI}, for an engine that does not load skills from an MCP server.`,
  WERFT_FIRST_RULE,
  "Read it once, before answering the first such question in a conversation. It returns the guide as Markdown. It never returns a secret value such as a token or a key.",
  'Example questions it helps answer: "Can you use GitHub?", "Are you connected to Slack?", "How do I let this agent push to a repository?", "Why was that refused?"',
].join("\n\n");

function asked(text: string) {
  return {
    messages: [
      { role: "user" as const, content: { type: "text" as const, text } },
    ],
  };
}

const NO_CLI =
  "Do not suggest a command-line login or a personal token: in Werft a person connects it for this agent in the Werft console.";

const PROMPTS: WerftMcpPrompt[] = [
  {
    name: "check_github_connection",
    title: "Check the GitHub connection",
    description:
      "Checks whether this agent can use GitHub in Werft, and where that is changed in the console.",
    get: async () =>
      asked(
        `Check whether you can use GitHub here. Check your status on the werft server first and answer from it: whether the Werft GitHub App is connected, which repositories you may use (as far as I may see them), and the Werft console menu where that is changed. If something is not connected, find the documentation page on the werft server that says how to connect it and give its link. ${NO_CLI}`,
      ),
  },
  {
    name: "check_slack_connection",
    title: "Check the Slack connection",
    description:
      "Checks whether this agent is connected to Slack in Werft, and where that is changed in the console.",
    get: async () =>
      asked(
        `Check whether you are connected to Slack here. Check your status on the werft server first and answer from it: whether the Werft Slack app is connected, your Slack identity, the channels you listen in (as far as I may see them), and the Werft console menu where that is changed. If something is not connected, find the documentation page on the werft server that says how to connect it and give its link. ${NO_CLI}`,
      ),
  },
  {
    name: "what_this_agent_can_do",
    title: "What this agent can do",
    description:
      "Lists what this agent is connected to and may use in Werft: integrations, MCP servers, skills and tools.",
    get: async () =>
      asked(
        "Tell me what you can do here in Werft. Check your status on the werft server first and answer from it: your GitHub and Slack connections, your MCP servers, skills and tools, and the Werft version. For anything not connected or not allowed for you, name the Werft console menu where it is changed.",
      ),
  },
];

/** How to use this server: the usage guide (also as a tool, for an engine that takes no skill) and the prompts for common checks. */
export function guidePart(_context: WerftMcpPartContext): WerftMcpPart {
  return {
    tools: [
      werftTool({
        name: "read_skill",
        description: READ_SKILL_DESCRIPTION,
        input: z.object({}),
        call: async () => ({ content: [{ type: "text", text: WERFT_SKILL }] }),
      }),
    ],
    resources: {
      list: async () => [
        {
          uri: WERFT_SKILL_URI,
          name: WERFT_SKILL_NAME,
          title: "Werft usage guide",
          description: SKILL_DESCRIPTION,
          mimeType: "text/markdown",
        },
      ],
      read: async (uri) =>
        uri === WERFT_SKILL_URI
          ? [{ uri, mimeType: "text/markdown", text: WERFT_SKILL }]
          : null,
    },
    prompts: PROMPTS,
  };
}
