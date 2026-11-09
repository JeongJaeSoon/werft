import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubLinkCallbackResponse,
  LinkedAccount,
  SlackLinkCallbackResponse,
  StartGitHubLinkResponse,
  StartSlackLinkResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  ConfirmDialog,
  cn,
  formatTimestamp,
  Heading,
  Page,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { linkedAccountsQuery, queryKeysOf } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { FormError } from "../components/auth-page.tsx";
import {
  GitHubMark,
  GoogleDriveMark,
  SlackMark,
} from "../components/brand-marks.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";
import {
  githubSettingsQuery,
  userLinkReady,
} from "./workspace-github-user-link.tsx";

// One row per service (console v35): 64px tall, its button as wide as a row action.
const SERVICE_ROW =
  "flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]";
// Lines under a service start where its name does: inset, mark, gap.
const SERVICE_INDENT =
  "pl-[calc(var(--werft-row-padding-x)+var(--werft-size-tile-two-line)+0.75rem)]";
const SERVICE_DETAIL = cn(
  SERVICE_INDENT,
  "border-t pr-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]",
);

// Refusals whose server message is the product copy written for the person
// linking (contracts LINK_MESSAGES); the page shows those words unchanged.
const LINK_COPY_CODES = new Set([
  "BAD_REQUEST",
  "SLACK_NOT_INSTALLED",
  "LINK_TEAM_MISMATCH",
  "LINK_TAKEN",
  "LINK_EXISTS",
  "GITHUB_LINK_NOT_CONFIGURED",
]);

function linkRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  if (LINK_COPY_CODES.has(error.code)) return error.message;
  // Slack briefly out of reach is worth another try; linking not set up on
  // this installation never is.
  if (error.code === "BACKEND_UNAVAILABLE" && !error.retryable)
    return t("linked.unavailable");
  if (error.code === "FORBIDDEN")
    return refusalText(t, error, "account.link", role);
  return t(errorKey(error.code));
}

