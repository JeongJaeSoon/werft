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
import type { SessionOutputsSummary } from "@werft-ai/react/blocks";
import { sessionRepositoriesOf } from "@werft-ai/react/components";
import {
  Button,
  Code,
  CompactList,
  CompactRow,
  cn,
  DiffStat,
  Link,
  RelativeTime,
  RowAction,
  Section,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  type LucideIcon,
  MessageSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useKeptFailure } from "../components/kept-failure.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { RowMenu, RowMenuLink } from "../components/row-menu.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  OUT_FILES_ID,
  SessionAchievements,
  useSessionAchievements,
} from "./session-achievements.tsx";

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

const STATE_TONE = {
  open: "text-[var(--werft-tone-success-fg)]",
  merged: "text-[var(--werft-tone-progress-fg)]",
  closed: "text-muted-foreground",
} as const;

/**
 * One pull request or review as the changes card draws it: an icon, the
 * title (cut to one line) with a ⋯ menu, then its number and lines changed.
 * The files themselves are on GitHub; the API keeps only their count.
 */
function ChangeRow({
  outcome,
  icon: Icon,
  iconTone,
  title,
  meta,
  aside,
  note,
}: {
  readonly outcome: SessionOutcome;
  readonly icon: LucideIcon;
  readonly iconTone: string;
  readonly title: string;
  readonly meta: ReactNode;
  readonly aside?: ReactNode;
  readonly note?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className="flex min-w-0 gap-3 py-2">
      <Icon
        className={cn("mt-0.5 size-4 flex-none", iconTone)}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={outcome.url}
            target="_blank"
            rel="noreferrer"
            variant="table"
            className="min-w-0 flex-1 truncate font-medium text-control text-foreground hover:underline"
            title={title}
          >
            {title}
          </Link>
          <RowMenu label={t("session.changes.menu", { name: title })}>
            {(close) => (
              <RowMenuLink
                href={outcome.url}
                newTabLabel={t("github.newTab")}
                onSelect={() => void close()}
              >
                {t("session.changes.openOnGitHub")}
              </RowMenuLink>
            )}
          </RowMenu>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-caption">
          <span className="flex min-w-0 flex-1 items-center gap-2">{meta}</span>
          {aside}
        </div>
        {note ? (
          <Text as="span" variant="meta">
            {note}
          </Text>
        ) : null}
      </div>
    </li>
  );
}

function PullRequestRow({ outcome }: { readonly outcome: PullRequestOutcome }) {
  const { t } = useI18n();
  const { additions, deletions, title } = outcome.metadata;
  const number = outcome.external_id ?? "";
  const icon =
    outcome.state === "merged"
      ? GitMerge
      : outcome.state === "closed"
        ? GitPullRequestClosed
        : GitPullRequest;
  return (
    <ChangeRow
      outcome={outcome}
      icon={icon}
      iconTone={STATE_TONE[outcome.state] ?? "text-muted-foreground"}
      title={title || pullRequestName(outcome, number)}
      meta={
        <>
          <span className="truncate text-muted-foreground">
            {pullRequestName(outcome, number)}
          </span>
          {additions === null || deletions === null ? null : (
            <DiffStat additions={additions} deletions={deletions} />
          )}
        </>
      }
      aside={
        <span className="flex-none text-muted-foreground">
          {t(`session.outcomes.state.${outcome.state}`)}
        </span>
      }
      note={
        outcome.check_error === null
          ? null
          : t(`session.outcomes.checkError.${outcome.check_error}`)
      }
    />
  );
}

