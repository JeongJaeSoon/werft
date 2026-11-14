import type { SessionStatus } from "@werft-ai/contracts";

import type { Locale } from "../../messages/index.ts";

/*
 * The operations parts' own wording and number formats, one set per locale,
 * so a screen passes data alone. A host replaces any entry through the
 * part's `messages`.
 */

export interface OperationsFormat {
  readonly count: (n: number) => string;
  /** Seconds as hours and minutes: "64시간 3분". */
  readonly duration: (seconds: number) => string;
  /** Milliseconds, seconds under a minute: "3.1초", else as `duration`. */
  readonly elapsed: (ms: number) => string;
  /** a / b as "1.7%". */
  readonly percent: (a: number, b: number) => string;
  /** A `cost_usd` string as "$1,045.48". */
  readonly usd: (amount: string | number) => string;
  /** A token count in the locale's large units: "3,816만", "38.2M". */
  readonly tokens: (n: number) => string;
  /** "2 GB", "512 MB". */
  readonly bytes: (n: number) => string;
  /** The clock time of an instant: "오후 9:40". */
  readonly clock: (iso: string, timeZone?: string) => string;
}

export type OperationsTab = "overview" | "usage" | "tools" | "limits";

export interface OperationsHeadMessages {
  readonly title: string;
  readonly description: string;
  readonly tabs: string;
  readonly tab: Readonly<Record<OperationsTab, string>>;
  /** Why a tab that is shown cannot be opened yet. */
  readonly soon: string;
}

export interface UsageFiltersMessages {
  readonly scope: string;
  readonly me: string;
  readonly installation: string;
  readonly period: string;
  readonly days: (days: number) => string;
}

export interface UsageKpisMessages {
  readonly sessions: string;
  readonly sessionsNote: string;
  readonly sessionsChart: string;
  readonly runTime: string;
  readonly runTimeNote: string;
  readonly runTimeChart: string;
  readonly cost: string;
  readonly estimated: string;
  readonly costIncomplete: string;
  readonly costChart: string;
  readonly tokens: string;
  readonly tokensNote: string;
  readonly tokensChart: string;
  readonly loading: string;
}

export interface InstallationLimitsMessages {
  readonly capacity: string;
  readonly capacityNote: string;
  readonly asOf: (at: string) => string;
  readonly slotsInUse: string;
  readonly slotsFree: (free: string) => string;
  readonly slotsMeter: string;
  readonly storage: string;
  readonly storageMeter: string;
  readonly storageNote: string;
  readonly limits: string;
  readonly item: string;
  readonly current: string;
  readonly limit: string;
  readonly note: string;
  readonly perSession: string;
  readonly notSet: string;
  readonly slots: string;
  readonly slotsRowNote: string;
  readonly storageRowNote: string;
  readonly outputs: string;
  readonly outputsRowNote: string;
  /** `usage.outputs.complete` is false: the figure may be short. */
  readonly outputsIncompleteNote: string;
  /** The figure when it may be short: a lower bound. */
  readonly outputsAtLeast: (bytes: string) => string;
  readonly noLimit: string;
  readonly sessionCost: string;
  readonly sessionCostNote: string;
  readonly sessionTokens: string;
  readonly sessionTokensNote: string;
  readonly queuedInput: string;
  readonly queuedInputValue: (count: string) => string;
  readonly queuedInputNote: string;
  readonly maxTurn: string;
  readonly maxTurnNote: string;
  readonly loading: string;
  /** `scope="me"`: the limits a member's own sessions run under. */
  readonly memberNote: string;
  readonly memberSlotsNote: string;
  readonly monthlyCost: string;
  readonly monthlyCostNote: string;
  readonly memberOutputsNote: string;
  /** A figure the platform keeps for no member. */
  readonly notMeasured: string;
}

export interface UsageCostTableMessages {
  readonly sessions: string;
  readonly tokens: string;
  readonly cost: string;
  readonly costShare: (name: string) => string;
  /** The row of sessions without an agent. */
  readonly noAgent: string;
  /** The row of cost no metered call explains. */
  readonly noModel: string;
  readonly emptyAgent: string;
  readonly emptyModel: string;
}

