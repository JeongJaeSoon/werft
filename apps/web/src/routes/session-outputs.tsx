import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  ListSessionGitHubRefusalsResponse,
  ListSessionOutcomesResponse,
  ListSessionOutputsResponse,
  SessionDetail,
  SessionGitHubAttribution,
  SessionOutcome,
} from "@werft-ai/contracts";
import { queryKeysOf } from "@werft-ai/core";
import { useSessionUsage, useWerft } from "@werft-ai/react";
import {
  OPERATIONS_MESSAGES,
  sessionRepositoriesOf,
} from "@werft-ai/react/components";
import {
  Badge,
  Code,
  EmptyState,
  Link,
  RelativeTime,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { Download } from "lucide-react";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  OUT_FILES_ID,
  SessionAchievements,
  useSessionAchievements,
} from "./session-achievements.tsx";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

function useSessionOutputs(session: SessionDetail) {
  const { client } = useWerft();
  return useQuery({
    // A new checkpoint is a new list.
    queryKey: [
      ...queryKeysOf(client).session(session.id),
      "outputs",
      session.checkpoint_revision,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/outputs", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionOutputsResponse>,
    retry: false,
    enabled: session.checkpoint_revision !== null,
  });
}

// A session with only attached repositories has pushes and pull requests too.
const hasRepository = (session: SessionDetail) =>
  sessionRepositoriesOf(session).length > 0;

// GitHub changes a pull request after the session has stopped, and the
// server's refresher reads it once a minute, so no session event says when.
const OUTCOMES_REFETCH_MS = 60_000;

function useSessionOutcomes(session: SessionDetail) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...queryKeysOf(client).session(session.id), "outcomes"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/outcomes", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionOutcomesResponse>,
    retry: false,
    enabled: hasRepository(session),
    refetchInterval: OUTCOMES_REFETCH_MS,
  });
}

/** Achievements, evidence and files, once all are read: the outputs tab's count. */
export function SessionOutputsCount({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const outputs = useSessionOutputs(session);
  const outcomes = useSessionOutcomes(session);
  const achievements = useSessionAchievements(session);
  const files =
    session.checkpoint_revision === null
      ? 0
      : (outputs.data?.items.length ?? null);
  const pulls = hasRepository(session)
    ? (outcomes.data?.items.length ?? (outcomes.error ? 0 : null))
    : 0;
  const achieved =
    achievements.data?.items.length ?? (achievements.error ? 0 : null);
  return files === null || pulls === null || achieved === null
    ? null
    : files + pulls + achieved;
}

type PullRequestOutcome = Extract<
  SessionOutcome,
  { type: "github_pull_request" }
>;
type ReviewOutcome = Extract<SessionOutcome, { type: "github_review" }>;

/**
 * `owner/name#7` from the outcome's URL (a review's is its pull request's,
 * with a fragment); the repository id otherwise.
 */
function pullRequestName(outcome: SessionOutcome, number: string): string {
  const [, owner, name] = new URL(outcome.url).pathname.split("/");
  const repository =
    owner && name ? `${owner}/${name}` : (outcome.repository_id ?? "");
  return `${repository}#${number}`;
}

function OutcomeLink({
  outcome,
  number,
  kind,
}: {
  readonly outcome: SessionOutcome;
  readonly number: string;
  readonly kind: string;
}) {
  return (
    <span className="min-w-0">
      <Link
        href={outcome.url}
        target="_blank"
        rel="noreferrer"
        variant="table"
        className="font-mono [overflow-wrap:anywhere]"
      >
        {pullRequestName(outcome, number)}
      </Link>{" "}
      {kind}
    </span>
  );
}

const STATE_BADGE = {
  open: "blue",
  merged: "green",
  closed: "gray",
} as const;

function PullRequestRow({ outcome }: { readonly outcome: PullRequestOutcome }) {
  const { t, locale } = useI18n();
  const state = outcome.state;
  const { additions, deletions } = outcome.metadata;
  const ended =
    outcome.state === "merged" && outcome.merged_at !== null
      ? { label: t("session.outcomes.mergedAt"), at: outcome.merged_at }
      : outcome.state === "closed" && outcome.closed_at !== null
        ? { label: t("session.outcomes.closedAt"), at: outcome.closed_at }
        : null;
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 items-center gap-2">
          <OutcomeLink
            outcome={outcome}
            number={outcome.external_id ?? ""}
            kind={t("session.outcomes.kind.pullRequest")}
          />
          <Badge
            variant={STATE_BADGE[state] ?? "gray"}
            className="shrink-0 whitespace-nowrap"
          >
            {t(`session.outcomes.state.${state}`)}
          </Badge>
        </Text>
        <Text as="span" variant="meta">
          {ended === null ? null : (
            <>
              {ended.label} <RelativeTime value={ended.at} locale={locale} />
              {" · "}
            </>
          )}
          {additions === null || deletions === null
            ? null
            : `+${additions} −${deletions} · `}
          {outcome.state_checked_at === null ? (
            t("session.outcomes.notChecked")
          ) : (
            <>
              {t("session.outcomes.checkedAt")}{" "}
              <RelativeTime value={outcome.state_checked_at} locale={locale} />
            </>
          )}
        </Text>
        {outcome.check_error === null ? null : (
          <Text as="span" variant="meta">
            {t(`session.outcomes.checkError.${outcome.check_error}`)}
          </Text>
        )}
      </RowLines>
    </RowListItem>
  );
}

