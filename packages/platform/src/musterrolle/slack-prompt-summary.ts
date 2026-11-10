import {
  presentPendingRequest,
  type ToolVerb,
  type UserLocale,
} from "@werft-ai/contracts";
import type { ToolSummaryContext } from "../ports/pending-requests.ts";

// Product copy: plain words, no internal module names. One entry per ToolVerb;
// `useTool` takes `{tool}`, `useMcpTool` takes `{server}` and `{tool}`.
export const SLACK_SUMMARY_MESSAGES: Readonly<
  Record<UserLocale, Record<ToolVerb, string>>
> = {
  ko: {
    runCommand: "명령 실행",
    editFile: "파일 수정",
    writeFile: "파일 쓰기",
    readFile: "파일 읽기",
    findFiles: "파일 찾기",
    searchContents: "내용 찾기",
    readWebPage: "웹 페이지 읽기",
    searchWeb: "웹 검색",
    requestPush: "push 요청",
    openPullRequest: "PR 열기",
    updatePullRequest: "PR 고치기",
    commentPullRequest: "PR에 댓글",
    closePullRequest: "PR 닫기",
    reopenPullRequest: "PR 다시 열기",
    attachRepository: "저장소 붙이기",
    useTool: "{tool} 도구 사용",
    useMcpTool: "{server}의 {tool} 도구 사용",
  },
  ja: {
    runCommand: "コマンド実行",
    editFile: "ファイル編集",
    writeFile: "ファイル作成",
    readFile: "ファイル読み取り",
    findFiles: "ファイル検索",
    searchContents: "内容検索",
    readWebPage: "Webページ読み取り",
    searchWeb: "Web検索",
    requestPush: "push依頼",
    openPullRequest: "PR作成",
    updatePullRequest: "PR更新",
    commentPullRequest: "PRにコメント",
    closePullRequest: "PRをクローズ",
    reopenPullRequest: "PRを再オープン",
    attachRepository: "リポジトリ追加",
    useTool: "{tool}ツールの使用",
    useMcpTool: "{server}の{tool}ツールの使用",
  },
  en: {
    runCommand: "Run a command",
    editFile: "Edit a file",
    writeFile: "Write a file",
    readFile: "Read a file",
    findFiles: "Find files",
    searchContents: "Search contents",
    readWebPage: "Read a web page",
    searchWeb: "Search the web",
    requestPush: "Request a push",
    openPullRequest: "Open a PR",
    updatePullRequest: "Update a PR",
    commentPullRequest: "Comment on a PR",
    closePullRequest: "Close a PR",
    reopenPullRequest: "Reopen a PR",
    attachRepository: "Attach a repository",
    useTool: "Use the {tool} tool",
    useMcpTool: "Use the {tool} tool of {server}",
  },
};

const VERB_MAX = 100;

/**
 * `excerpt`: the first lines of what a file tool writes, so a person sees
 * the content without opening the raw input; null for other tools.
 */
export type ToolSummary = {
  verb: string;
  target: string | null;
  excerpt: string | null;
};

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};

/**
 * Slack's wording of `presentPendingRequest`: the plain-words line a card
 * shows over a tool's raw input.
 */
export function summarizeToolRequest(
  tool: string,
  input: unknown,
  context: ToolSummaryContext,
  locale: UserLocale,
): ToolSummary {
  const presented = presentPendingRequest(tool, input, context);
  const name = presented.verb.key.slice("action.tool.".length) as ToolVerb;
  let verb = SLACK_SUMMARY_MESSAGES[locale][name];
  for (const [key, value] of Object.entries(presented.verb.params ?? {})) {
    // A replacer function: a tool name holding "$&" must stay literal.
    verb = verb.replace(`{${key}}`, () => value);
  }
  return {
    verb: clip(verb, VERB_MAX),
    target: presented.target,
    excerpt: presented.excerpt,
  };
}