/** The caller's accounts on other services; v1 links Slack only. */
export function LinkedAccountsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const { leave } = useAppServices();
  const role = useRole();
  const accounts = useQuery(linkedAccountsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState<LinkedAccount | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The account whose row holds focus, until focus or a press goes elsewhere.
  // Its row leaving takes focus with it, which fires neither event.
  const focusedRow = useRef<string | null>(null);
  const shownIds = useRef<readonly string[]>([]);
  // Same for the link button, which goes when a link shows up (another tab).
  const startRef = useRef<HTMLButtonElement>(null);
  const focusedStart = useRef(false);

  const live =
    accounts.data?.items.filter(
      (account) => account.status !== "revoked" && account.provider === "slack",
    ) ?? [];
  const githubLive =
    accounts.data?.items.filter(
      (account) =>
        account.status !== "revoked" && account.provider === "github",
    ) ?? [];

  useEffect(() => {
    const track = (event: Event) => {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("li[data-account]")
          : null;
      focusedRow.current =
        row && listRef.current?.contains(row)
          ? (row.dataset.account ?? null)
          : null;
      focusedStart.current =
        startRef.current !== null && event.target === startRef.current;
    };
    const stop = new AbortController();
    for (const type of ["focusin", "pointerdown"]) {
      document.addEventListener(type, track, {
        capture: true,
        signal: stop.signal,
      });
    }
    return () => stop.abort();
  }, []);

  // Focus that fell to the page with its row goes to the nearest row left
  // below it, else above it, else the heading of the emptied list.
  useLayoutEffect(() => {
    // Rows as drawn: a failed reread keeps the data but draws no list.
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("li[data-account]") ??
        []),
    ];
    const ids = rows.map((row) => row.dataset.account ?? "");
    const before = shownIds.current;
    shownIds.current = ids;
    if (focusedStart.current && !startRef.current) {
      focusedStart.current = false;
      if (document.activeElement === document.body) {
        (rows[0]?.querySelector("button") ?? headingRef.current)?.focus();
      }
      return;
    }
    const gone = focusedRow.current;
    if (!gone || ids.includes(gone)) return;
    focusedRow.current = null;
    if (document.activeElement !== document.body) return;
    const at = before.indexOf(gone);
    const next = [
      ...before.slice(at + 1),
      ...before.slice(0, Math.max(at, 0)).reverse(),
    ].find((id) => ids.includes(id));
    (next
      ? rows[ids.indexOf(next)]?.querySelector("button")
      : headingRef.current
    )?.focus();
  });

  const start = useMutation<StartSlackLinkResponse, ApiError>({
    mutationFn: () => unwrap(client.POST("/v1/linked-accounts/slack/start")),
    onMutate: () => setOutcome(null),
    onSuccess: ({ authorize_url }) => leave(authorize_url),
    onError: (error) =>
      setOutcome({ kind: "error", text: linkRefusal(t, error, role) }),
  });

  const unlink = useMutation<unknown, ApiError, LinkedAccount>({
    mutationFn: (account) =>
      unwrap(
        client.DELETE("/v1/linked-accounts/{id}", {
          params: { path: { id: account.id } },
        }),
      ),
    onMutate: () => setOutcome(null),
    onSuccess: async (_, account) => {
      setOutcome({
        kind: "notice",
        text: t(
          account.provider === "github"
            ? "linked.github.unlinked"
            : "linked.unlinked",
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).linkedAccounts,
      });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: linkRefusal(t, error, role) }),
  });

  // The dialog closes before the answer, unlike other confirmations: focus
  // goes back to the row's button first, which waits (aria-disabled) and
  // hands focus on when its row leaves, so several unlinks can overlap.
  // Restored here rather than by the dialog, whose return can come after a
  // fast answer has already taken the row away.
  const [confirmed, setConfirmed] = useState<LinkedAccount | null>(null);
  const { mutate } = unlink;
  useEffect(() => {
    if (confirmed === null || confirming !== null) return;
    setConfirmed(null);
    listRef.current
      ?.querySelector<HTMLElement>(`li[data-account="${confirmed.id}"] button`)
      ?.focus();
    mutate(confirmed);
  }, [confirmed, confirming, mutate]);

  return (
    <Page title={t("linked.title")} description={t("linked.intro")}>
      <OutcomeLine outcome={outcome} live />
      <RowList ref={listRef} variant="joined" framed={false}>
        <GitHubService
          accounts={accounts.isSuccess ? githubLive : undefined}
          unlinking={unlink.isPending ? unlink.variables?.id : undefined}
          onUnlink={setConfirming}
          onOutcome={setOutcome}
        />
        <li>
          <div className={SERVICE_ROW}>
            <ServiceMark>
              <SlackMark />
            </ServiceMark>
            <RowLines>
              <span className="flex flex-wrap items-center gap-2">
                <Heading
                  ref={headingRef}
                  tabIndex={-1}
                  className="outline-none"
                >
                  {t("linked.slack")}
                </Heading>
                {accounts.isSuccess ? (
                  <Badge variant={live.length > 0 ? "green" : "gray"}>
                    {t(
                      live.length > 0 ? "linked.connected" : "linked.notLinked",
                    )}
                  </Badge>
                ) : null}
              </span>
              <Text
                as="span"
                variant="meta"
                className="block [overflow-wrap:anywhere]"
              >
                {t("linked.use.slack")}
              </Text>
            </RowLines>
            {/* Linked rows offer only unlinking; linking again starts from
                there. */}
            {accounts.isSuccess && live.length === 0 ? (
              <RowAction
                ref={startRef}
                className="ml-auto"
                aria-label={start.isPending ? undefined : t("linked.connect")}
                // Not held after success: back from Slack (bfcache) must be
                // able to start again.
                disabled={start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? t("linked.starting") : t("linked.link")}
              </RowAction>
            ) : null}
          </div>
          {accounts.isPending ? (
            <div className={SERVICE_DETAIL}>
              <StatusScreen kind="loading" />
            </div>
          ) : accounts.error ? (
            <div className={SERVICE_DETAIL}>
              {isApiError(accounts.error, "FORBIDDEN") ? (
                <FormError>{linkRefusal(t, accounts.error, role)}</FormError>
              ) : (
                <LoadFailure
                  error={accounts.error}
                  onRetry={() => void accounts.refetch()}
                />
              )}
            </div>
          ) : (
            <SlackAccounts
              accounts={live}
              unlinking={unlink.isPending ? unlink.variables?.id : undefined}
              onUnlink={setConfirming}
            />
          )}
        </li>
        <SoonService
          mark={<GoogleDriveMark />}
          name="Google Workspace"
          use={t("linked.use.google")}
        />
      </RowList>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t(
          confirming?.provider === "github"
            ? "linked.github.unlinkTitle"
            : "linked.unlinkTitle",
        )}
        consequence={t(
          confirming?.provider === "github"
            ? "linked.github.unlinkHint"
            : "linked.unlinkHint",
        )}
        target={confirming ? accountName(confirming, t) : undefined}
        confirmLabel={t("linked.unlink")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        onConfirm={() => {
          if (!confirming) return;
          setConfirmed(confirming);
          setConfirming(null);
        }}
      />
    </Page>
  );
}

