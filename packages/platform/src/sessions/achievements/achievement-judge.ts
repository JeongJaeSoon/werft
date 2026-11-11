import {
  type AchievementJudgmentError,
  type AchievementPayload,
  type AchievementReviewState,
  BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS,
} from "@werft-ai/contracts";
import type { SessionOutputSource } from "../output-service.ts";
import {
  ACHIEVEMENT_JUDGMENT_RETRY_MS,
  type AchievementJudgmentStore,
  type ClaimedJudgment,
  type JudgedRule,
  type JudgmentContext,
  type JudgmentEgressStore,
  type JudgmentResult,
  type NewAchievement,
} from "./achievement-judgment-store.ts";
import {
  DecisionsCallError,
  type DecisionsClient,
  type DecisionsRequest,
} from "./decisions-client.ts";
import type { JudgeConnections } from "./judge-connections.ts";
import { issueJudgmentToken } from "./judgment-token.ts";
import {
  fileExcerpt,
  inputDigestOf,
  pairAnswerOf,
  questionOf,
  TRANSCRIPT_TURNS,
  transcriptExcerpt,
  untrusted,
} from "./luna-question.ts";

export const ACHIEVEMENT_JUDGE_INTERVAL_MS = 30_000;
/** A judgment a dead replica held is claimed again after this. */
export const ACHIEVEMENT_JUDGMENT_LEASE_MS = 120_000;
export const ACHIEVEMENT_JUDGMENT_CLAIM_MAX = 20;

type Logger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

type Evidence = {
  kind: JudgedRule["evidenceKind"];
  id: string | null;
  title: string;
  link: string;
  /** What a built-in type's payload copies. */
  payload: Record<string, unknown>;
  /** The facts Luna is shown, apart from any file or conversation text. */
  facts: string[];
};