function ReviewRow({
  outcome,
  session,
}: {
  readonly outcome: ReviewOutcome;
  readonly session: SessionDetail;
}) {
  const { t, locale } = useI18n();
  const { number, event, opened_by_session_id } = outcome.metadata;
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 items-center gap-2">
          <OutcomeLink
            outcome={outcome}
            number={String(number)}
            kind={t("session.outcomes.kind.review")}
          />
          <Badge variant="gray">{t(`session.outcomes.event.${event}`)}</Badge>
        </Text>
        <Text as="span" variant="meta">
          {t("session.outcomes.submittedAt")}{" "}
          <RelativeTime value={outcome.created_at} locale={locale} />
          {opened_by_session_id !== null && opened_by_session_id !== session.id
            ? ` · ${t("session.outcomes.otherSessionPullRequest")}`
            : null}
        </Text>
      </RowLines>
    </RowListItem>
  );
}

/** This session's tokens and estimated cost, as the detail reads them. */
function SessionUsageLine({ session }: { readonly session: SessionDetail }) {
  const { t, locale } = useI18n();
  const usage = useSessionUsage(session.id, true).data;
  if (usage === undefined) return null;
  const tokens = new Intl.NumberFormat(locale).format(usage.token_count);
  return (
    <Text variant="meta">
      {usage.cost.kind === "unmetered"
        ? t("session.outcomes.usageUnmetered", { tokens })
        : t("session.outcomes.usage", {
            tokens,
            cost: OPERATIONS_MESSAGES[locale].format.usd(usage.cost.amount_usd),
          })}
    </Text>
  );
}

function SessionPullRequests({
  session,
  outcomes,
}: {
  readonly session: SessionDetail;
  readonly outcomes: ReturnType<typeof useSessionOutcomes>;
}) {
  const { t } = useI18n();
  if (outcomes.error && !isApiError(outcomes.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={outcomes.error}
        onRetry={() => void outcomes.refetch()}
      />
    );
  }
  const items = outcomes.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section
      title={t("session.outcomes.title")}
      badge={<Badge>{items.length}</Badge>}
      description={t("session.outcomes.description")}
    >
      <RowList variant="joined">
        {items.map((outcome) =>
          outcome.type === "github_review" ? (
            <ReviewRow key={outcome.id} outcome={outcome} session={session} />
          ) : (
            <PullRequestRow key={outcome.id} outcome={outcome} />
          ),
        )}
      </RowList>
    </Section>
  );
}

