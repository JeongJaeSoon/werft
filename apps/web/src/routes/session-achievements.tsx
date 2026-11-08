import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  AchievementJudgment,
  ListSessionAchievementsResponse,
  ReviewAchievementRequest,
  ReviewAchievementResponse,
  SessionAchievement,
  SessionDetail,
} from "@werft-ai/contracts";
import { administeredAgentsQuery, queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Code,
  FieldError,
  Heading,
  Link,
  RelativeTime,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Text,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import { useHasPermission, useMe } from "../auth/guard.tsx";
import { ADMINISTERED_LIST_LIMIT } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/** The outputs tab's `out/` file list, which a file achievement points at. */
export const OUT_FILES_ID = "session-out-files";

// A judgment follows evidence the refresher reads once a minute.
const ACHIEVEMENTS_REFETCH_MS = 60_000;

const STATE_BADGE = {
  auto: "green",
  confirmed: "green",
  needs_review: "amber",
  rejected: "gray",
} as const;

// Judge calls cost fractions of a cent; the session cost's format rounds
// them to "<$0.01".
const JUDGE_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const RATIO = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function achievementsKey(
  client: ReturnType<typeof useWerft>["client"],
  sessionId: string,
) {
  return [...queryKeysOf(client).session(sessionId), "achievements"];
}

export function useSessionAchievements(session: SessionDetail) {
  const { client } = useWerft();
  return useQuery({
    queryKey: achievementsKey(client, session.id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/achievements", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionAchievementsResponse>,
    retry: false,
    refetchInterval: ACHIEVEMENTS_REFETCH_MS,
  });
}

/**
 * Who may confirm or reject: owners and admins on every agent, an agent's
 * admins on its achievements. The server decides; this only hides buttons.
 */
function useReviewable(): (agentId: string | null) => boolean {
  const { client } = useWerft();
  const everywhere = useHasPermission("achievement.review");
  const person = useMe()?.principal.kind === "user";
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: person && !everywhere,
  });
  const items = administered.data?.items;
  return (agentId) =>
    everywhere ||
    (agentId !== null &&
      items !== undefined &&
      (items.some((agent) => agent.id === agentId) ||
        items.length >= ADMINISTERED_LIST_LIMIT));
}

/**
 * What the workspace's achievement rules counted in the session, each with
 * its evidence and how it was judged, and the session's latest judgment.
 */
export function SessionAchievements({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const achievements = useSessionAchievements(session);
  const reviewable = useReviewable();
  // The list read right after a review may still be the old one; show the
  // review the POST returned, then read the card again.
  const reviewed = (decided: SessionAchievement) => {
    queryClient.setQueryData<ListSessionAchievementsResponse>(
      achievementsKey(client, session.id),
      (old) =>
        old && {
          ...old,
          items: old.items.map((item) =>
            item.id === decided.id ? decided : item,
          ),
        },
    );
    return achievements.refetch();
  };
  // A session gone from view is the detail screen's to report.
  if (achievements.error && !isApiError(achievements.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={achievements.error}
        onRetry={() => void achievements.refetch()}
      />
    );
  }
  const data = achievements.data;
  if (data === undefined || (data.items.length === 0 && !data.judgment)) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading id={titleId}>
          {t("session.achievements.title")}{" "}
          <Text as="span" variant="sub">
            {data.items.length}
          </Text>
        </Heading>
        {data.judgment ? (
          <RejudgeButton
            session={session}
            onQueued={() => void achievements.refetch()}
          />
        ) : null}
      </div>
      <Text variant="sub">{t("session.achievements.description")}</Text>
      {data.judgment ? (
        <JudgmentMeta
          judgment={data.judgment}
          count={data.judgment_count}
          costUsd={data.judge_cost_usd}
        />
      ) : null}
      {data.items.length === 0 ? null : (
        <RowList variant="joined">
          {data.items.map((achievement) => (
            <AchievementRow
              key={achievement.id}
              achievement={achievement}
              reviewable={reviewable(achievement.agent_id)}
              onReviewed={reviewed}
            />
          ))}
        </RowList>
      )}
    </section>
  );
}

function EvidenceLink({
  achievement,
}: {
  readonly achievement: SessionAchievement;
}) {
  if (achievement.evidence_kind === "out_file") {
    // The file is listed further down this tab.
    return (
      <Link
        href={`#${OUT_FILES_ID}`}
        variant="table"
        className="font-mono [overflow-wrap:anywhere]"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(OUT_FILES_ID)?.scrollIntoView();
        }}
      >
        {achievement.title}
      </Link>
    );
  }
  const external = achievement.evidence_kind !== "conversation";
  return (
    <Link
      href={achievement.link}
      variant="table"
      className="[overflow-wrap:anywhere]"
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {achievement.title}
    </Link>
  );
}

