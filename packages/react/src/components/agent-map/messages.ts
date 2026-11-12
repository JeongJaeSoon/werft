import type { SessionStatus } from "@werft-ai/contracts";

import type { Locale } from "../../messages/index.ts";
import type { Lane, MapEdgeKind, RunStatus, ToolCallState } from "./types.ts";

/**
 * The agent map's own wording, one set per locale, so a screen passes data
 * alone. A host replaces any entry through `messages`.
 */
export interface AgentMapMessages {
  readonly status: (status: SessionStatus) => string;
  readonly run: (status: RunStatus) => string;
  readonly toolState: (state: ToolCallState) => string;
  readonly lane: (lane: Exclude<Lane, "done">) => string;
  readonly done: string;
  readonly expandDone: string;
  readonly emptyLane: string;
  readonly waitingLabel: string;
  /** `count` is a number, or "50+" when more wait than were read. */
  readonly waitingTitle: (count: number | string, minutes: number) => string;
  readonly waitingLine: (
    agent: string,
    title: string,
    minutes: number,
  ) => string;
  readonly open: string;
  readonly subagents: (count: number) => string;
  readonly tools: (count: number) => string;
  readonly errors: (count: number) => string;
  readonly approvals: (count: number) => string;
  readonly questions: (count: number) => string;
  readonly requests: (count: number) => string;
  readonly pinned: string;
  readonly ownRun: string;
  readonly sessionRun: string;
  readonly runTotals: (tools: number, subagents: number) => string;
  readonly noTools: string;
  readonly live: string;
  /** The text beside the edge: a visible badge, or read aloud only. */
  readonly edge: (kind: MapEdgeKind) => string;
  readonly delegationBadge: string;
  readonly relationNote: string;
  readonly timeline: string;
  readonly back: string;
  readonly relations: string;
  readonly loading: string;
  readonly title: string;
  readonly description: string;
  /** How long ago the list was last read; null before the first read. */
  readonly listUpdated: (seconds: number | null) => string;
  readonly liveScope: string;
  readonly tidy: (count: number) => string;
  /** Read aloud when a read of the list moved something. */
  readonly changes: (
    changes: readonly { title: string; to: SessionStatus }[],
    added: number,
  ) => string;
  /** A queued session's card before it has done anything. */
  readonly queuedNote: string;
  /** A card whose session waits on a recovery decision. */
  readonly recoveryNote: string;
  readonly noActivity: string;
  readonly noAgent: string;
  /** Leads a pending question on the approval strip. */
  readonly question: string;
  /** A wait whose request the list does not show. */
  readonly openRequest: string;
}

const STATUS_KO: Record<SessionStatus, string> = {
  queued: "대기 중",
  running: "작업 중",
  needs_input: "답변 대기",
  idle: "쉬는 중",
  failed: "실패",
  stopped: "멈춤",
};
const STATUS_JA: Record<SessionStatus, string> = {
  queued: "待機中",
  running: "作業中",
  needs_input: "回答待ち",
  idle: "入力待ち",
  failed: "失敗",
  stopped: "停止",
};
const STATUS_EN: Record<SessionStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_input: "Waiting for an answer",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
};