/** The session's latest GitHub gate refusals: why, for what, and when. */
function SessionGitHubRefusals({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const refusals = useQuery({
    queryKey: [...queryKeysOf(client).session(session.id), "github-refusals"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/github/refusals", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionGitHubRefusalsResponse>,
    retry: false,
    enabled: hasRepository(session),
    refetchInterval: OUTCOMES_REFETCH_MS,
  });
  const items = refusals.data?.items ?? [];
  if (!hasRepository(session) || items.length === 0) return null;
  return (
    <Section title={t("session.refusals.title")}>
      <RowList variant="joined">
        {items.map((refusal) => (
          <RowListItem key={refusal.receipt_id}>
            <RowLines>
              <Text as="span">
                {t(`agentGitHub.refusal.${refusal.reason_code}`)}
              </Text>
              <Text as="span" variant="meta">
                {t(`agentGitHub.purpose.${refusal.purpose}`)}
                {" · "}
                <RelativeTime value={refusal.created_at} locale={locale} />
              </Text>
            </RowLines>
          </RowListItem>
        ))}
      </RowList>
    </Section>
  );
}

/**
 * The outputs tab (성과물): achievements, the evidence (pull requests,
 * reviews), `out/` files, the GitHub work and its refusals, then one meta
 * line with whom commits name and the session's tokens and cost. The tab's
 * count is the sum of the three counted lists above it.
 */
export function SessionOutputsTab({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const outputs = useSessionOutputs(session);
  const outcomes = useSessionOutcomes(session);
  // The tab counts achievements, so with any it is not empty.
  const achieved =
    (useSessionAchievements(session).data?.items.length ?? 0) > 0;
  const files = outputs.data?.items ?? [];
  const pulls = outcomes.data?.items ?? [];
  const filesRead =
    session.checkpoint_revision === null || outputs.data !== undefined;
  // A failed read is the pull request area's to report, even over a list an
  // earlier read kept.
  const pullsRead =
    !hasRepository(session) ||
    (outcomes.error === null
      ? outcomes.data !== undefined
      : isApiError(outcomes.error, "NOT_FOUND"));
  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <SessionAchievements session={session} />
      <SessionPullRequests session={session} outcomes={outcomes} />
      {filesRead && pullsRead && files.length === 0 && pulls.length === 0 ? (
        outputs.error && !isApiError(outputs.error, "NOT_FOUND") ? (
          <SessionOutputs session={session} />
        ) : achieved ? null : (
          <EmptyState
            title={t("session.outputs.empty")}
            description={t("session.outputs.emptyHint")}
          />
        )
      ) : (
        <SessionOutputs session={session} />
      )}
      <SessionGitHubRefusals session={session} />
      <div className="flex flex-col gap-1">
        <SessionAttribution session={session} />
        <SessionUsageLine session={session} />
      </div>
    </div>
  );
}

/**
 * Whom the session's commits name besides the App. Shown only for a session
 * with a repository; a failed read leaves the line out, as the outputs do not
 * depend on it.
 */
export function SessionAttribution({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const attribution = useQuery({
    queryKey: [
      ...queryKeysOf(client).session(session.id),
      "github-attribution",
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/github/attribution", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<SessionGitHubAttribution>,
    retry: false,
    enabled: hasRepository(session),
  });
  const data = attribution.data;
  if (!hasRepository(session) || data === undefined) return null;
  return (
    <Text variant="meta">
      {data.attribution === "co_author" && data.login !== null ? (
        t("session.attribution.coAuthor", { login: data.login })
      ) : data.attribution === "unlinked" ? (
        <>
          {t("session.attribution.unlinked")}{" "}
          <Link asChild underline="always">
            <RouterLink to="/settings/linked-accounts">
              {t("session.attribution.link")}
            </RouterLink>
          </Link>
        </>
      ) : (
        t("session.attribution.appOnly")
      )}
    </Text>
  );
}

/**
 * The files the session left under `out/` at its latest checkpoint, each
 * with a download link; nothing without any.
 */
function SessionOutputs({ session }: { readonly session: SessionDetail }) {
  const { t, locale } = useI18n();
  const outputs = useSessionOutputs(session);

  // A session gone from view is the detail screen's to report.
  if (outputs.error && !isApiError(outputs.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={outputs.error}
        onRetry={() => void outputs.refetch()}
      />
    );
  }
  if (outputs.isPending && session.checkpoint_revision !== null) {
    return <StatusScreen kind="loading" />;
  }
  const items = outputs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section
      id={OUT_FILES_ID}
      title={t("session.outputs.files")}
      badge={<Badge>{items.length}</Badge>}
    >
      <RowList variant="joined">
        {items.map((item) => {
          const name = item.path.replace(/^out\//, "");
          return (
            <RowListItem key={item.path} className="justify-between">
              <RowLines>
                <Code className="text-control [overflow-wrap:anywhere]">
                  {name}
                </Code>
                <Text as="span" variant="meta">
                  {item.omitted === null
                    ? formatBytes(item.bytes, locale)
                    : `${formatBytes(item.bytes, locale)} · ${t("session.outputs.tooLarge")}`}
                </Text>
              </RowLines>
              {item.omitted === null ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <RowAction asChild size="icon-sm">
                      <Link
                        href={`/v1/sessions/${encodeURIComponent(session.id)}/outputs/${encodeURIComponent(item.path)}`}
                        download={name.slice(name.lastIndexOf("/") + 1)}
                        aria-label={t("session.outputs.download", { name })}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                      </Link>
                    </RowAction>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("session.outputs.download", { name })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </RowListItem>
          );
        })}
      </RowList>
    </Section>
  );
}