function AchievementRow({
  achievement,
  reviewable,
  onReviewed,
}: {
  readonly achievement: SessionAchievement;
  readonly reviewable: boolean;
  readonly onReviewed: (decided: SessionAchievement) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [failure, setFailure] = useState<string | null>(null);
  const review = useMutation<
    ReviewAchievementResponse,
    ApiError,
    ReviewAchievementRequest["action"]
  >({
    mutationFn: (action) =>
      unwrap(
        client.POST("/v1/achievements/{id}/review", {
          params: { path: { id: achievement.id } },
          body: { action },
        }),
      ),
    onMutate: () => setFailure(null),
    onSuccess: (response) => onReviewed(response.achievement),
    onError: (error) => setFailure(t(errorKey(error.code))),
  });
  const state = achievement.review_state;
  const open = state === "auto" || state === "needs_review";
  const name = achievement.rule_title;
  return (
    <RowListItem className="items-start">
      <RowLines>
        <Text
          as="span"
          weight="medium"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          <Badge variant={STATE_BADGE[state]}>
            {t(`session.achievements.state.${state}`)}
          </Badge>
          {name}
          <Code>{achievement.type_key}</Code>
        </Text>
        {achievement.judge === "luna" && achievement.probability !== null ? (
          <Text as="span" variant="sub">
            {achievement.threshold === null
              ? t("session.achievements.probability", {
                  probability: RATIO.format(achievement.probability),
                })
              : t("session.achievements.probabilityThreshold", {
                  probability: RATIO.format(achievement.probability),
                  threshold: RATIO.format(achievement.threshold),
                })}
          </Text>
        ) : null}
        <Text
          as="span"
          variant="meta"
          className="flex min-w-0 flex-wrap gap-x-3"
        >
          <Text as="span" variant="meta" className="min-w-0">
            {t("session.achievements.evidence")}{" "}
            <EvidenceLink achievement={achievement} />
            {state === "needs_review" &&
            achievement.evidence_kind === "out_file"
              ? ` ${t("session.achievements.fileNeedsReview")}`
              : null}
          </Text>
          <Text as="span" variant="meta">
            {t("session.achievements.rule", {
              version: achievement.rule_version,
            })}
            {" · "}
            {t(`session.achievements.judge.${achievement.judge}`)}
            {achievement.rejudged_after_merge
              ? ` · ${t("session.achievements.rejudgedAfterMerge")}`
              : null}
          </Text>
        </Text>
        {failure === null ? null : <FieldError>{failure}</FieldError>}
      </RowLines>
      {reviewable && open ? (
        <div className="flex flex-none gap-1.5">
          <RowAction
            variant={state === "auto" ? "danger" : "outline"}
            disabled={review.isPending}
            aria-label={t("session.achievements.rejectNamed", { name })}
            onClick={() => review.mutate("reject")}
          >
            {t("session.achievements.reject")}
          </RowAction>
          {state === "needs_review" ? (
            <RowAction
              variant="default"
              disabled={review.isPending}
              aria-label={t("session.achievements.confirmNamed", { name })}
              onClick={() => review.mutate("confirm")}
            >
              {t("session.achievements.confirm")}
            </RowAction>
          ) : null}
        </div>
      ) : null}
    </RowListItem>
  );
}

const PENDING_STATUS = {
  queued: "session.achievements.status.queued",
  running: "session.achievements.status.running",
  deferred: "session.achievements.status.deferred",
} as const;

/** The section head's action; only a rule manager gets it. */
function RejudgeButton({
  session,
  onQueued,
}: {
  readonly session: SessionDetail;
  readonly onQueued: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const manager = useHasPermission("achievement_rule.manage");
  const [failure, setFailure] = useState<string | null>(null);
  const rejudge = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/sessions/{id}/achievement-judgments", {
          params: { path: { id: session.id } },
        }),
      ),
    onMutate: () => setFailure(null),
    onSuccess: onQueued,
    onError: (error) => setFailure(t(errorKey(error.code))),
  });
  if (!manager) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <RowAction disabled={rejudge.isPending} onClick={() => rejudge.mutate()}>
        {t("session.achievements.rejudge")}
      </RowAction>
      {failure === null ? null : <FieldError>{failure}</FieldError>}
    </div>
  );
}

/** When the session was last judged, why, how often, and what it cost. */
function JudgmentMeta({
  judgment,
  count,
  costUsd,
}: {
  readonly judgment: AchievementJudgment;
  readonly count: number;
  readonly costUsd: number;
}) {
  const { t, locale } = useI18n();
  const { status } = judgment;
  const stopped = status === "failed" || status === "skipped";
  return (
    <div className="flex flex-col gap-0.5">
      <Text as="span" variant="meta">
        {status === "queued" ||
        status === "running" ||
        status === "deferred" ? (
          t(PENDING_STATUS[status])
        ) : (
          <>
            {t("session.achievements.lastJudged")}{" "}
            <RelativeTime
              value={judgment.finished_at ?? judgment.created_at}
              locale={locale}
            />
          </>
        )}
        {" · "}
        {t(
          `session.achievements.trigger.${judgment.evidence_change ?? judgment.trigger}`,
        )}
        {" · "}
        {t("session.achievements.count", { count })}
        {" · "}
        {t("session.achievements.cost", { cost: JUDGE_USD.format(costUsd) })}
      </Text>
      {stopped ? (
        <Text as="span" variant="meta">
          {t(`session.achievements.status.${status}`)}
          {judgment.error_code === null
            ? null
            : `: ${t(`session.achievements.error.${judgment.error_code}`)}`}
        </Text>
      ) : judgment.error_code === null ? null : (
        // A refusal leaves the judgment succeeded.
        <Text as="span" variant="meta">
          {t(`session.achievements.error.${judgment.error_code}`)}
        </Text>
      )}
    </div>
  );
}