function ReviewRow({
  outcome,
  session,
}: {
  readonly outcome: ReviewOutcome;
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { number, event, opened_by_session_id } = outcome.metadata;
  const name = pullRequestName(outcome, String(number));
  return (
    <ChangeRow
      outcome={outcome}
      icon={MessageSquare}
      iconTone="text-muted-foreground"
      title={`${name} ${t("session.outcomes.kind.review")}`}
      meta={
        <span className="truncate text-muted-foreground">
          {t(`session.outcomes.event.${event}`)}
          {opened_by_session_id !== null && opened_by_session_id !== session.id
            ? ` · ${t("session.outcomes.otherSessionPullRequest")}`
            : null}
        </span>
      }
    />
  );
}

/**
 * The session's changes, one row per pull request or review, in a card the
 * reader can fold. The API counts a pull request's files and lines but does
 * not list the files, so none are listed here.
 */
function SessionChanges({
  session,
  outcomes,
}: {
  readonly session: SessionDetail;
  readonly outcomes: ReturnType<typeof useSessionOutcomes>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const error = useKeptFailure(outcomes, session.id);
  if (!hasRepository(session)) return null;
  const failed = error && !isApiError(error, "NOT_FOUND");
  const items = outcomes.data?.items ?? [];
  return (
    <Section
      className="min-w-0"
      title={t("session.changes.title")}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // Taller than the title; kept from pushing the head line down.
          className="-my-1"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={
            open ? t("session.changes.fold") : t("session.changes.unfold")
          }
          onClick={() => setOpen(!open)}
        >
          <ChevronDown
            className={cn(
              "transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Button>
      }
    >
      <div id={bodyId} hidden={!open} className="flex min-w-0 flex-col gap-1">
        {failed ? (
          <LoadFailure error={error} onRetry={() => void outcomes.refetch()} />
        ) : items.length === 0 ? (
          <Text variant="meta">
            {outcomes.data ? t("session.outcomes.noChanges") : null}
          </Text>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((outcome) =>
              outcome.type === "github_review" ? (
                <ReviewRow
                  key={outcome.id}
                  outcome={outcome}
                  session={session}
                />
              ) : (
                <PullRequestRow key={outcome.id} outcome={outcome} />
              ),
            )}
          </ul>
        )}
        <SessionAttribution session={session} />
      </div>
    </Section>
  );
}

function useSessionGitHubRefusals(session: SessionDetail) {
  const { client } = useWerft();
  return useQuery({
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
}

/** The session's latest GitHub gate refusals: why, for what, and when. */
function SessionGitHubRefusals({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t, locale } = useI18n();
  const refusals = useSessionGitHubRefusals(session);
  const error = useKeptFailure(refusals, `refusals:${session.id}`);
  const items = refusals.data?.items ?? [];
  if (!hasRepository(session)) return null;
  // A list never read is not an empty one. A later read that fails keeps
  // the refusals already shown; a session gone from view is the detail
  // screen's to report.
  if (error && !refusals.data && !isApiError(error, "NOT_FOUND")) {
    return (
      <Section className="min-w-0" title={t("session.refusals.title")}>
        <LoadFailure error={error} onRetry={() => void refusals.refetch()} />
      </Section>
    );
  }
  if (items.length === 0) return null;
  return (
    <Section className="min-w-0" title={t("session.refusals.title")}>
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
    </Section>
  );
}

/** A list's length: 0 when it is not read for this session, unknown until it answers. */
function listed(query: {
  readonly data?: { readonly items: readonly unknown[] } | undefined;
  readonly isPending: boolean;
  readonly fetchStatus: string;
}): number | undefined {
  if (query.data) return query.data.items.length;
  return query.isPending && query.fetchStatus === "idle" ? 0 : undefined;
}

/**
 * The outputs tab: the changed files as pull requests (the API has no
 * per-file diff), reviews, achievements, `out/` files, GitHub refusals, then
 * whom commits name. Reports what the tab's count shows.
 */
export function SessionOutputsPanel({
  session,
  onSummary,
}: {
  readonly session: SessionDetail;
  readonly onSummary?: (summary: SessionOutputsSummary) => void;
}) {
  const { t } = useI18n();
  const outcomes = useSessionOutcomes(session);
  const achievements = useSessionAchievements(session);
  const outputs = useSessionOutputs(session);
  const refusals = useSessionGitHubRefusals(session);
  // Every list the tab shows, refusals too: a refused push often leaves
  // nothing else, and a red 0 is no badge at all.
  const lengths = [outcomes, achievements, outputs, refusals].map(listed);
  const count = lengths.includes(undefined)
    ? undefined
    : lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0);
  const refused = (refusals.data?.items.length ?? 0) > 0;
  useEffect(() => onSummary?.({ count, refused }), [onSummary, count, refused]);
  // Only once every list answered empty: a slow or failed one is not "none".
  const empty =
    !hasRepository(session) &&
    achievements.data?.items.length === 0 &&
    !achievements.data.judgment &&
    (session.checkpoint_revision === null || outputs.data?.items.length === 0);
  return (
    <>
      <SessionChanges session={session} outcomes={outcomes} />
      <SessionAchievements session={session} />
      <SessionOutputs session={session} />
      <SessionGitHubRefusals session={session} />
      {empty ? <Text variant="meta">{t("session.outputs.empty")}</Text> : null}
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
  const error = useKeptFailure(outputs, session.id);

  // A session gone from view is the detail screen's to report.
  if (error && !isApiError(error, "NOT_FOUND")) {
    return <LoadFailure error={error} onRetry={() => void outputs.refetch()} />;
  }
  if (outputs.isPending && session.checkpoint_revision !== null) {
    return null;
  }
  const items = outputs.data?.items ?? [];
  if (items.length === 0) return null;
  const summary = t("session.outputs.count", { count: items.length });
  // One line that opens to the files, each with its download.
  return (
    <section id={OUT_FILES_ID} aria-label={summary} className="min-w-0">
      <details className="group/files min-w-0">
        <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-control py-1 text-control [&::-webkit-details-marker]:hidden">
          <FileText
            className="size-4 flex-none text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="truncate">{summary}</span>
          <ChevronRight
            className="size-4 flex-none text-muted-foreground transition-transform group-open/files:rotate-90 motion-reduce:transition-none"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </summary>
        <CompactList className="mt-2 pl-6">
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
                              aria-label={t("session.outputs.download", {
                                name,
                              })}
                            >
                              <Download
                                className="size-3.5"
                                aria-hidden="true"
                              />
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
      </details>
    </section>
  );
}