/** The account as its row names it, in one line. */
function accountName(account: LinkedAccount, t: Translate): string {
  if (account.provider === "github")
    return account.external_user_name ?? account.external_user_id;
  const ids = { user: account.external_user_id, team: account.external_tenant };
  return account.external_user_name === null &&
    account.external_tenant_name === null
    ? t("linked.slackAccount", ids)
    : t("linked.slackNamed", {
        user: account.external_user_name ?? ids.user,
        team: account.external_tenant_name ?? ids.team,
      });
}

function ServiceMark({ children }: { readonly children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-(--werft-size-tile-two-line) shrink-0 place-items-center self-start rounded-control bg-muted font-semibold text-caption text-muted-foreground"
    >
      {children}
    </span>
  );
}

// GitHub's address for the account whatever its email settings; the same
// rule the server applies (contracts githubNoreplyEmail).
const noreplyOf = (account: LinkedAccount) =>
  `${account.external_user_id}+${account.external_user_name ?? ""}@users.noreply.github.com`;

/**
 * GitHub, linked through the workspace's author App: the commits of sessions
 * the person starts name them as co-author. Until an owner or admin finishes
 * user linking in Integrations › GitHub, the row says so and offers nothing.
 */
function GitHubService({
  accounts,
  unlinking,
  onUnlink,
  onOutcome,
}: {
  /** Undefined until the list has loaded; its failure shows under Slack. */
  readonly accounts: readonly LinkedAccount[] | undefined;
  readonly unlinking: string | undefined;
  readonly onUnlink: (account: LinkedAccount) => void;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const { leave } = useAppServices();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const settings = useQuery(githubSettingsQuery(client, workspaceId));
  // A failed read leaves the button: the start answers why it cannot.
  const unset = settings.isSuccess && !userLinkReady(settings.data);
  const start = useMutation<StartGitHubLinkResponse, ApiError>({
    mutationFn: () => unwrap(client.POST("/v1/linked-accounts/github/start")),
    onMutate: () => onOutcome(null),
    onSuccess: ({ authorize_url }) => leave(authorize_url),
    onError: (error) =>
      onOutcome({ kind: "error", text: linkRefusal(t, error, role) }),
  });
  const linked = accounts !== undefined && accounts.length > 0;
  return (
    <li>
      <div className={SERVICE_ROW}>
        <ServiceMark>
          <GitHubMark />
        </ServiceMark>
        <RowLines>
          <span className="flex flex-wrap items-center gap-2">
            <Heading>GitHub</Heading>
            {accounts !== undefined ? (
              <Badge variant={linked ? "green" : "gray"}>
                {t(linked ? "linked.connected" : "linked.notLinked")}
              </Badge>
            ) : null}
          </span>
          <Text
            as="span"
            variant="meta"
            className="block [overflow-wrap:anywhere]"
          >
            {unset && !linked
              ? t("linked.github.unset")
              : t("linked.use.github")}
          </Text>
        </RowLines>
        {accounts !== undefined && !linked ? (
          <RowAction
            className="ml-auto"
            aria-label={
              start.isPending || unset ? undefined : t("linked.github.connect")
            }
            disabled={start.isPending || unset}
            onClick={() => start.mutate()}
          >
            {start.isPending ? t("linked.github.starting") : t("linked.link")}
          </RowAction>
        ) : null}
      </div>
      {linked ? (
        <RowList variant="joined" framed={false} className="border-t">
          {accounts.map((account) => (
            <RowListItem
              key={account.id}
              data-account={account.id}
              className={cn(
                SERVICE_INDENT,
                "flex-col items-start sm:flex-row sm:items-center",
              )}
            >
              <RowLines>
                <Text as="span" weight="medium" className="block break-words">
                  {account.external_user_name ?? account.external_user_id}
                </Text>
                {account.external_user_name ? (
                  <Text
                    as="span"
                    variant="meta"
                    className="block [overflow-wrap:anywhere]"
                  >
                    {t("linked.github.coAuthor", {
                      line: `${account.external_user_name} <${noreplyOf(account)}>`,
                    })}
                  </Text>
                ) : null}
                <Text
                  as="span"
                  variant="meta"
                  className="block [overflow-wrap:anywhere]"
                >
                  {t("linked.verified", {
                    at: formatTimestamp(account.verified_at, locale),
                  })}
                </Text>
              </RowLines>
              <RowAction
                variant="danger"
                aria-disabled={unlinking === account.id || undefined}
                onClick={() => {
                  if (unlinking !== account.id) onUnlink(account);
                }}
              >
                {t("linked.unlink")}
              </RowAction>
            </RowListItem>
          ))}
        </RowList>
      ) : null}
    </li>
  );
}

/**
 * A service the console names but cannot link yet: no API behind it, so the
 * row says so and offers nothing to press.
 */
function SoonService({
  mark,
  name,
  use,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly use: string;
}) {
  const { t } = useI18n();
  return (
    <li data-soon="true" className={SERVICE_ROW}>
      <ServiceMark>{mark}</ServiceMark>
      <RowLines>
        <span className="flex flex-wrap items-center gap-2">
          <Heading>{name}</Heading>
          <Badge variant="gray">{t("linked.soon")}</Badge>
        </span>
        <Text
          as="span"
          variant="meta"
          className="block [overflow-wrap:anywhere]"
        >
          {use}
        </Text>
      </RowLines>
    </li>
  );
}

function SlackAccounts({
  accounts,
  unlinking,
  onUnlink,
}: {
  readonly accounts: readonly LinkedAccount[];
  readonly unlinking: string | undefined;
  readonly onUnlink: (account: LinkedAccount) => void;
}) {
  const { t, locale } = useI18n();
  // Nothing linked reads from the row's badge; no second empty line.
  if (accounts.length === 0) return null;
  return (
    <RowList variant="joined" framed={false} className="border-t">
      {accounts.map((account) => (
        <RowListItem
          key={account.id}
          data-account={account.id}
          className={cn(
            SERVICE_INDENT,
            "flex-col items-start sm:flex-row sm:items-center",
          )}
        >
          <RowLines>
            <SlackAccountName account={account} />
            {account.status === "stale" ? (
              // A status line keeps its own colour (B-24).
              <span className="block text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {t("linked.stale")}
              </span>
            ) : (
              <Text
                as="span"
                variant="meta"
                className="block [overflow-wrap:anywhere]"
              >
                {t("linked.verified", {
                  at: formatTimestamp(account.verified_at, locale),
                })}
              </Text>
            )}
          </RowLines>
          <RowAction
            variant="danger"
            // Not `disabled` while it runs: Chrome takes focus off a disabled
            // button, and a refused unlink would leave the keyboard lost.
            aria-disabled={unlinking === account.id || undefined}
            onClick={() => {
              if (unlinking !== account.id) onUnlink(account);
            }}
          >
            {t("linked.unlink")}
          </RowAction>
        </RowListItem>
      ))}
    </RowList>
  );
}

/**
 * Names when Slack gave any, with the ids under them; a link made before
 * names were kept shows its ids alone. A missing name falls back to its id.
 */
function SlackAccountName({ account }: { readonly account: LinkedAccount }) {
  const { t } = useI18n();
  const ids = {
    user: account.external_user_id,
    team: account.external_tenant,
  };
  if (
    account.external_user_name === null &&
    account.external_tenant_name === null
  ) {
    return (
      <Text as="span" weight="medium" className="block break-words">
        {t("linked.slackAccount", ids)}
      </Text>
    );
  }
  return (
    <>
      <Text as="span" weight="medium" className="block break-words">
        {t("linked.slackNamed", {
          user: account.external_user_name ?? ids.user,
          team: account.external_tenant_name ?? ids.team,
        })}
      </Text>
      <Text as="span" variant="meta" className="block [overflow-wrap:anywhere]">
        {t("linked.slackIds", ids)}
      </Text>
    </>
  );
}

export interface SlackLinkSearch {
  readonly code?: string;
  readonly state?: string;
}

export function slackLinkSearch(
  search: Record<string, unknown>,
): SlackLinkSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const code = pick(search.code);
  const state = pick(search.state);
  return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
}