/** `owner/repo` of a GitHub pull request or review URL. */
function repositoryOf(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function evidenceOf(
  context: JudgmentContext,
  files: readonly { path: string; bytes: number }[],
): Evidence[] {
  const sessionId = context.session.id;
  const evidence: Evidence[] = [];
  for (const outcome of context.outcomes) {
    const repository = repositoryOf(outcome.url);
    if (repository === null) continue;
    const base = {
      kind: outcome.kind,
      id: outcome.id,
      title: `${repository}#${outcome.number}`,
      link: outcome.url,
    };
    if (outcome.kind === "github_pull_request") {
      const mergedAt = outcome.mergedAt?.toISOString() ?? null;
      evidence.push({
        ...base,
        payload: {
          repository,
          number: outcome.number,
          url: outcome.url,
          state: outcome.state,
          merged_at: mergedAt,
          additions: outcome.additions,
          deletions: outcome.deletions,
        },
        facts: [
          `repository: ${repository}`,
          `number: ${outcome.number}`,
          `state: ${outcome.state}`,
          `merged_at: ${mergedAt ?? "none"}`,
          `additions: ${outcome.additions ?? "unknown"}`,
          `deletions: ${outcome.deletions ?? "unknown"}`,
          ...(outcome.title === null
            ? []
            : [`title: ${untrusted(outcome.title)}`]),
        ],
      });
    } else {
      evidence.push({
        ...base,
        payload: {
          repository,
          number: outcome.number,
          url: outcome.url,
          event: outcome.event,
          commit_id: outcome.commitId,
        },
        facts: [
          `repository: ${repository}`,
          `number: ${outcome.number}`,
          `event: ${outcome.event}`,
        ],
      });
    }
  }
  for (const file of files) {
    evidence.push({
      kind: "out_file",
      id: file.path,
      title: file.path,
      // The console addresses the session, not its outputs tab or a file.
      link: `/sessions/${sessionId}`,
      payload: { path: file.path, size: file.bytes },
      // An agent names its files.
      facts: [`path: ${untrusted(file.path)}`, `size: ${file.bytes}`],
    });
  }
  // A session has a conversation once its first message gave it a title.
  if (context.session.title !== null) {
    evidence.push({
      kind: "conversation",
      id: null,
      title: context.session.title,
      link: `/sessions/${sessionId}`,
      payload: {},
      facts: [],
    });
  }
  return evidence;
}

/** Agent-written evidence never counts before a person confirms it. */
function reviewStateOf(kind: Evidence["kind"]): AchievementReviewState {
  return kind === "github_pull_request" || kind === "github_review"
    ? "auto"
    : "needs_review";
}

class OutputsUnavailable extends Error {}

function failureCodeOf(error: unknown): AchievementJudgmentError | null {
  if (!(error instanceof DecisionsCallError)) return null;
  switch (error.reason) {
    case "timeout":
      return "judge_timeout";
    case "bad_response":
      return "judge_bad_response";
    default:
      return "judge_http_error";
  }
}

/**
 * Judges each claimed judgment's session against the workspace's rules in
 * use (design achievement-rules.md §4). Each API replica runs one; a claim
 * leases its judgments, and the achievements and the result are written in
 * one transaction under that lease. An `always` rule counts each of its
 * evidence at no cost. A `luna` rule's pairs wait for the next UTC day once
 * the workspace's judgments have spent the day's budget, and are skipped
 * for a session at its cap (`session_limit`) or without a judge it can
 * reach (`judge_unavailable`). Otherwise each pair is one choice question
 * to Luna through the egress proxy, unless the same rule versions and
 * inputs were judged last time. A try that fails is tried again 1, 5 and
 * 30 minutes later, then ends `failed`. The lease is renewed as each
 * judgment starts and before each call; once lost, the judgment is left
 * to whoever holds it.
 */
export function createAchievementJudge(deps: {
  store: Pick<
    AchievementJudgmentStore,
    "claim" | "context" | "finish" | "transcript" | "renew"
  >;
  outputs: Pick<SessionOutputSource, "readOutputs" | "openOutput">;
  logger: Logger;
  /** Absent, `luna` pairs are skipped as `judge_unavailable`. */
  luna?: {
    connections: JudgeConnections;
    tokens: Pick<JudgmentEgressStore, "issueToken">;
    decisions: DecisionsClient;
  };
  claimMax?: number;
  leaseMs?: number;
}) {
  const { store, outputs, logger } = deps;
  const claimMax = deps.claimMax ?? ACHIEVEMENT_JUDGMENT_CLAIM_MAX;
  const leaseMs = deps.leaseMs ?? ACHIEVEMENT_JUDGMENT_LEASE_MS;

  /** The next retry of a failed try, or `failed` once the retries are spent. */
  function again(
    claimed: ClaimedJudgment,
    errorCode: AchievementJudgmentError | null,
  ):
    | { status: "queued"; retryInMs: number; errorCode: typeof errorCode }
    | { status: "failed"; errorCode: typeof errorCode } {
    const retryInMs = ACHIEVEMENT_JUDGMENT_RETRY_MS[claimed.attempts - 1];
    return retryInMs === undefined
      ? { status: "failed", errorCode }
      : { status: "queued", retryInMs, errorCode };
  }

  function payloadOf(
    rule: JudgedRule,
    evidence: Evidence,
  ): { ok: true; payload: AchievementPayload | null } | { ok: false } {
    if (
      !rule.builtin ||
      !Object.hasOwn(BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS, rule.typeKey)
    ) {
      return { ok: true, payload: null };
    }
    const schema =
      BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS[
        rule.typeKey as keyof typeof BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS
      ];
    const parsed = schema.safeParse(evidence.payload);
    return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
  }

  function achievementOf(
    claimed: ClaimedJudgment,
    context: JudgmentContext,
    rule: JudgedRule,
    item: Evidence,
    probability: number | null,
  ): NewAchievement | null {
    const payload = payloadOf(rule, item);
    if (!payload.ok) {
      logger.warn("Achievement payload failed its schema; not counted", {
        judgment_id: claimed.id,
        rule_id: rule.id,
        evidence_kind: item.kind,
      });
      return null;
    }
    return {
      ruleId: rule.id,
      ruleFamilyId: rule.familyId,
      typeId: rule.typeId,
      agentId: context.session.agentId,
      agentReleaseId: context.session.agentReleaseId,
      title: item.title,
      link: item.link,
      evidenceKind: item.kind,
      evidenceId: item.id,
      payload: payload.payload,
      judge: probability === null ? "always" : "luna",
      probability,
      reviewState: reviewStateOf(item.kind),
    };
  }

  /** The pair's question, or null when nothing of it may be sent. */
  async function questionFor(
    claimed: ClaimedJudgment,
    context: JudgmentContext,
    rule: JudgedRule,
    item: Evidence,
  ): Promise<DecisionsRequest | null> {
    if (item.kind === "conversation") {
      if (context.judge.transcript === "none") return null;
      const turns = await store.transcript(claimed.sessionId, TRANSCRIPT_TURNS);
      return questionOf(rule.definition, item.kind, [
        `turns: ${transcriptExcerpt(turns)}`,
      ]);
    }
    if (item.kind !== "out_file" || item.id === null) {
      return questionOf(rule.definition, item.kind, item.facts);
    }
    const opened = await outputs.openOutput(claimed.sessionId, item.id);
    if (opened.status === "unavailable") throw new OutputsUnavailable();
    // An output listed without its bytes is judged on its path and size.
    if (opened.status === "missing") {
      return questionOf(rule.definition, item.kind, item.facts);
    }
    const content = await fileExcerpt(opened.body);
    return questionOf(rule.definition, item.kind, [
      ...item.facts,
      `content: ${untrusted(content)}`,
    ]);
  }

  /** Null once the lease is lost: whoever holds it now judges. */
  async function judge(
    claimed: ClaimedJudgment,
  ): Promise<JudgmentResult | null> {
    const context = await store.context(claimed);
    let files: { path: string; bytes: number }[] = [];
    let outputsUnavailable = false;
    if (context.rules.some((rule) => rule.evidenceKind === "out_file")) {
      const listed = await outputs
        .readOutputs(claimed.sessionId)
        .catch((error: unknown) => {
          logger.warn("Achievement judgment could not list out/", {
            judgment_id: claimed.id,
            error: error instanceof Error ? error.name : String(error),
          });
          return { status: "unavailable" as const };
        });
      // The pairs that need no out/ list are counted all the same.
      if (listed.status === "unavailable") outputsUnavailable = true;
      if (listed.status === "ready") {
        files = listed.outputs.map(({ path, bytes }) => ({ path, bytes }));
      }
    }
    const evidence = evidenceOf(context, files);
    const rules = new Set<string>();
    const evidenceIds = new Set<string>();
    const achievements: NewAchievement[] = [];
    const lunaPairs: { rule: JudgedRule; item: Evidence }[] = [];
    for (const rule of context.rules) {
      for (const item of evidence) {
        if (item.kind !== rule.evidenceKind) continue;
        rules.add(rule.id);
        if (item.id !== null) evidenceIds.add(item.id);
        if (rule.judge !== "always") {
          lunaPairs.push({ rule, item });
          continue;
        }
        const achievement = achievementOf(claimed, context, rule, item, null);
        if (achievement !== null) achievements.push(achievement);
      }
    }
    const paired = {
      rules: [...rules],
      evidenceIds: [...evidenceIds],
      achievements,
    };
    if (outputsUnavailable) {
      return { ...again(claimed, "outputs_unavailable"), ...paired };
    }
    if (lunaPairs.length === 0) {
      return { status: "succeeded", errorCode: null, ...paired };
    }
    const { judge } = context;
    if (judge.connectionId === null) {
      return { status: "skipped", errorCode: "judge_unavailable", ...paired };
    }
    if (judge.spentUsd >= judge.dailyBudgetUsd) {
      return {
        status: "deferred",
        until: judge.budgetResetsAt,
        errorCode: null,
        ...paired,
      };
    }
    if (judge.sessionJudgments >= judge.maxPerSession) {
      return { status: "skipped", errorCode: "session_limit", ...paired };
    }
    const luna = deps.luna;
    if (
      luna === undefined ||
      (await luna.connections.upstream(judge.connectionId)) === null
    ) {
      return { status: "skipped", errorCode: "judge_unavailable", ...paired };
    }

    const asked: {
      rule: JudgedRule;
      item: Evidence;
      request: DecisionsRequest;
    }[] = [];
    try {
      for (const { rule, item } of lunaPairs) {
        const request = await questionFor(claimed, context, rule, item);
        if (request !== null) asked.push({ rule, item, request });
      }
    } catch (error) {
      if (!(error instanceof OutputsUnavailable)) throw error;
      return { ...again(claimed, "outputs_unavailable"), ...paired };
    }
    const inputDigest = inputDigestOf(
      asked.map(({ rule, request }) => ({ ruleId: rule.id, request })),
      judge.threshold,
    );
    const unchanged = {
      connectionId: judge.connectionId,
      inputDigest,
      declined: [],
    };
    if (asked.length === 0 || inputDigest === judge.lastInputDigest) {
      return {
        status: "succeeded",
        errorCode: null,
        ...paired,
        luna: unchanged,
      };
    }
    const token = await issueJudgmentToken(luna.tokens, claimed);
    // The lease ran out or was taken over: whoever claims it next judges.
    if (token === null) return null;

    const declined: { ruleFamilyId: string; evidenceId: string | null }[] = [];
    // Kept only if every pair is answered: a failed try writes none of them.
    const judged: NewAchievement[] = [];
    let refused = false;
    for (const { rule, item, request } of asked) {
      if (!(await store.renew(claimed, leaseMs))) return null;
      let answer: ReturnType<typeof pairAnswerOf>;
      try {
        answer = pairAnswerOf(
          await luna.decisions.decide(token, request),
          judge.threshold,
        );
      } catch (error) {
        // Never the upstream's body: it may name the key.
        logger.warn("Achievement judge call failed", {
          judgment_id: claimed.id,
          rule_id: rule.id,
          reason:
            error instanceof DecisionsCallError ? error.reason : "unexpected",
          status: error instanceof DecisionsCallError ? error.status : null,
        });
        return {
          ...again(claimed, failureCodeOf(error)),
          ...paired,
          threshold: judge.threshold,
        };
      }
      if (answer.achieved) {
        const achievement = achievementOf(
          claimed,
          context,
          rule,
          item,
          answer.probability,
        );
        if (achievement !== null) judged.push(achievement);
      } else if (answer.refused) {
        // No judgment, not a "no": an earlier yes for the pair stays.
        refused = true;
      } else {
        declined.push({ ruleFamilyId: rule.familyId, evidenceId: item.id });
      }
    }
    return {
      status: "succeeded",
      errorCode: refused ? "judge_refused" : null,
      ...paired,
      achievements: [...achievements, ...judged],
      luna: { ...unchanged, declined },
      threshold: judge.threshold,
    };
  }

  /** One pass. Returns how many judgments it finished. */
  async function runOnce(): Promise<number> {
    const claimed = await store.claim({ max: claimMax, leaseMs });
    let finished = 0;
    for (const judgment of claimed) {
      const nothing = { rules: [], evidenceIds: [], achievements: [] };
      let result: JudgmentResult | null;
      // One lease covers the whole batch; the judgments before this one
      // may have spent it.
      if (!(await store.renew(judgment, leaseMs))) {
        result = null;
      } else if (judgment.attempts > ACHIEVEMENT_JUDGMENT_RETRY_MS.length + 1) {
        // No try finished since: replicas died or lost the lease. The last
        // failure that was written says why.
        result = {
          status: "failed",
          errorCode: judgment.errorCode,
          ...nothing,
        };
      } else {
        try {
          result = await judge(judgment);
        } catch (error) {
          logger.warn("Achievement judgment failed", {
            judgment_id: judgment.id,
            error: error instanceof Error ? error.name : String(error),
          });
          result = { ...again(judgment, null), ...nothing };
        }
      }
      if (result === null) {
        logger.info("Achievement judgment was taken over", {
          judgment_id: judgment.id,
        });
        continue;
      }
      try {
        const kept = await store.finish(judgment, result);
        if (kept) {
          finished += 1;
        } else {
          logger.info("Achievement judgment was taken over", {
            judgment_id: judgment.id,
          });
        }
      } catch (error) {
        // The lease runs out and another pass claims it again.
        logger.warn("Achievement judgment not recorded", {
          judgment_id: judgment.id,
          error: error instanceof Error ? error.name : String(error),
        });
      }
    }
    return finished;
  }

  function start(intervalMs = ACHIEVEMENT_JUDGE_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          await runOnce();
        } catch (error) {
          logger.warn("Achievement judge pass failed", {
            error: error instanceof Error ? error.name : String(error),
          });
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      })();
    };
    timer = setTimeout(tick, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}
