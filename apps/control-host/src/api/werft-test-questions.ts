/**
 * Ten questions about Werft itself, each with where in the built-in `werft`
 * server its answer is (94S-2169). An agent asked one of these answers from
 * those tools or pages, not with the generic setup steps in `not`. The
 * measurement of which engine reaches them is in the pull request that added
 * this list; `werft-test-questions.test.ts` keeps every source here served.
 */
export type WerftTestQuestion = {
  id: string;
  question: string;
  language: "ko" | "en" | "ja";
  /** The server's tools that answer it, the first one first. */
  tools: readonly ("get_status" | "search_docs" | "read_skill")[];
  /** The field of `get_status` that holds the answer, if it is one. */
  status?: string;
  /** Docs pages (path under apps/docs/content/docs, no extension) that explain it. */
  docs: readonly string[];
  /** The generic answer it must not be. */
  not: string;
};

export const WERFT_TEST_QUESTIONS: readonly WerftTestQuestion[] = [
  {
    id: "q01",
    question: "GitHub 쓸 수 있어?",
    language: "ko",
    tools: ["get_status", "search_docs"],
    status: "github.state",
    docs: ["integrations/github"],
    not: "gh auth login, a personal access token",
  },
  {
    id: "q02",
    question: "이 저장소에 push할 수 있어?",
    language: "ko",
    tools: ["get_status", "search_docs"],
    status: "github.repositories",
    docs: ["integrations/github"],
    not: "git remote, SSH keys or a token in the URL",
  },
  {
    id: "q03",
    question: "Slack 연결은 어떻게 해?",
    language: "ko",
    tools: ["get_status", "search_docs"],
    status: "slack.setup",
    docs: ["integrations/slack", "integrations/slack-console"],
    not: "creating a Slack app and a bot token by hand",
  },
  {
    id: "q04",
    question: "어느 Slack 채널을 듣고 있어?",
    language: "ko",
    tools: ["get_status"],
    status: "slack.channels",
    docs: ["integrations/slack"],
    not: "I cannot see Slack, or the Slack API",
  },
  {
    id: "q05",
    question: "너는 여기서 뭘 할 수 있어?",
    language: "ko",
    tools: ["get_status", "read_skill"],
    status: "tools",
    docs: [],
    not: "the engine's generic list of abilities",
  },
  {
    id: "q06",
    question: "방금 명령은 왜 거절됐어?",
    language: "ko",
    tools: ["read_skill", "search_docs"],
    docs: ["agents/permissions"],
    not: "a guess about OS permissions or sudo",
  },
  {
    id: "q07",
    question: "API 키는 어디서 발급해?",
    language: "ko",
    tools: ["search_docs"],
    docs: ["api-keys"],
    not: "a model provider's key page",
  },
  {
    id: "q08",
    question: "How do I connect GitHub to Werft?",
    language: "en",
    tools: ["search_docs", "get_status"],
    status: "github.setup",
    docs: ["integrations/github"],
    not: "gh auth login, an OAuth app of one's own",
  },
  {
    id: "q09",
    question: "この Werft のバージョンは?",
    language: "ja",
    tools: ["get_status"],
    status: "werft.version",
    docs: [],
    not: "a CLI's --version, or I do not know",
  },
  {
    id: "q10",
    question: "이 에이전트에 MCP 서버를 붙이려면 어떻게 해?",
    language: "ko",
    tools: ["get_status", "search_docs"],
    status: "mcp_servers",
    docs: ["agents/instructions-and-roles"],
    not: "claude mcp add, or editing an MCP config file",
  },
];