export const AGENT_MAP_MESSAGES: Readonly<Record<Locale, AgentMapMessages>> = {
  ko: {
    status: (status) => STATUS_KO[status],
    run: (status) =>
      ({
        wait: "답변 대기",
        run: "작업 중",
        idle: "실행 대기",
        done: "끝남",
        failed: "실패",
      })[status],
    toolState: (state) =>
      ({
        ok: "성공",
        error: "실패",
        running: "실행 중",
        waiting: "승인 대기",
        interrupted: "중단",
      })[state],
    lane: (lane) =>
      ({
        attention: "답변 필요",
        running: "작업 중",
        queued: "대기 중",
        idle: "쉬는 중",
      })[lane],
    done: "최근 종료",
    expandDone: "펼치기",
    emptyLane: "없음",
    waitingLabel: "내 답변을 기다리는 요청",
    waitingTitle: (count, minutes) =>
      `답변 대기 ${count} · 가장 오래 ${minutes}분`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes}분째`,
    open: "보기",
    subagents: (count) => `· 하위 ${count}`,
    tools: (count) => `도구 ${count}`,
    errors: (count) => `오류 ${count}`,
    approvals: (count) => `승인 ${count}`,
    questions: (count) => `질문 ${count}`,
    requests: (count) => `요청 ${count}`,
    pinned: "자리 정리 대기",
    ownRun: "직접 호출",
    sessionRun: "세션 실행",
    runTotals: (tools, subagents) => `도구 ${tools} · 하위 ${subagents}`,
    noTools: "아직 도구 호출 없음",
    live: "실시간 · 마지막 이벤트",
    edge: (kind) =>
      ({
        delegation: "위임",
        approval: "승인 대기",
        request: "요청",
        response: "응답",
        waiting: "응답 대기",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "부모·자식 관계는 이 세션 안의 위임(parent_tool_use_id)만 뜻합니다.",
    timeline: "타임라인에서 전체 보기",
    back: "← 목록으로",
    relations: "세션 관계",
    loading: "에이전트 지도를 읽는 중",
    title: "에이전트 지도",
    description:
      "지금 동작 중인 세션, 그 안의 하위 에이전트와 쓴 도구를 봅니다.",
    listUpdated: (seconds) =>
      seconds === null ? "목록을 읽는 중" : `목록 갱신 ${seconds}초 전`,
    liveScope: "실시간은 선택한 세션만",
    tidy: (count) => `자리 정리 (${count})`,
    changes: (changes, added) =>
      [
        ...changes.map((c) => `${c.title}: ${STATUS_KO[c.to]}`),
        ...(added > 0 ? [`새 세션 ${added}개`] : []),
      ].join(", "),
    queuedNote: "작업자 배정을 기다리는 중",
    recoveryNote: "복구 결정을 기다리는 중",
    noActivity: "아직 활동 없음",
    noAgent: "에이전트 없음",
    question: "질문",
    openRequest: "답할 요청",
  },
  ja: {
    status: (status) => STATUS_JA[status],
    run: (status) =>
      ({
        wait: "回答待ち",
        run: "作業中",
        idle: "実行待ち",
        done: "完了",
        failed: "失敗",
      })[status],
    toolState: (state) =>
      ({
        ok: "成功",
        error: "失敗",
        running: "実行中",
        waiting: "承認待ち",
        interrupted: "中断",
      })[state],
    lane: (lane) =>
      ({
        attention: "回答が必要",
        running: "作業中",
        queued: "待機中",
        idle: "入力待ち",
      })[lane],
    done: "最近終了",
    expandDone: "展開",
    emptyLane: "なし",
    waitingLabel: "回答を待っているリクエスト",
    waitingTitle: (count, minutes) => `回答待ち ${count} · 最長 ${minutes}分`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes}分経過`,
    open: "表示",
    subagents: (count) => `· サブ ${count}`,
    tools: (count) => `ツール ${count}`,
    errors: (count) => `エラー ${count}`,
    approvals: (count) => `承認 ${count}`,
    questions: (count) => `質問 ${count}`,
    requests: (count) => `リクエスト ${count}`,
    pinned: "並べ替え待ち",
    ownRun: "直接呼び出し",
    sessionRun: "セッション実行",
    runTotals: (tools, subagents) => `ツール ${tools} · サブ ${subagents}`,
    noTools: "まだツール呼び出しなし",
    live: "リアルタイム · 最終イベント",
    edge: (kind) =>
      ({
        delegation: "委任",
        approval: "承認待ち",
        request: "リクエスト",
        response: "応答",
        waiting: "応答待ち",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "親子関係はこのセッション内の委任(parent_tool_use_id)だけを表します。",
    timeline: "タイムラインですべて表示",
    back: "← 一覧へ",
    relations: "セッションの関係",
    loading: "エージェントマップを読み込み中",
    title: "エージェントマップ",
    description:
      "動作中のセッションと、その中のサブエージェント、使ったツールを表示します。",
    listUpdated: (seconds) =>
      seconds === null ? "一覧を読み込み中" : `一覧の更新 ${seconds}秒前`,
    liveScope: "リアルタイムは選択したセッションのみ",
    tidy: (count) => `並べ替え (${count})`,
    changes: (changes, added) =>
      [
        ...changes.map((c) => `${c.title}: ${STATUS_JA[c.to]}`),
        ...(added > 0 ? [`新しいセッション ${added}件`] : []),
      ].join("、"),
    queuedNote: "ワーカーの割り当てを待っています",
    recoveryNote: "復旧の判断を待っています",
    noActivity: "まだ活動なし",
    noAgent: "エージェントなし",
    question: "質問",
    openRequest: "回答待ちのリクエスト",
  },
  en: {
    status: (status) => STATUS_EN[status],
    run: (status) =>
      ({
        wait: "Waiting for an answer",
        run: "Working",
        idle: "Idle",
        done: "Done",
        failed: "Failed",
      })[status],
    toolState: (state) =>
      ({
        ok: "Succeeded",
        error: "Failed",
        running: "Running",
        waiting: "Awaiting approval",
        interrupted: "Interrupted",
      })[state],
    lane: (lane) =>
      ({
        attention: "Waiting for an answer",
        running: "Working",
        queued: "Queued",
        idle: "Idle",
      })[lane],
    done: "Recently ended",
    expandDone: "Expand",
    emptyLane: "None",
    waitingLabel: "Requests waiting for your answer",
    waitingTitle: (count, minutes) =>
      `${count} waiting · longest ${minutes} min`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes} min`,
    open: "View",
    subagents: (count) => `· Subagents: ${count}`,
    tools: (count) => `${count} tools`,
    errors: (count) => `${count} errors`,
    approvals: (count) => `Approvals: ${count}`,
    questions: (count) => `Questions: ${count}`,
    requests: (count) => `Requests: ${count}`,
    pinned: "Waiting to tidy",
    ownRun: "Direct calls",
    sessionRun: "Session run",
    runTotals: (tools, subagents) =>
      `Tools: ${tools} · Subagents: ${subagents}`,
    noTools: "No tool calls yet",
    live: "Live · last event",
    edge: (kind) =>
      ({
        delegation: "Delegated",
        approval: "Awaiting approval",
        request: "Request",
        response: "Response",
        waiting: "Awaiting reply",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "Parent and child mean delegation inside this session (parent_tool_use_id) only.",
    timeline: "See all in the timeline",
    back: "← Back to list",
    relations: "Session relations",
    loading: "Loading the agent map",
    title: "Agent map",
    description:
      "Sessions at work now, with the subagents inside them and the tools they used.",
    listUpdated: (seconds) =>
      seconds === null ? "Reading the list" : `List updated ${seconds}s ago`,
    liveScope: "Live updates for the selected session only",
    tidy: (count) => `Tidy up (${count})`,
    changes: (changes, added) =>
      [
        ...changes.map((c) => `${c.title}: ${STATUS_EN[c.to]}`),
        ...(added > 0 ? [`${added} new sessions`] : []),
      ].join(", "),
    queuedNote: "Waiting for a worker",
    recoveryNote: "Waiting for a recovery decision",
    noActivity: "No activity yet",
    noAgent: "No agent",
    question: "Question",
    openRequest: "Open request",
  },
};
