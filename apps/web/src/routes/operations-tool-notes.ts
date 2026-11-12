import type { Locale } from "../i18n/i18n.tsx";

/**
 * A line for each built-in engine tool in the tool activity table. The engine
 * names its tools but describes only MCP ones, which the API carries; these
 * fill in the rest. The whole fallback is this file, so dropping it
 * leaves built-in tools without a line and nothing else.
 */
const NOTES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  ko: {
    Agent: "하위 에이전트에게 일을 맡긴다",
    Task: "하위 에이전트에게 일을 맡긴다",
    AskUserQuestion: "사용자에게 묻는다",
    Bash: "셸 명령",
    BashOutput: "백그라운드 셸의 출력을 읽는다",
    KillShell: "백그라운드 셸을 끝낸다",
    Edit: "파일 일부를 고친다",
    MultiEdit: "파일 여러 곳을 고친다",
    ExitPlanMode: "계획을 마치고 실행으로 넘어간다",
    Glob: "이름 패턴으로 파일을 찾는다",
    Grep: "파일 내용을 검색한다",
    NotebookEdit: "노트북 셀을 고친다",
    Read: "파일을 읽는다",
    Skill: "스킬을 불러 쓴다",
    TodoWrite: "할 일 목록을 적는다",
    WebFetch: "웹 페이지를 가져온다",
    WebSearch: "웹을 검색한다",
    Write: "파일을 쓴다",
  },
  en: {
    Agent: "Hands work to a subagent",
    Task: "Hands work to a subagent",
    AskUserQuestion: "Asks the user",
    Bash: "Shell command",
    BashOutput: "Reads a background shell's output",
    KillShell: "Stops a background shell",
    Edit: "Changes part of a file",
    MultiEdit: "Changes several places in a file",
    ExitPlanMode: "Ends planning and starts the work",
    Glob: "Finds files by name pattern",
    Grep: "Searches file contents",
    NotebookEdit: "Changes a notebook cell",
    Read: "Reads a file",
    Skill: "Uses a skill",
    TodoWrite: "Writes the to-do list",
    WebFetch: "Fetches a web page",
    WebSearch: "Searches the web",
    Write: "Writes a file",
  },
  ja: {
    Agent: "サブエージェントに作業を任せる",
    Task: "サブエージェントに作業を任せる",
    AskUserQuestion: "ユーザーに質問する",
    Bash: "シェルコマンド",
    BashOutput: "バックグラウンドシェルの出力を読む",
    KillShell: "バックグラウンドシェルを終了する",
    Edit: "ファイルの一部を変更する",
    MultiEdit: "ファイルの複数箇所を変更する",
    ExitPlanMode: "計画を終えて実行に移る",
    Glob: "名前のパターンでファイルを探す",
    Grep: "ファイルの内容を検索する",
    NotebookEdit: "ノートブックのセルを変更する",
    Read: "ファイルを読む",
    Skill: "スキルを使う",
    TodoWrite: "やることリストを書く",
    WebFetch: "Web ページを取得する",
    WebSearch: "Web を検索する",
    Write: "ファイルを書く",
  },
};

export function builtinToolNote(
  locale: Locale,
  name: string,
): string | undefined {
  const notes = NOTES[locale];
  return Object.hasOwn(notes, name) ? notes[name] : undefined;
}