export interface UsageDailyCostMessages {
  readonly title: string;
  readonly description: string;
  readonly complete: string;
  readonly partial: string;
  readonly chart: (days: number) => string;
  readonly tip: (
    day: string,
    cost: string,
    sessions: string,
    partial: boolean,
  ) => string;
}

export interface UsageTokenMixMessages {
  readonly title: string;
  readonly description: (total: string) => string;
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly share: (label: string) => string;
}

export interface UsageBasisMessages {
  readonly scope: Readonly<Record<"me" | "installation", string>>;
  readonly rule: string;
  readonly readAt: (at: string) => string;
}

export interface SessionCountsMessages {
  readonly title: string;
  readonly description: string;
  readonly status: (status: SessionStatus) => string;
  readonly slots: string;
  readonly slotsUsed: (
    used: string,
    limit: string,
  ) => readonly [string, string];
  readonly slotsMeter: string;
  readonly loading: string;
}

export interface FindingsMessages {
  readonly most_time: string;
  readonly fails_often: string;
  readonly slowest: string;
  readonly mostTimeDetail: (total: string, share: number) => string;
  readonly failsOftenDetail: (
    calls: string,
    failed: string,
    rate: string,
  ) => string;
  readonly slowestDetail: (median: string, calls: string) => string;
  readonly empty: string;
}

export interface ToolTableMessages {
  readonly name: string;
  readonly calls: string;
  readonly total: string;
  readonly median: string;
  readonly failed: string;
  readonly open: (name: string) => string;
  readonly callsMeter: (name: string) => string;
  readonly empty: string;
  readonly noMatch: string;
  readonly loading: string;
}

export interface ToolsSummaryMessages {
  /** The parts of "… <b>1,840번</b> … <b>4시간</b> … <bad>21번 실패</bad> …". */
  readonly sentence: (parts: {
    readonly period: string;
    readonly calls: string;
    readonly time: string;
    readonly failed: string;
    readonly rate: string;
  }) => readonly (
    | string
    | { readonly strong: string }
    | { readonly danger: string }
  )[];
}

export interface ToolCallsMessages {
  readonly note: string;
  readonly hidden: string;
  readonly outcome: {
    readonly ok: string;
    readonly failed: string;
    readonly unknown: string;
  };
  readonly none: string;
  readonly empty: string;
}

export type ToolSort = "calls" | "time" | "slow" | "failed";

export interface ToolsFilterMessages {
  readonly sort: string;
  readonly by: Readonly<Record<ToolSort, string>>;
  readonly search: string;
  readonly placeholder: string;
}

export type ToolCallSort = "recent" | "slowest";

export interface ToolRailMessages {
  readonly label: string;
  readonly calls: string;
  readonly total: string;
  readonly median: string;
  readonly failed: string;
  readonly callsValue: (calls: string) => string;
  readonly failedValue: (failed: string, rate: string) => string;
  readonly perDay: string;
  readonly perDayNote: (days: number) => string;
  readonly perDayChart: (parts: {
    readonly name: string;
    readonly days: number;
    readonly total: string;
    readonly peakDay: string;
    readonly peak: string;
  }) => string;
  readonly recent: string;
  readonly callSort: string;
  readonly callSortBy: Readonly<Record<ToolCallSort, string>>;
  /** Names the rail's heading while the tools are read. */
  readonly loading: string;
}

export interface OperationsMessages {
  readonly format: OperationsFormat;
  readonly sessionCounts: SessionCountsMessages;
  readonly findings: FindingsMessages;
  readonly toolTable: ToolTableMessages;
  readonly toolsSummary: ToolsSummaryMessages;
  readonly toolCalls: ToolCallsMessages;
  readonly toolsFilter: ToolsFilterMessages;
  readonly toolRail: ToolRailMessages;
  readonly head: OperationsHeadMessages;
  readonly usageFilters: UsageFiltersMessages;
  readonly usageKpis: UsageKpisMessages;
  readonly installationLimits: InstallationLimitsMessages;
  readonly usageCostTable: UsageCostTableMessages;
  readonly usageDailyCost: UsageDailyCostMessages;
  readonly usageTokenMix: UsageTokenMixMessages;
  readonly usageBasis: UsageBasisMessages;
}

