import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  ListPushRequestsResponse,
  PushIntent,
  PushRequest,
  SessionDetail,
} from "@werft-ai/contracts";
import { queryKeysOf, sessionGithubWorkQuery } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { sessionRepositoriesOf } from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Code,
  Link,
  RelativeTime,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Text,
} from "@werft-ai/ui";
import { useState } from "react";
import { LoadFailure } from "../components/load-failure.tsx";
import {
  errorKey,
  isMessageKey,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";

const REQUEST_BADGE = {
  requested: "blue",
  approved: "blue",
  pushing: "blue",
  pushed: "green",
  rejected: "gray",
  failed: "red",
} as const;

const PR_BADGE = {
  due: "blue",
  opening: "blue",
  opened: "green",
  closed_unrecorded: "gray",
  uncertain: "amber",
  failed: "red",
  cancelled: "gray",
} as const;

// The link comes from the forge's answer: only an https address is shown as
// one.
const isHttpsUrl = (url: string | null): url is string =>
  typeof url === "string" && url.startsWith("https://");

const prErrorKey = (code: string | null): MessageKey | null =>
  code !== null && isMessageKey(`session.github.prError.${code}`)
    ? (`session.github.prError.${code}` as MessageKey)
    : null;

type Row =
  | { kind: "request"; at: string; request: PushRequest }
  | { kind: "intent"; at: string; intent: PushIntent };

/**
 * Rows of the list: every push request, plus the intents that have no
 * request (still waiting, or ended without one). A `requested` intent is its
 * request's row already.
 */
function rowsOf(data: ListPushRequestsResponse): Row[] {
  const rows: Row[] = [
    ...data.items.map(
      (request): Row => ({
        kind: "request",
        at: request.requested_at,
        request,
      }),
    ),
    ...(data.intents ?? [])
      .filter((intent) => intent.status !== "requested")
      .map(
        (intent): Row => ({ kind: "intent", at: intent.created_at, intent }),
      ),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * A session branch is `agent/<session uuid>`; the full uuid says nothing the
 * first block does not, so the name is cut there and the whole one is the
 * hover title.
 */
export function shortBranch(branch: string): string {
  return branch.replace(/^(agent\/[0-9a-f]{8})[0-9a-f-]{20,}$/i, "$1…");
}

type Names = ReadonlyMap<string, string | null>;

function Target({
  repositoryId,
  names,
  branch,
}: {
  readonly repositoryId: string;
  readonly names: Names;
  readonly branch: string;
}) {
  return (
    <Code className="[overflow-wrap:anywhere]" title={branch}>
      {names.get(repositoryId) ?? repositoryId} ← {shortBranch(branch)}
    </Code>
  );
}

const rowOf = (row: Row) => (row.kind === "request" ? row.request : row.intent);

/**
 * Rows by repository and branch, newest group first, each newest first. The
 * key names the branch, not its rows: a poll that adds a push must not
 * remount the group and fold what the reader opened.
 */
function groupsOf(rows: Row[]): [key: string, rows: Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const { repository_id, target_branch } = rowOf(row);
    const key = `${repository_id}\n${target_branch}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups];
}

function BranchGroup({
  rows,
  names,
  sessionId,
}: {
  readonly rows: Row[];
  readonly names: Names;
  readonly sessionId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [latest, ...earlier] = rows;
  const render = (row: Row) =>
    row.kind === "request" ? (
      <RequestRow
        key={row.request.id}
        request={row.request}
        names={names}
        sessionId={sessionId}
      />
    ) : (
      <IntentRow key={row.intent.id} intent={row.intent} names={names} />
    );
  return (
    <>
      {latest === undefined ? null : render(latest)}
      {earlier.length === 0 ? null : (
        <RowListItem>
          <RowAction
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open
              ? t("session.github.hideEarlier")
              : t("session.github.showEarlier", { count: earlier.length })}
          </RowAction>
        </RowListItem>
      )}
      {open ? earlier.map(render) : null}
    </>
  );
}

// A moved checkpoint does not heal by waiting: the request stays open and
// only a new one carries the newer commit.
const decisionErrorKey = (code: string): MessageKey =>
  code === "CHECKPOINT_MOVED"
    ? "session.github.error.moved"
    : code === "PUSH_REQUEST_RESOLVED"
      ? "session.github.error.resolved"
      : errorKey(code);

/**
 * Approves or rejects a waiting push on the session. The approval names the
 * commit the reader saw, so a request that moved since is refused by the
 * server instead of pushing something else.
 */
function Decision({
  request,
  sessionId,
}: {
  readonly request: PushRequest;
  readonly sessionId: string;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const decide = useMutation<PushRequest, ApiError, "approve" | "reject">({
    mutationFn: (action) =>
      unwrap(
        client.POST(
          action === "approve"
            ? "/v1/sessions/{id}/push-requests/{push_request_id}/approve"
            : "/v1/sessions/{id}/push-requests/{push_request_id}/reject",
          {
            params: {
              path: { id: sessionId, push_request_id: request.id },
              header: { "Idempotency-Key": crypto.randomUUID() },
            },
            body: { git_commit: request.git_commit },
          },
        ),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).sessionGithubWork(sessionId),
      }),
  });
  // Like Slack's reject-only card: a push that cannot be approved can still be rejected.
  const unapprovable =
    request.approvability?.approvable === false
      ? request.approvability.reason
      : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={decide.isPending || unapprovable !== null}
        onClick={() => decide.mutate("approve")}
      >
        {t("session.github.approve")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={decide.isPending}
        onClick={() => decide.mutate("reject")}
      >
        {t("session.github.reject")}
      </Button>
      <Code title={request.git_commit}>{request.git_commit.slice(0, 7)}</Code>
      {unapprovable === null ? null : (
        <Text as="span" variant="meta">
          {t(unapprovable.key)}
        </Text>
      )}
      {decide.error ? (
        <Text as="span" variant="meta" role="alert">
          {t(decisionErrorKey(decide.error.code))}
        </Text>
      ) : null}
    </div>
  );
}

function RequestRow({
  request,
  names,
  sessionId,
}: {
  readonly request: PushRequest;
  readonly names: Names;
  readonly sessionId: string;
}) {
  const { t, locale } = useI18n();
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 flex-wrap items-center gap-2">
          <Target
            repositoryId={request.repository_id}
            names={names}
            branch={request.target_branch}
          />
          <Badge variant={REQUEST_BADGE[request.state]}>
            {t(`session.github.state.${request.state}`)}
          </Badge>
          {!request.pr_state ? null : (
            <Badge variant={PR_BADGE[request.pr_state]}>
              {t(`session.github.prState.${request.pr_state}`)}
            </Badge>
          )}
          {request.pr_number !== null && isHttpsUrl(request.pr_url) ? (
            <Link
              href={request.pr_url}
              target="_blank"
              rel="noreferrer"
              variant="table"
            >
              {t("session.github.prNumber", { number: request.pr_number })}
            </Link>
          ) : null}
        </Text>
        {request.state === "failed" ? (
          <Text as="span" variant="meta" role="alert">
            {t("session.github.pushFailed")}
          </Text>
        ) : null}
        <Text as="span" variant="meta">
          {prErrorKey(request.pr_error) === null
            ? null
            : `${t(prErrorKey(request.pr_error) as MessageKey)} · `}
          <RelativeTime value={request.requested_at} locale={locale} />
        </Text>
        {request.state === "requested" ? (
          <Decision request={request} sessionId={sessionId} />
        ) : null}
      </RowLines>
    </RowListItem>
  );
}

function IntentRow({
  intent,
  names,
}: {
  readonly intent: PushIntent;
  readonly names: Names;
}) {
  const { t, locale } = useI18n();
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 flex-wrap items-center gap-2">
          <Target
            repositoryId={intent.repository_id}
            names={names}
            branch={intent.target_branch}
          />
          <Badge variant={intent.status === "failed" ? "red" : "gray"}>
            {t(`session.github.intent.${intent.status}`)}
          </Badge>
        </Text>
        <Text as="span" variant="meta">
          {intent.refusal_code === null
            ? null
            : `${t(`session.github.reason.${intent.refusal_code}`)} · `}
          <RelativeTime value={intent.created_at} locale={locale} />
        </Text>
      </RowLines>
    </RowListItem>
  );
}

/**
 * The session's GitHub work: its push requests with their pull request
 * stage, and the pushes a turn asked for that have no request yet or ended
 * without one, each with why.
 */
export function SessionGitHubWork({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  // A session may hold only attached repositories, with none of its own.
  const repositories = sessionRepositoriesOf(session);
  const work = useQuery(
    sessionGithubWorkQuery(client, session.id, {
      enabled: repositories.length > 0,
    }),
  );
  if (work.error && !isApiError(work.error, "NOT_FOUND")) {
    return (
      <LoadFailure error={work.error} onRetry={() => void work.refetch()} />
    );
  }
  const rows = work.data === undefined ? [] : rowsOf(work.data);
  if (repositories.length === 0 || rows.length === 0) return null;
  const names: Names = new Map(
    repositories.flatMap((repository) =>
      repository.id === null ? [] : [[repository.id, repository.name] as const],
    ),
  );
  return (
    <Section
      title={t("session.github.title")}
      description={t("session.github.description")}
    >
      <RowList variant="joined">
        {groupsOf(rows).map(([key, group]) => (
          <BranchGroup
            key={key}
            rows={group}
            names={names}
            sessionId={session.id}
          />
        ))}
      </RowList>
    </Section>
  );
}