/**
 * Where Slack sends the browser back (SLACK_OIDC_REDIRECT_URI). It sits
 * behind the login, so someone whose session ended signs in and lands here
 * again with the same code.
 */
export function SlackLinkCallbackScreen() {
  const search = useSearch({ from: "/authed/settings/linked-accounts/slack" });
  return <LinkCallback provider="slack" {...search} />;
}

/** Where GitHub sends the browser back: `<console>/settings/linked-accounts/github`. */
export function GitHubLinkCallbackScreen() {
  const search = useSearch({ from: "/authed/settings/linked-accounts/github" });
  return <LinkCallback provider="github" {...search} />;
}

function LinkCallback({
  provider,
  code,
  state,
}: SlackLinkSearch & { readonly provider: "slack" | "github" }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const role = useRole();
  const sent = useRef(false);

  const finish = useMutation<
    SlackLinkCallbackResponse | GitHubLinkCallbackResponse,
    ApiError
  >({
    mutationFn: () =>
      unwrap(
        client.POST(
          provider === "github"
            ? "/v1/linked-accounts/github/callback"
            : "/v1/linked-accounts/slack/callback",
          { body: { code: code ?? "", state: state ?? "" } },
        ),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).linkedAccounts,
      });
      await navigate({ to: "/settings/linked-accounts", replace: true });
    },
  });

  // Each code and state are good for one exchange.
  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    finish.mutate();
  }, [code, state, finish]);

  const failure =
    !code || !state
      ? t(
          provider === "github"
            ? "linked.github.cancelled"
            : "linked.cancelled",
        )
      : finish.error
        ? linkRefusal(t, finish.error, role)
        : null;
  return (
    <Page title={t("linked.title")}>
      {failure ? (
        <div className="flex flex-col gap-[var(--werft-space-block)]">
          <FormError>{failure}</FormError>
          <p className="m-0">
            <TextLink asChild underline="always">
              <Link to="/settings/linked-accounts">{t("linked.back")}</Link>
            </TextLink>
          </p>
        </div>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </Page>
  );
}