function format(
  locale: Locale,
  hours: (h: number, m: number) => string,
  minutes: (m: number) => string,
  seconds: (s: string) => string,
  units?: readonly [string, string],
): OperationsFormat {
  const nf = new Intl.NumberFormat(locale === "ko" ? "ko-KR" : locale);
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const duration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? hours(h, m) : minutes(m);
  };
  return {
    count: (n) => nf.format(n),
    duration,
    elapsed: (ms) =>
      ms >= 60000 ? duration(ms / 1000) : seconds((ms / 1000).toFixed(1)),
    percent: (a, b) => `${(b ? (100 * a) / b : 0).toFixed(1)}%`,
    usd: (amount) =>
      Number(amount) > 0 && Number(amount) < 0.005
        ? "<$0.01"
        : `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    tokens: (n) =>
      !units
        ? n >= 1e4
          ? compact.format(n)
          : nf.format(n)
        : n >= 1e8
          ? `${(n / 1e8).toFixed(1)}${units[0]}`
          : n >= 1e4
            ? `${nf.format(Math.round(n / 1e4))}${units[1]}`
            : nf.format(n),
    bytes: (n) =>
      n >= 1073741824
        ? `${(n / 1073741824).toFixed(1).replace(/\.0$/, "")} GB`
        : `${Math.round(n / 1048576)} MB`,
    clock: (iso, timeZone) =>
      new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      })
        .format(new Date(iso))
        // ICU puts a narrow no-break space before "PM" and after "오후".
        .replace(/ /g, " "),
  };
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

export const OPERATIONS_MESSAGES: Readonly<Record<Locale, OperationsMessages>> =
  {
    ko: {
      format: format(
        "ko",
        (h, m) => `${h}시간 ${m}분`,
        (m) => `${m}분`,
        (s) => `${s}초`,
        ["억", "만"],
      ),
      sessionCounts: {
        title: "지금 · 내가 볼 수 있는 세션",
        description:
          "공유받았거나 내가 시작한 세션만 셉니다 · 상태를 누르면 세션 목록으로 갑니다 · 30초마다 새로 읽음",
        status: (status) => STATUS_KO[status],
        slots: "동시 실행 슬롯 · 설치 전체",
        slotsUsed: (used, limit) => [used, ` / ${limit} 사용`],
        slotsMeter: "동시 실행 슬롯 사용률, 설치 전체",
        loading: "세션 수를 읽는 중",
      },
      findings: {
        most_time: "가장 오래 걸리는 도구: ",
        fails_often: "자주 실패하는 도구: ",
        slowest: "가장 느린 도구: ",
        mostTimeDetail: (total, share) =>
          `${total} · 전체 도구 시간의 ${share}%`,
        failsOftenDetail: (calls, failed, rate) =>
          `${calls}번 중 ${failed}번 실패 (${rate})`,
        slowestDetail: (median, calls) => `보통 ${median} · 호출 ${calls}번`,
        empty: "이 기간에 살펴볼 도구가 없습니다.",
      },
      toolTable: {
        name: "이름",
        calls: "호출",
        total: "총 시간",
        median: "보통",
        failed: "실패",
        open: (name) => `${name} 자세히 보기`,
        callsMeter: (name) => `${name} 호출 비율`,
        empty: "이 기간에 불린 도구가 없습니다.",
        noMatch: "찾는 이름의 도구가 없습니다.",
        loading: "도구 목록을 읽는 중",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `${period} 동안 에이전트가 도구를 `,
          { strong: `${calls}번` },
          // "동안" reads the same after "2.8초" and "3시간 42분"; 을/를 does not.
          " 불렀고 모두 ",
          { strong: time },
          " 동안 실행했습니다. ",
          { danger: `${failed}번 실패` },
          `했습니다 (${rate}).`,
        ],
      },
      toolCalls: {
        note: "볼 수 없는 세션은 제목과 링크 없이 시간만 보입니다",
        hidden: "볼 수 없는 세션",
        outcome: { ok: "완료", failed: "실패", unknown: "결과 모름" },
        none: "—",
        empty: "이 기간에 부른 기록이 없습니다.",
      },
      toolsFilter: {
        sort: "정렬",
        by: {
          calls: "많이 쓴 순",
          time: "오래 걸린 순",
          slow: "느린 순",
          failed: "실패",
        },
        search: "도구 찾기",
        placeholder: "도구나 명령 찾기",
      },
      toolRail: {
        label: "선택한 도구",
        calls: "호출",
        total: "총 시간",
        median: "보통",
        failed: "실패",
        callsValue: (calls) => `${calls}번`,
        failedValue: (failed, rate) => `${failed}번 (${rate})`,
        perDay: "일자별 호출",
        perDayNote: (days) => `최근 ${days}일`,
        perDayChart: ({ name, days, total, peakDay, peak }) =>
          `${name} 일자별 호출, 최근 ${days}일, 합계 ${total}번, 가장 많은 날 ${peakDay} ${peak}번`,
        recent: "최근 호출",
        callSort: "호출 정렬",
        callSortBy: { recent: "최근", slowest: "느린 순" },
        loading: "도구 목록을 읽는 중",
      },
      head: {
        title: "사용량·한도",
        description:
          "에이전트가 얼마나 돌고, 얼마나 쓰고, 어디서 막히는지 봅니다.",
        tabs: "사용량·한도 탭",
        tab: {
          overview: "개요",
          usage: "사용량",
          tools: "도구 활동",
          limits: "한도",
        },
        soon: "아직 준비 중인 화면입니다.",
      },
      usageFilters: {
        scope: "집계 범위",
        me: "내 사용량",
        installation: "설치 전체",
        period: "기간",
        days: (days) => `${days}일`,
      },
      usageKpis: {
        sessions: "세션",
        sessionsNote: "이 기간에 시작한 세션",
        sessionsChart: "일자별 세션 수",
        runTime: "실행 시간",
        runTimeNote: "턴 시작부터 끝까지, 답을 기다린 시간 포함",
        runTimeChart: "일자별 실행 시간",
        cost: "비용",
        estimated: "추정",
        costIncomplete:
          "진행 중이거나 비용을 보고하지 않은 턴이 있어 실제보다 적을 수 있음",
        costChart: "일자별 비용",
        tokens: "토큰",
        tokensNote: "비용을 센 호출의 토큰",
        tokensChart: "일자별 토큰",
        loading: "사용량을 읽는 중",
      },
      installationLimits: {
        capacity: "실행 용량",
        capacityNote: "설치 전체에 적용됩니다",
        asOf: (at) => `${at} 기준`,
        slotsInUse: "사용 중인 슬롯",
        slotsFree: (free) => `빈 슬롯 ${free}개`,
        slotsMeter: "슬롯 사용률",
        storage: "입력 메시지 저장",
        storageMeter: "입력 메시지 저장 사용률",
        storageNote: "입력 메시지만 셉니다",
        limits: "한도",
        item: "항목",
        current: "현재",
        limit: "한도",
        note: "설명",
        perSession: "세션마다 셉니다",
        notSet: "설정 안 됨",
        slots: "동시 실행 슬롯",
        slotsRowNote: "설치 설정의 상한. 빈 슬롯이 없으면 세션이 대기합니다",
        storageRowNote:
          "세션에 보낸 입력 메시지만 셉니다. 성과물은 따로 셉니다",
        outputs: "성과물 저장",
        outputsRowNote:
          "세션 성과물이 차지한 용량. 보여 주기만 하고 막지 않습니다",
        outputsIncompleteNote:
          "성과물을 세기 전 체크포인트가 남아 있어 실제보다 적을 수 있습니다",
        outputsAtLeast: (bytes) => `${bytes} 이상`,
        noLimit: "한도 없음",
        sessionCost: "세션당 비용",
        sessionCostNote: "추정 비용이 넘은 세션은 새 턴을 시작하지 않습니다",
        sessionTokens: "세션당 토큰",
        sessionTokensNote: "토큰이 넘은 세션은 새 턴을 시작하지 않습니다",
        queuedInput: "세션당 대기 입력",
        queuedInputValue: (count) => `${count}건`,
        queuedInputNote: "세션 하나에 쌓아 둘 수 있는 입력 수",
        maxTurn: "턴 최대 시간",
        maxTurnNote: "턴 하나가 돌 수 있는 시간",
        loading: "한도를 읽는 중",
        memberNote: "내 세션에 적용됩니다",
        memberSlotsNote:
          "구성원별 상한은 없습니다. 설치 전체의 슬롯을 함께 씁니다",
        monthlyCost: "월 비용",
        monthlyCostNote: "구성원별 월 비용 한도는 없습니다",
        memberOutputsNote: "구성원별 성과물 용량은 세지 않습니다",
        notMeasured: "미계측",
      },
      usageCostTable: {
        sessions: "세션",
        tokens: "토큰",
        cost: "비용",
        costShare: (name) => `${name} 비용 비율`,
        noAgent: "에이전트 없음",
        noModel: "호출 기록이 없는 비용",
        emptyAgent: "이 기간에 비용을 쓴 에이전트가 없습니다.",
        emptyModel: "이 기간에 비용을 쓴 모델이 없습니다.",
      },
      usageDailyCost: {
        title: "일자별 비용",
        description: "막대에 올리면 그날의 비용과 세션 수가 나옵니다",
        complete: "비용 보고 끝남",
        partial: "보고 안 된 비용 있음",
        chart: (days) => `일자별 추정 비용, ${days}일`,
        tip: (day, cost, sessions, partial) =>
          `${day} · ${cost} · 세션 ${sessions}개${partial ? " · 보고 안 된 비용 있음" : ""}`,
      },
      usageTokenMix: {
        title: "토큰 구성",
        description: (total) =>
          `비용을 센 호출의 토큰 ${total}을 종류별로 나눴습니다`,
        input: "입력",
        output: "출력",
        cacheRead: "캐시 읽기",
        cacheWrite: "캐시 쓰기",
        share: (label) => `${label} 토큰 비율`,
      },
      usageBasis: {
        scope: { me: "내 사용량", installation: "설치 전체" },
        rule: "비용·토큰·실행 시간은 세션을 시작한 날에 붙습니다",
        readAt: (at) => `${at}에 읽은 값`,
      },
    },
    ja: {
      format: format(
        "ja",
        (h, m) => `${h}時間${m}分`,
        (m) => `${m}分`,
        (s) => `${s}秒`,
        ["億", "万"],
      ),
      sessionCounts: {
        title: "現在 · 閲覧できるセッション",
        description:
          "共有されたか自分が開始したセッションのみ数えます · 状態を押すとセッション一覧へ移動します · 30秒ごとに再読み込み",
        status: (status) => STATUS_JA[status],
        slots: "同時実行スロット · インストール全体",
        slotsUsed: (used, limit) => [used, ` / ${limit} 使用中`],
        slotsMeter: "同時実行スロット使用率、インストール全体",
        loading: "セッション数を読み込み中",
      },
      findings: {
        most_time: "最も時間がかかるツール: ",
        fails_often: "よく失敗するツール: ",
        slowest: "最も遅いツール: ",
        mostTimeDetail: (total, share) =>
          `${total} · ツール時間全体の${share}%`,
        failsOftenDetail: (calls, failed, rate) =>
          `${calls}回中${failed}回失敗 (${rate})`,
        slowestDetail: (median, calls) =>
          `中央値 ${median} · 呼び出し${calls}回`,
        empty: "この期間に確認するツールはありません。",
      },
      toolTable: {
        name: "名前",
        calls: "呼び出し",
        total: "合計時間",
        median: "中央値",
        failed: "失敗",
        open: (name) => `${name} の詳細を見る`,
        callsMeter: (name) => `${name} の呼び出し比率`,
        empty: "この期間に呼ばれたツールはありません。",
        noMatch: "その名前のツールはありません。",
        loading: "ツール一覧を読み込み中",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `${period}、エージェントはツールを`,
          { strong: `${calls}回` },
          "呼び出し、実行に",
          { strong: time },
          "を使いました。",
          { danger: `${failed}回失敗` },
          `しました (${rate})。`,
        ],
      },
      toolCalls: {
        note: "閲覧できないセッションはタイトルとリンクなしで時間のみ表示します",
        hidden: "閲覧できないセッション",
        outcome: { ok: "完了", failed: "失敗", unknown: "結果不明" },
        none: "—",
        empty: "この期間の呼び出し記録はありません。",
      },
      toolsFilter: {
        sort: "並べ替え",
        by: {
          calls: "呼び出し回数が多い順",
          time: "合計時間順",
          slow: "遅い順",
          failed: "失敗",
        },
        search: "ツールを検索",
        placeholder: "ツールやコマンドを検索",
      },
      toolRail: {
        label: "選択したツール",
        calls: "呼び出し",
        total: "合計時間",
        median: "中央値",
        failed: "失敗",
        callsValue: (calls) => `${calls}回`,
        failedValue: (failed, rate) => `${failed}回 (${rate})`,
        perDay: "日別の呼び出し",
        perDayNote: (days) => `直近${days}日`,
        perDayChart: ({ name, days, total, peakDay, peak }) =>
          `${name} の日別の呼び出し、直近${days}日、合計${total}回、最も多い日 ${peakDay} ${peak}回`,
        recent: "最近の呼び出し",
        callSort: "呼び出しの並べ替え",
        callSortBy: { recent: "最近", slowest: "遅い順" },
        loading: "ツール一覧を読み込み中",
      },
      head: {
        title: "使用量・上限",
        description:
          "エージェントがどれだけ動き、どれだけ使い、どこで詰まっているかを見ます。",
        tabs: "使用量・上限タブ",
        tab: {
          overview: "概要",
          usage: "使用量",
          tools: "ツールの活動",
          limits: "上限",
        },
        soon: "この画面はまだ準備中です。",
      },
      usageFilters: {
        scope: "集計範囲",
        me: "自分の使用量",
        installation: "インストール全体",
        period: "期間",
        days: (days) => `${days}日`,
      },
      usageKpis: {
        sessions: "セッション",
        sessionsNote: "この期間に開始したセッション",
        sessionsChart: "日別セッション数",
        runTime: "実行時間",
        runTimeNote: "ターンの開始から終了まで、回答待ちの時間を含みます",
        runTimeChart: "日別実行時間",
        cost: "コスト",
        estimated: "推定",
        costIncomplete:
          "実行中またはコスト未報告のターンがあるため、実際より少ない可能性があります",
        costChart: "日別コスト",
        tokens: "トークン",
        tokensNote: "コストを数えた呼び出しのトークン",
        tokensChart: "日別トークン",
        loading: "使用量を読み込み中",
      },
      installationLimits: {
        capacity: "実行容量",
        capacityNote: "インストール全体に適用されます",
        asOf: (at) => `${at} 時点`,
        slotsInUse: "使用中のスロット",
        slotsFree: (free) => `空きスロット ${free}個`,
        slotsMeter: "スロット使用率",
        storage: "入力メッセージの保存",
        storageMeter: "入力メッセージ保存の使用率",
        storageNote: "入力メッセージのみ数えます",
        limits: "上限",
        item: "項目",
        current: "現在",
        limit: "上限",
        note: "説明",
        perSession: "セッションごとに数えます",
        notSet: "未設定",
        slots: "同時実行スロット",
        slotsRowNote:
          "インストール設定の上限。空きスロットがないとセッションは待機します",
        storageRowNote:
          "セッションに送った入力メッセージのみ数えます。成果物は別に数えます",
        outputs: "成果物の保存",
        outputsRowNote: "セッションの成果物が使う容量。表示のみで制限しません",
        outputsIncompleteNote:
          "成果物を集計する前のチェックポイントが残っているため、実際より少ない場合があります",
        outputsAtLeast: (bytes) => `${bytes} 以上`,
        noLimit: "上限なし",
        sessionCost: "セッションあたりのコスト",
        sessionCostNote:
          "推定コストが上限を超えたセッションは、新しいターンを開始しません",
        sessionTokens: "セッションあたりのトークン",
        sessionTokensNote:
          "トークン数が上限を超えたセッションは、新しいターンを開始しません",
        queuedInput: "セッションあたりの待機入力",
        queuedInputValue: (count) => `${count}件`,
        queuedInputNote: "1つのセッションに溜めておける入力の数",
        maxTurn: "ターンの最大時間",
        maxTurnNote: "1つのターンを実行できる時間",
        loading: "上限を読み込み中",
        memberNote: "自分のセッションに適用されます",
        memberSlotsNote:
          "メンバーごとの上限はありません。インストール全体のスロットを共有します",
        monthlyCost: "月間コスト",
        monthlyCostNote: "メンバーごとの月間コスト上限はありません",
        memberOutputsNote: "メンバーごとの成果物の容量は数えません",
        notMeasured: "未計測",
      },
      usageCostTable: {
        sessions: "セッション",
        tokens: "トークン",
        cost: "コスト",
        costShare: (name) => `${name} のコスト比率`,
        noAgent: "エージェントなし",
        noModel: "呼び出し記録のないコスト",
        emptyAgent: "この期間にコストを使ったエージェントはありません。",
        emptyModel: "この期間にコストを使ったモデルはありません。",
      },
      usageDailyCost: {
        title: "日別コスト",
        description:
          "バーにカーソルを合わせると、その日のコストとセッション数が表示されます",
        complete: "コスト報告済み",
        partial: "未報告のコストあり",
        chart: (days) => `日別推定コスト、${days}日`,
        tip: (day, cost, sessions, partial) =>
          `${day} · ${cost} · セッション${sessions}件${partial ? " · 未報告のコストあり" : ""}`,
      },
      usageTokenMix: {
        title: "トークン構成",
        description: (total) =>
          `コストを数えた呼び出しのトークン ${total} を種類別に分けました`,
        input: "入力",
        output: "出力",
        cacheRead: "キャッシュ読み取り",
        cacheWrite: "キャッシュ書き込み",
        share: (label) => `${label} のトークン比率`,
      },
      usageBasis: {
        scope: { me: "自分の使用量", installation: "インストール全体" },
        rule: "コスト・トークン・実行時間はセッションを開始した日に計上されます",
        readAt: (at) => `${at} に読み込んだ値`,
      },
    },
    en: {
      format: format(
        "en",
        (h, m) => `${h}h ${m}m`,
        (m) => `${m}m`,
        (s) => `${s}s`,
      ),
      sessionCounts: {
        title: "Now · sessions you can see",
        description:
          "Counts only sessions shared with you or started by you · Pick a status to open the session list · Refreshed every 30 seconds",
        status: (status) => STATUS_EN[status],
        slots: "Concurrent slots · whole installation",
        slotsUsed: (used, limit) => [used, ` / ${limit} in use`],
        slotsMeter: "Concurrent slot use, whole installation",
        loading: "Loading session counts",
      },
      findings: {
        most_time: "Takes the most time: ",
        fails_often: "Fails often: ",
        slowest: "Slowest: ",
        mostTimeDetail: (total, share) =>
          `${total} · ${share}% of all tool time`,
        failsOftenDetail: (calls, failed, rate) =>
          `${failed} of ${calls} calls failed (${rate})`,
        slowestDetail: (median, calls) => `Median ${median} · ${calls} calls`,
        empty: "Nothing to look at in this period.",
      },
      toolTable: {
        name: "Name",
        calls: "Calls",
        total: "Total",
        median: "Median",
        failed: "Failed",
        open: (name) => `Show ${name}`,
        callsMeter: (name) => `${name} share of calls`,
        empty: "No tools were called in this period.",
        noMatch: "No tool has that name.",
        loading: "Loading tools",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `In the ${period}, agents called tools `,
          { strong: `${calls} times` },
          " and spent ",
          { strong: time },
          " running them. ",
          { danger: `${failed} failed` },
          ` (${rate}).`,
        ],
      },
      toolCalls: {
        note: "Sessions you cannot see show only their times, with no title or link",
        hidden: "Session you cannot see",
        outcome: { ok: "Done", failed: "Failed", unknown: "Unknown" },
        none: "—",
        empty: "No calls in this period.",
      },
      toolsFilter: {
        sort: "Sort",
        by: {
          calls: "Most used",
          time: "Most time",
          slow: "Slowest",
          failed: "Failed",
        },
        search: "Find a tool",
        placeholder: "Find a tool or command",
      },
      toolRail: {
        label: "Selected tool",
        calls: "Calls",
        total: "Total",
        median: "Median",
        failed: "Failed",
        callsValue: (calls) => calls,
        failedValue: (failed, rate) => `${failed} (${rate})`,
        perDay: "Calls per day",
        perDayNote: (days) => `Last ${days} days`,
        perDayChart: ({ name, days, total, peakDay, peak }) =>
          `${name} calls per day, last ${days} days, ${total} in all, most on ${peakDay} with ${peak}`,
        recent: "Recent calls",
        callSort: "Sort calls",
        callSortBy: { recent: "Recent", slowest: "Slowest" },
        loading: "Loading tools",
      },
      head: {
        title: "Usage & limits",
        description:
          "See how much agents run, what they spend, and where they get stuck.",
        tabs: "Usage & limits tabs",
        tab: {
          overview: "Overview",
          usage: "Usage",
          tools: "Tool activity",
          limits: "Limits",
        },
        soon: "This screen is not ready yet.",
      },
      usageFilters: {
        scope: "Scope",
        me: "My usage",
        installation: "Whole installation",
        period: "Period",
        days: (days) => `${days} days`,
      },
      usageKpis: {
        sessions: "Sessions",
        sessionsNote: "Sessions started in this period",
        sessionsChart: "Sessions per day",
        runTime: "Run time",
        runTimeNote:
          "From each turn's start to its end, time waiting for answers included",
        runTimeChart: "Run time per day",
        cost: "Cost",
        estimated: "Estimate",
        costIncomplete:
          "Turns still running or without a reported cost may make this lower than the real cost",
        costChart: "Cost per day",
        tokens: "Tokens",
        tokensNote: "Tokens from calls included in the cost estimate",
        tokensChart: "Tokens per day",
        loading: "Loading usage",
      },
      installationLimits: {
        capacity: "Execution capacity",
        capacityNote: "Applies to the whole installation",
        asOf: (at) => `As of ${at}`,
        slotsInUse: "Slots in use",
        slotsFree: (free) => `${free} free`,
        slotsMeter: "Slot use",
        storage: "Input message storage",
        storageMeter: "Input message storage use",
        storageNote: "Counts input messages only",
        limits: "Limits",
        item: "Item",
        current: "Current",
        limit: "Limit",
        note: "Note",
        perSession: "Counted per session",
        notSet: "Not set",
        slots: "Concurrent slots",
        slotsRowNote:
          "The installation's cap. Sessions wait when no slot is free",
        storageRowNote:
          "Counts only the input messages sent to sessions; outputs are counted separately",
        outputs: "Output storage",
        outputsRowNote: "Space session outputs take. Shown, never enforced",
        outputsIncompleteNote:
          "Checkpoints from before outputs were counted may remain, so this can be low",
        outputsAtLeast: (bytes) => `At least ${bytes}`,
        noLimit: "No limit",
        sessionCost: "Cost per session",
        sessionCostNote:
          "Sessions over the estimated cost limit cannot start new turns",
        sessionTokens: "Tokens per session",
        sessionTokensNote:
          "Sessions over the token limit cannot start new turns",
        queuedInput: "Queued inputs per session",
        queuedInputValue: (count) => count,
        queuedInputNote: "How many inputs one session may hold",
        maxTurn: "Longest turn",
        maxTurnNote: "How long one turn may run",
        loading: "Loading limits",
        memberNote: "Applies to your sessions",
        memberSlotsNote:
          "No cap per member. Members share the installation's slots",
        monthlyCost: "Monthly cost",
        monthlyCostNote: "No monthly cost limit per member",
        memberOutputsNote: "Outputs are not counted per member",
        notMeasured: "Not measured",
      },
      usageCostTable: {
        sessions: "Sessions",
        tokens: "Tokens",
        cost: "Cost",
        costShare: (name) => `${name} share of cost`,
        noAgent: "No agent",
        noModel: "Cost without metered calls",
        emptyAgent: "No agent spent anything in this period.",
        emptyModel: "No model was billed in this period.",
      },
      usageDailyCost: {
        title: "Cost per day",
        description: "Point at a bar for that day's cost and sessions",
        complete: "Cost reported",
        partial: "Some cost not reported",
        chart: (days) => `Estimated cost per day, ${days} days`,
        tip: (day, cost, sessions, partial) =>
          `${day} · ${cost} · ${sessions} sessions${partial ? " · some cost not reported" : ""}`,
      },
      usageTokenMix: {
        title: "Token mix",
        description: (total) =>
          `${total} tokens from calls included in the cost estimate, by type`,
        input: "Input",
        output: "Output",
        cacheRead: "Cache read",
        cacheWrite: "Cache write",
        share: (label) => `${label} share of tokens`,
      },
      usageBasis: {
        scope: { me: "My usage", installation: "Whole installation" },
        rule: "Cost, tokens and run time count on the day a session started",
        readAt: (at) => `Read at ${at}`,
      },
    },
  };
