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
import { useWerft } from "@werft-ai/react";
import {
  DetailRailSection,
  sessionRepositoriesOf,
} from "@werft-ai/react/components";
import {
  Badge,
  Code,
  CompactList,
  CompactRow,
  DiffStat,
  Link,
  RelativeTime,
  RowAction,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { Download } from "lucide-react";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { OUT_FILES_ID, SessionAchievements } from "./session-achievements.tsx";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

function formatBytes(bytes: number, locale: string): string {
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

function PullRequestRow({ outcome }: { readonly outcome: PullRequestOutcome }) {
  const { t, locale } = useI18n();
  const { additions, deletions, changed_files } = outcome.metadata;
  const ended =
    outcome.state === "merged" && outcome.merged_at !== null
      ? { label: t("session.outcomes.mergedAt"), at: outcome.merged_at }
      : outcome.state === "closed" && outcome.closed_at !== null
        ? { label: t("session.outcomes.closedAt"), at: outcome.closed_at }
        : null;
  return (
    <CompactRow
      trailing={
        additions === null || deletions === null ? null : (
          <DiffStat additions={additions} deletions={deletions} />
        )
      }
    >
      <OutcomeLink
        outcome={outcome}
        number={outcome.external_id ?? ""}
        kind={t("session.outcomes.kind.pullRequest")}
      />
      <Text as="span" variant="meta">
        {t(`session.outcomes.state.${outcome.state}`)}
        {changed_files === null
          ? null
          : ` · ${t("session.outcomes.changedFiles", { count: changed_files })}`}
        {ended === null ? null : (
          <>
            {` · ${ended.label} `}
            <RelativeTime value={ended.at} locale={locale} />
          </>
        )}
        {" · "}
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
    </CompactRow>
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
    <CompactRow
      trailing={
        <Badge variant="gray">{t(`session.outcomes.event.${event}`)}</Badge>
      }
    >
      <OutcomeLink
        outcome={outcome}
        number={String(number)}
        kind={t("session.outcomes.kind.review")}
      />
      <Text as="span" variant="meta" className="truncate">
        {t("session.outcomes.submittedAt")}{" "}
        <RelativeTime value={outcome.created_at} locale={locale} />
        {opened_by_session_id !== null && opened_by_session_id !== session.id
          ? ` · ${t("session.outcomes.otherSessionPullRequest")}`
          : null}
      </Text>
    </CompactRow>
  );
}

/**
 * The changed files, counted per pull request: the API keeps each pull
 * request's lines added and removed and its file count, not a list of files.
 */
function SessionChanges({
  session,
  outcomes,
}: {
  readonly session: SessionDetail;
  readonly outcomes: ReturnType<typeof useSessionOutcomes>;
}) {
  const { t } = useI18n();
  if (!hasRepository(session)) return null;
  if (outcomes.error && !isApiError(outcomes.error, "NOT_FOUND")) {
    return (
      <DetailRailSection title={t("session.info.changes")}>
        <LoadFailure
          error={outcomes.error}
          onRetry={() => void outcomes.refetch()}
        />
      </DetailRailSection>
    );
  }
  const items = outcomes.data?.items ?? [];
  return (
    <DetailRailSection title={t("session.info.changes")}>
      {items.length === 0 ? (
        <Text variant="meta">
          {outcomes.data ? t("session.outcomes.noChanges") : null}
        </Text>
      ) : (
        <CompactList>
          {items.map((outcome) =>
            outcome.type === "github_review" ? (
              <ReviewRow key={outcome.id} outcome={outcome} session={session} />
            ) : (
              <PullRequestRow key={outcome.id} outcome={outcome} />
            ),
          )}
        </CompactList>
      )}
      <SessionAttribution session={session} />
    </DetailRailSection>
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
    <DetailRailSection title={t("session.refusals.title")}>
      <CompactList>
        {items.map((refusal) => (
          <CompactRow key={refusal.receipt_id}>
            <Text as="span">
              {t(`agentGitHub.refusal.${refusal.reason_code}`)}
            </Text>
            <Text as="span" variant="meta">
              {t(`agentGitHub.purpose.${refusal.purpose}`)}
              {" · "}
              <RelativeTime value={refusal.created_at} locale={locale} />
            </Text>
          </CompactRow>
        ))}
      </CompactList>
    </DetailRailSection>
  );
}

/**
 * The session info card's sections from what was the outputs tab: the
 * changed files as pull requests (the API has no per-file diff), reviews,
 * achievements, `out/` files, GitHub refusals, then whom commits name.
 */
export function SessionOutputsPanel({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const outcomes = useSessionOutcomes(session);
  return (
    <>
      <SessionChanges session={session} outcomes={outcomes} />
      <SessionAchievements session={session} />
      <SessionOutputs session={session} />
      <SessionGitHubRefusals session={session} />
    </>
  );
}

/**
 * Whom the session's commits name besides the App. Shown only for a session
 * with a repository; a failed read leaves the line out, as the outputs do not
 * depend on it.
 */
function SessionAttribution({ session }: { readonly session: SessionDetail }) {
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
    return null;
  }
  const items = outputs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <DetailRailSection
      id={OUT_FILES_ID}
      title={t("session.outputs.files")}
      badge={<Badge>{items.length}</Badge>}
    >
      <CompactList>
        {items.map((item) => {
          const name = item.path.replace(/^out\//, "");
          return (
            <CompactRow
              key={item.path}
              title={item.path}
              trailing={
                <>
                  <Text as="span" variant="meta">
                    {item.omitted === null
                      ? formatBytes(item.bytes, locale)
                      : t("session.outputs.tooLarge")}
                  </Text>
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
                </>
              }
            >
              <Code className="truncate text-control">{name}</Code>
            </CompactRow>
          );
        })}
      </CompactList>
    </DetailRailSection>
  );
}
