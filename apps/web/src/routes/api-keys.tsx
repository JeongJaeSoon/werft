import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  ApiKeyView,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  RevokeApiKeyResponse,
  SessionScope,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  type BadgeProps,
  buttonVariants,
  CardFooter,
  Checkbox,
  Code,
  Combobox,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  Heading,
  Input,
  LinkTab,
  LinkTabs,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RowAction,
  RowList,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { CircleAlert, Clock, InfinityIcon, Plus } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  administeredAgentsQuery,
  agentPagesQuery,
  agentSummariesQuery,
  apiKeysQuery,
  queryKeysOf,
} from "../api/queries.ts";
import {
  type ManagedPermission,
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { API_KEY_NAME_MAX } from "../auth/limits.ts";
import { ReasonButton } from "../auth/reason-button.tsx";
import { FormError } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { SEARCH_MAX, SEARCH_SETTLE_MS } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";

const ICON = "size-3.5 shrink-0";
// v4 `.key-copy` (Console.dc.html L445): 24px, pulled into the meta gaps.
const KEY_COPY = "-my-1 -mr-1 -ml-1.5 h-6 min-w-6 gap-1 px-1 text-xs";

type IssueRequest = Pick<CreateApiKeyRequest, "kind" | "scopes"> & {
  name?: string;
  agent_id?: string;
  expires_at?: string;
};

const SCOPE_NAME: Record<SessionScope, MessageKey> = {
  "sessions:read": "apiKeys.scope.read",
  "sessions:write": "apiKeys.scope.write",
  "sessions:approve": "apiKeys.scope.approve",
  "sessions:control": "apiKeys.scope.control",
  "sessions:recover": "apiKeys.scope.recover",
};

// What the server lets each scope do (ACTION_SCOPES in packages/platform).
const SCOPE_HINT: Record<SessionScope, MessageKey> = {
  "sessions:read": "apiKeys.scopeHint.read",
  "sessions:write": "apiKeys.scopeHint.write",
  "sessions:approve": "apiKeys.scopeHint.approve",
  "sessions:control": "apiKeys.scopeHint.control",
  "sessions:recover": "apiKeys.scopeHint.recover",
};

type KeyKind = ApiKeyView["kind"];

const KIND_NAME: Record<KeyKind, MessageKey> = {
  personal: "apiKeys.kind.personal",
  agent: "apiKeys.kind.agent",
};

// A kind is not a state, so no state tone; the badge's words tell them apart.
const KIND_BADGE: Record<KeyKind, BadgeProps["variant"]> = {
  personal: "gray",
  agent: "blue",
};

// Who it acts as, what its issuer leaving does, which sessions it reaches,
// and whether it can approve: auth.ts apiKeyPrincipal, queries.ts
// liveApiKey, policy.ts viewerOf and agent_ceiling, api-key-service.ts.
const KIND_FACTS: Record<KeyKind, readonly MessageKey[]> = {
  personal: [
    "apiKeys.guide.personal.actsAs",
    "apiKeys.guide.personal.issuerLeaves",
    "apiKeys.guide.personal.sessions",
    "apiKeys.guide.personal.approve",
  ],
  agent: [
    "apiKeys.guide.agent.actsAs",
    "apiKeys.guide.agent.issuerLeaves",
    "apiKeys.guide.agent.sessions",
    "apiKeys.guide.agent.startSession",
    "apiKeys.guide.agent.approve",
  ],
};

/** Each tab of keys: its route and its words. */
const SCREEN = {
  personal: {
    list: "/settings/api-keys",
    create: "/settings/api-keys/new",
    title: "apiKeys.personalTitle",
    intro: "apiKeys.personalIntro",
    newTitle: "apiKeys.newPersonalTitle",
    empty: "apiKeys.emptyPersonal",
  },
  agent: {
    list: "/settings/api-keys/agents",
    create: "/settings/api-keys/agents/new",
    title: "apiKeys.agentTitle",
    intro: "apiKeys.agentIntro",
    newTitle: "apiKeys.newAgentTitle",
    empty: "apiKeys.emptyAgent",
  },
} as const satisfies Record<
  KeyKind,
  {
    list: string;
    create: string;
    title: MessageKey;
    intro: MessageKey;
    newTitle: MessageKey;
    empty: MessageKey;
  }
>;

function KindBadge({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  return (
    <Badge variant={KIND_BADGE[kind]} data-kind={kind}>
      {t(KIND_NAME[kind])}
    </Badge>
  );
}

function KeyKindGuide({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Alert
      asChild
      aria-labelledby={titleId}
      className="border-0 bg-transparent p-0"
    >
      <section>
        <AlertTitle asChild>
          <Heading id={titleId} className="m-0">
            {t("apiKeys.guideTitle")}
          </Heading>
        </AlertTitle>
        <AlertDescription className="mt-2 flex flex-col gap-3">
          <div
            className="flex flex-col items-start gap-2"
            data-testid={`guide-${kind}`}
          >
            <KindBadge kind={kind} />
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
              {KIND_FACTS[kind].map((fact) => (
                <li key={fact}>{t(fact)}</li>
              ))}
            </ul>
          </div>
          <div>
            {t("apiKeys.docs")}{" "}
            {/* Served by the API itself, outside the console's router. */}
            <TextLink
              href="/docs"
              target="_blank"
              newTabLabel={t("apiKeys.docsNewTab")}
            >
              {t("apiKeys.docsLink")}
            </TextLink>
          </div>
        </AlertDescription>
      </section>
    </Alert>
  );
}

function keyRefusal(
  t: Translate,
  error: ApiError,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  // A 403 (SCOPE_NOT_GRANTABLE) falls through: its sentence names scopes.
  if (error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return refusalText(t, error, permission, role);
}

/** Today in the browser's time zone, as an `<input type="date">` value. */
/** A local calendar day, `days` from today, as a date input's value. */
function localDay(days = 0): string {
  const day = new Date();
  day.setDate(day.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// A new agent key outlives its issuer, so it starts with an end date.
const AGENT_KEY_DEFAULT_DAYS = 90;

/** The end of the chosen day, in the browser's time zone. */
function expiryOf(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59`).toISOString() : undefined;
}

const SOON_MS = 7 * 24 * 60 * 60 * 1000;

export function expiryState(
  expiresAt: string | null,
): "none" | "later" | "soon" | "expired" {
  if (expiresAt === null) return "none";
  const left = new Date(expiresAt).getTime() - Date.now();
  return left <= 0 ? "expired" : left <= SOON_MS ? "soon" : "later";
}

/**
 * The agents an agent's admin may bind a key to (design 4.1). Owners and
 * admins bind to any agent and search for it instead, so they read none.
 */
function useAdministeredAgents() {
  const { client } = useWerft();
  const everywhere = useHasPermission("api_key.manage");
  return useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
}

/**
 * Whether this person issues agent keys at all: an owner or admin for every
 * agent, an agent's admin for that agent (design 4.1). While the agents load
 * it is not yet known, and the agent tab stays out of the way.
 */
function useIssuesAgentKeys(): boolean {
  const everyAgent = useHasPermission("api_key.manage");
  const mine = useAdministeredAgents();
  return (
    everyAgent || (mine.data?.items.length ?? 0) > 0 || mine.error !== null
  );
}

/** The names of the agents the listed keys work for, asked for by id. */
function useAgentNames(
  ids: readonly string[],
): (id: string | null) => string | null {
  const { client } = useWerft();
  const everywhere = useHasPermission("api_key.manage");
  const unique = [...new Set(ids)];
  const named = useQuery({
    ...agentSummariesQuery(client, unique),
    enabled: everywhere && unique.length > 0,
  });
  const mine = useAdministeredAgents();
  const agents: readonly Agent[] =
    (everywhere ? named.data?.items : mine.data?.items) ?? [];
  return (id) =>
    id === null ? null : (agents.find((agent) => agent.id === id)?.name ?? id);
}

/** Why this person cannot make a key of this kind, if they cannot. */
function useCreateReason(kind: KeyKind): string | undefined {
  const { t } = useI18n();
  const role = useRole();
  const own = useHasPermission("api_key.manage_own");
  const agentKeys = useIssuesAgentKeys();
  if (kind === "personal")
    return own ? undefined : permissionReason(t, "api_key.manage_own", role);
  return agentKeys ? undefined : t("apiKeys.noAgents");
}

function KeyScreenNav({
  current,
  keys,
}: {
  readonly current: KeyKind;
  /** The listed keys; until they load, the tabs show no counts. */
  readonly keys: readonly ApiKeyView[] | undefined;
}) {
  const { t } = useI18n();
  const agentKeys = useIssuesAgentKeys();
  if (!agentKeys && current === "personal") return null;
  const tabs: { id: KeyKind; to: string; title: MessageKey }[] = [
    { id: "personal", to: SCREEN.personal.list, title: SCREEN.personal.title },
  ];
  if (agentKeys || current === "agent")
    tabs.push({
      id: "agent",
      to: SCREEN.agent.list,
      title: SCREEN.agent.title,
    });
  return (
    <LinkTabs aria-label={t("apiKeys.nav")}>
      {tabs.map((tab) => {
        const count = keys?.filter((key) => key.kind === tab.id).length;
        return (
          <LinkTab
            key={tab.id}
            asChild
            current={tab.id === current}
            count={count}
            countLabel={
              count === undefined ? undefined : t("apiKeys.navCount", { count })
            }
          >
            {/* The personal list's path is the other tabs' parent. */}
            <Link to={tab.to} activeOptions={{ exact: true }}>
              {t(tab.title)}
            </Link>
          </LinkTab>
        );
      })}
    </LinkTabs>
  );
}

/**
 * API keys (design 4.2), one tab per kind laid out like GitHub's tokens:
 * a narrow list, a separate page to make one, the secret shown once. A
 * personal key acts as the person who made it and stops with them; an agent
 * key belongs to one agent and keeps working after its issuer leaves.
 */
function KeysScreen({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const navigate = useNavigate();
  const keys = useQuery(apiKeysQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const screen = SCREEN[kind];
  const reason = useCreateReason(kind);

  return (
    // The head comes first, as on every page; the two key screens' tabs open
    // its body.
    <Page
      title={t("apiKeys.title")}
      description={t(screen.intro)}
      actions={
        <ReasonButton
          className={buttonVariants()}
          reason={reason}
          onClick={() => void navigate({ to: screen.create })}
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("apiKeys.new")}
        </ReasonButton>
      }
    >
      <KeyScreenNav current={kind} keys={keys.data?.items} />
      <OutcomeLine outcome={outcome} />
      {keys.isPending ? (
        <StatusScreen kind="loading" />
      ) : keys.error ? (
        isApiError(keys.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure error={keys.error} onRetry={() => void keys.refetch()} />
        )
      ) : (
        <KeyList
          items={keys.data.items.filter((key) => key.kind === kind)}
          empty={t(screen.empty)}
          onOutcome={setOutcome}
        />
      )}
      <KeyKindGuide kind={kind} />
    </Page>
  );
}

export function ApiKeysScreen() {
  return <KeysScreen kind="personal" />;
}

export function AgentKeysScreen() {
  return <KeysScreen kind="agent" />;
}

/**
 * The organization admin key's place, held until it exists: no list, no
 * issuing, only what it will be. It belongs to the workspace, so it sits in
 * the workspace's settings, not beside the person's keys.
 */
export function OrgKeysScreen() {
  const { t } = useI18n();
  if (!useHasPermission("api_key.manage"))
    return (
      <Page title={t("apiKeys.orgTitle")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );
  return (
    <Page title={t("apiKeys.orgTitle")} description={t("apiKeys.orgIntro")}>
      <EmptyState
        title={t("apiKeys.orgPending")}
        description={t("apiKeys.orgPendingBody")}
      />
    </Page>
  );
}

function KeyIdMeta({
  id,
  onCopied,
}: {
  readonly id: string;
  readonly onCopied: (copied: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Text
      as="span"
      variant="meta"
      className="inline-flex min-w-0 items-center gap-1"
    >
      <Text as="span" variant="meta">
        {t("apiKeys.idLabel")}
      </Text>
      <Code className="min-w-0 text-foreground [overflow-wrap:anywhere]">
        {id}
      </Code>
      <CopyButton
        value={id}
        variant="ghost"
        size="sm"
        className={KEY_COPY}
        label={t("apiKeys.copy")}
        description={t("apiKeys.keyId", { id })}
        copiedMessage={t("apiKeys.copied")}
        iconClassName={ICON}
        onResult={(ok) => onCopied(ok)}
      />
    </Text>
  );
}

function MetaDot() {
  return (
    <Text as="span" variant="meta" aria-hidden="true">
      ·
    </Text>
  );
}

/** Expiry, or revocation, in the state tokens: a key that never ends warns. */
function ExpiryMeta({
  expiresAt,
  revokedAt,
}: {
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}) {
  const { t, locale } = useI18n();
  const state = revokedAt ? "revoked" : expiryState(expiresAt);
  if (state === "later" && expiresAt)
    return (
      <Text as="span" variant="meta">
        {t("apiKeys.expiresAt", { at: formatTimestamp(expiresAt, locale) })}
      </Text>
    );
  const danger = state === "expired" || state === "revoked";
  const text =
    state === "revoked" && revokedAt
      ? t("apiKeys.revokedAt", { at: formatTimestamp(revokedAt, locale) })
      : state === "none" || !expiresAt
        ? t("apiKeys.noExpiry")
        : t(state === "expired" ? "apiKeys.expiredAt" : "apiKeys.expiresSoon", {
            at: formatTimestamp(expiresAt, locale),
          });
  return (
    <Text
      as="span"
      variant="meta"
      data-tone={danger ? "danger" : "caution"}
      data-expiry={state}
      className="inline-flex items-center gap-1 font-medium text-[var(--werft-tone-fg)]"
    >
      {danger ? (
        <CircleAlert aria-hidden="true" className={ICON} />
      ) : state === "none" ? (
        <InfinityIcon aria-hidden="true" className={ICON} />
      ) : (
        <Clock aria-hidden="true" className={ICON} />
      )}
      {text}
    </Text>
  );
}

function KeyList({
  items,
  empty,
  onOutcome,
}: {
  readonly items: readonly ApiKeyView[];
  readonly empty: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const agentName = useAgentNames(
    items.flatMap((key) => (key.agent_id === null ? [] : [key.agent_id])),
  );
  const [confirming, setConfirming] = useState<ApiKeyView | null>(null);

  const revoke = useMutation<RevokeApiKeyResponse, ApiError, ApiKeyView>({
    mutationFn: (key) =>
      unwrap(
        client.DELETE("/v1/api-keys/{id}", {
          params: { path: { id: key.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setConfirming(null);
      onOutcome({ kind: "notice", text: t("apiKeys.revoked") });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).apiKeys,
      });
    },
    onError: (error, key) => {
      setConfirming(null);
      onOutcome({
        kind: "error",
        text: keyRefusal(
          t,
          error,
          key.kind === "personal" ? "api_key.manage_own" : "api_key.manage",
          role,
        ),
      });
    },
  });

  // Keys whose latest ID copy failed; each row says so under its meta line.
  const [copyFailed, setCopyFailed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  if (items.length === 0) {
    return <EmptyState className="rounded-card border bg-card" title={empty} />;
  }

  return (
    <>
      <RowList
        variant="joined"
        // The settings layout zeroes the row inset; a framed list needs it.
        className="[--werft-row-padding-x:var(--werft-space-4)]"
        aria-label={t("apiKeys.listTitle")}
      >
        {items.map((key) => {
          const agent = agentName(key.agent_id);
          const name = key.name ?? t("apiKeys.unnamed");
          const title = agent === null ? name : `${agent} · ${name}`;
          const label = `${t(KIND_NAME[key.kind])} · ${title}`;
          const scopes = key.scopes
            .map((scope) => t(SCOPE_NAME[scope]))
            .join(", ");
          const approves = key.scopes.includes("sessions:approve");
          return (
            <li
              key={key.id}
              className="flex min-h-12 flex-col items-start gap-2 px-[var(--werft-row-padding-x)] py-3 sm:flex-row sm:items-center sm:gap-3"
              data-revoked={key.revoked_at !== null}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Text
                    as="span"
                    weight="medium"
                    className="min-w-0 [overflow-wrap:anywhere]"
                    data-unnamed={key.name === null}
                  >
                    {title}
                  </Text>
                  <KindBadge kind={key.kind} />
                  <Badge
                    variant={approves ? "green" : "gray"}
                    data-approve={approves}
                  >
                    {t(approves ? "apiKeys.approveYes" : "apiKeys.approveNo")}
                  </Badge>
                </div>
                <Text as="span" variant="meta">
                  {scopes}
                </Text>
                <Text
                  as="div"
                  variant="meta"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <KeyIdMeta
                    id={key.id}
                    onCopied={(ok) =>
                      setCopyFailed((current) => {
                        const next = new Set(current);
                        if (ok) next.delete(key.id);
                        else next.add(key.id);
                        return next;
                      })
                    }
                  />
                  <MetaDot />
                  <Text as="span" variant="meta">
                    {t("apiKeys.createdAt", {
                      at: formatTimestamp(key.created_at, locale),
                    })}
                  </Text>
                  <MetaDot />
                  <ExpiryMeta
                    expiresAt={key.expires_at}
                    revokedAt={key.revoked_at}
                  />
                </Text>
                {copyFailed.has(key.id) ? (
                  <FormError>{t("apiKeys.copyIdFailed")}</FormError>
                ) : null}
                {key.kind === "agent" ? (
                  <Text as="span" variant="meta">
                    {t("apiKeys.survivesIssuerShort")}
                  </Text>
                ) : null}
              </div>
              {key.revoked_at ? null : (
                <RowAction
                  variant="danger"
                  className="shrink-0"
                  disabled={revoke.isPending}
                  aria-label={t("apiKeys.revokeFor", {
                    key: `${label} (${key.id})`,
                  })}
                  onClick={() => setConfirming(key)}
                >
                  {t("apiKeys.revoke")}
                </RowAction>
              )}
            </li>
          );
        })}
      </RowList>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("apiKeys.revokeTitle", { id: confirming?.id ?? "" })}
        consequence={t("apiKeys.revokeConsequence")}
        confirmLabel={t("apiKeys.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (confirming) revoke.mutate(confirming);
        }}
      />
    </>
  );
}

function ScopePicker({
  available,
  chosen,
  onChange,
  note,
}: {
  readonly available: readonly SessionScope[];
  readonly chosen: readonly SessionScope[];
  readonly onChange: (scopes: SessionScope[]) => void;
  /** What the list leaves out and why. */
  readonly note?: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <FieldSet className="w-full gap-3">
      <FieldLegend variant="label" className="mb-0">
        {t("apiKeys.scopes")}
      </FieldLegend>
      {available.map((scope) => (
        <Field key={scope} orientation="horizontal">
          <Checkbox
            checked={chosen.includes(scope)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...chosen, scope]
                  : chosen.filter((s) => s !== scope),
              )
            }
          />
          <FieldContent>
            <FieldLabel>
              {t(SCOPE_NAME[scope])} <code className="font-mono">{scope}</code>
            </FieldLabel>
            <FieldDescription>{t(SCOPE_HINT[scope])}</FieldDescription>
          </FieldContent>
        </Field>
      ))}
      {note ? <FieldDescription>{t(note)}</FieldDescription> : null}
    </FieldSet>
  );
}

function ExpiryField({
  value,
  onChange,
  hint = "apiKeys.expiresHint",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{t("apiKeys.expires")}</FieldLabel>
      <div>
        <Input
          type="date"
          className="w-auto"
          min={localDay()}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <FieldDescription>{t(hint)}</FieldDescription>
    </Field>
  );
}

function NameField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className="w-full">
      <FieldLabel>{t("apiKeys.name")}</FieldLabel>
      <Input
        className="max-w-sm"
        autoComplete="off"
        maxLength={API_KEY_NAME_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>{t("apiKeys.nameHint")}</FieldDescription>
    </Field>
  );
}

/** The request's name: blank is none, as the server would trim it to. */
function nameOf(value: string): { name?: string } {
  const name = value.trim();
  return name ? { name } : {};
}

function useIssue(
  permission: ManagedPermission,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  return useMutation<CreateApiKeyResponse, ApiError, IssueRequest>({
    mutationFn: (body) => unwrap(client.POST("/v1/api-keys", { body })),
    // The response carries the secret; keep it nowhere but the screen.
    gcTime: 0,
    onMutate: () => onOutcome(null),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeysOf(client).apiKeys }),
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: keyRefusal(t, error, permission, role),
      }),
  });
}

/**
 * Making a key is a page of its own; once made, the same page shows the
 * secret in its place. It lives in this page's state only, so leaving,
 * going back or reloading drops it, and nothing new is issued from here
 * while it shows.
 */
function NewKeyScreen({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  const screen = SCREEN[kind];
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const issue = useIssue(
    kind === "personal" ? "api_key.manage_own" : "api_key.manage",
    setOutcome,
  );
  const issued = issue.data;

  return (
    <Page
      title={t(screen.newTitle)}
      description={t(screen.intro)}
      breadcrumb={
        <PageBreadcrumb label={t("shell.breadcrumb")}>
          <PageBreadcrumbLink asChild>
            {/* The list is this page's parent, not the page itself. */}
            <Link to={screen.list} activeOptions={{ exact: true }}>
              {t(screen.title)}
            </Link>
          </PageBreadcrumbLink>
          <PageBreadcrumbCurrent>{t(screen.newTitle)}</PageBreadcrumbCurrent>
        </PageBreadcrumb>
      }
    >
      {outcome?.kind === "error" ? <FormError>{outcome.text}</FormError> : null}
      {issued ? (
        <IssuedSecret issued={issued} listTo={screen.list} />
      ) : kind === "personal" ? (
        <PersonalKeyForm
          busy={issue.isPending}
          send={(body) => issue.mutate(body)}
        />
      ) : (
        <AgentKeyForm
          busy={issue.isPending}
          send={(body) => issue.mutate(body)}
        />
      )}
    </Page>
  );
}

export function NewApiKeyScreen() {
  return <NewKeyScreen kind="personal" />;
}

export function NewAgentKeyScreen() {
  return <NewKeyScreen kind="agent" />;
}

function IssuedSecret({
  issued,
  listTo,
}: {
  readonly issued: CreateApiKeyResponse;
  readonly listTo: string;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const secretRef = useRef<HTMLInputElement>(null);
  const kind = issued.key.kind;
  // The form it replaces held focus; put it on the value so it is not missed.
  useEffect(() => {
    secretRef.current?.focus();
  }, []);
  return (
    <section
      className="flex flex-col gap-4"
      data-status="secret"
      aria-label={t("apiKeys.secretTitle")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading>{t("apiKeys.createdTitle")}</Heading>
        <KindBadge kind={kind} />
      </div>
      <Alert variant="amber" className="border-0">
        <p className="m-0">{t("apiKeys.secretOnce")}</p>
      </Alert>
      <Field>
        <FieldLabel>{t("apiKeys.secret")}</FieldLabel>
        <div className="flex max-w-[var(--werft-layout-reading-width)] items-center gap-2">
          <Input
            ref={secretRef}
            className="min-w-0 flex-1 font-mono"
            type="text"
            readOnly
            value={issued.secret}
            onFocus={(event) => event.target.select()}
          />
          <CopyButton
            value={issued.secret}
            className="shrink-0"
            label={t("apiKeys.copy")}
            copiedLabel={t("apiKeys.copied")}
            copiedMessage={t("apiKeys.copied")}
            iconClassName="size-4"
            fallbackField={secretRef}
            onResult={(ok) => setFailed(!ok)}
          />
        </div>
      </Field>
      {failed ? <FormError>{t("apiKeys.copyFailed")}</FormError> : null}
      <Text variant="meta" className="[overflow-wrap:anywhere]">
        {t("apiKeys.keyId", { id: issued.key.id })}
      </Text>
      <div>
        <Link
          to={listTo}
          data-slot="button"
          className={buttonVariants({ variant: "outline" })}
        >
          {t("apiKeys.toList")}
        </Link>
      </div>
    </section>
  );
}

interface FormProps {
  readonly busy: boolean;
  readonly send: (body: IssueRequest) => void;
}

// The key form sits on the page, not in a card: a 16px body with 16px gaps,
// then cancel and generate 16px below it, with no sunken strip.
const FORM_BODY = "flex flex-col items-start gap-4";

function FormFoot({
  listTo,
  reason,
  disabled,
}: {
  readonly listTo: string;
  readonly reason?: string | undefined;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <CardFooter className="flex-wrap items-start justify-end gap-3 px-0">
      <Link
        to={listTo}
        data-slot="button"
        className={buttonVariants({ variant: "ghost" })}
      >
        {t("common.cancel")}
      </Link>
      <ReasonButton
        type="submit"
        className={buttonVariants()}
        reason={reason}
        disabled={disabled}
      >
        {t("apiKeys.generate")}
      </ReasonButton>
    </CardFooter>
  );
}

function PersonalKeyForm({ busy, send }: FormProps) {
  const held = useMe()?.scopes ?? [];
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [expires, setExpires] = useState("");
  const reason = useCreateReason("personal");
  const granted = scopes.filter((scope) => held.includes(scope));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expiresAt = expiryOf(expires);
    send({
      kind: "personal",
      ...nameOf(name),
      scopes: granted,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
  };

  return (
    <div>
      <form className="grid gap-4" onSubmit={submit}>
        <div className={FORM_BODY}>
          <NameField value={name} onChange={setName} />
          <ScopePicker
            available={held}
            chosen={scopes}
            onChange={setScopes}
            note="apiKeys.selfApproval"
          />
          <ExpiryField value={expires} onChange={setExpires} />
        </div>
        <FormFoot
          listTo={SCREEN.personal.list}
          reason={reason}
          disabled={busy || granted.length === 0}
        />
      </form>
    </div>
  );
}

function AgentKeyForm({ busy, send }: FormProps) {
  const { t } = useI18n();
  const { client } = useWerft();
  const held = useMe()?.scopes ?? [];
  const everywhere = useHasPermission("api_key.manage");
  // Owners and admins search every agent on the server, a page at a time;
  // an agent's admin picks from the agents they administer.
  const [term, setTerm] = useState("");
  const q = term.trim() || undefined;
  const searched = useInfiniteQuery({
    ...agentPagesQuery(client, q),
    enabled: everywhere,
  });
  const mine = useAdministeredAgents();
  const agents: readonly Agent[] =
    (everywhere
      ? searched.data?.pages.flatMap((page) => page.items)
      : mine.data?.items) ?? [];
  const pending = everywhere ? searched.isPending : mine.isPending;
  const agentsError = ((everywhere ? searched.error : mine.error) ??
    null) as ApiError | null;
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  // As the agent admins picker: the input's text is held so editing it after
  // a choice drops the choice.
  const [text, setText] = useState("");
  const [chosenAgent, setChosenAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [expires, setExpires] = useState(() =>
    localDay(AGENT_KEY_DEFAULT_DAYS),
  );
  const pickerId = useId();

  // What the key would actually carry; the button judges by these.
  const granted = scopes.filter((scope) => held.includes(scope));
  // Only an unsearched, fully read list proves there is no agent at all.
  const noAgents =
    !pending &&
    agents.length === 0 &&
    (!everywhere || (q === undefined && !searched.hasNextPage));

  const reason = agentsError
    ? t(errorKey(agentsError.code))
    : noAgents && chosenAgent === null
      ? t("apiKeys.noAgents")
      : chosenAgent === null
        ? t("apiKeys.pickAgent")
        : granted.length === 0
          ? t("apiKeys.agentNeedsScope")
          : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The browser blocks a past date before submitting; a test DOM may not.
    if (expires !== "" && expires < localDay()) {
      event.currentTarget.reportValidity();
      return;
    }
    if (!chosenAgent) return;
    const expiresAt = expiryOf(expires);
    send({
      kind: "agent",
      ...nameOf(name),
      agent_id: chosenAgent.id,
      scopes: granted,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
  };

  return (
    <div>
      <form className="grid gap-4" onSubmit={submit}>
        <div className={FORM_BODY}>
          <Field>
            <FieldLabel htmlFor={pickerId}>{t("apiKeys.agent")}</FieldLabel>
            <div className="w-full max-w-sm">
              <Combobox
                id={pickerId}
                options={agents.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  description: agent.slug,
                }))}
                value={chosenAgent?.id ?? null}
                inputValue={text}
                onInputValueChange={(next) => {
                  setText(next);
                  setChosenAgent((current) =>
                    current && current.name !== next ? null : current,
                  );
                }}
                onValueChange={(value, option) =>
                  setChosenAgent({ id: value, name: option.label })
                }
                maxLength={SEARCH_MAX}
                filter={everywhere ? "none" : "internal"}
                onQueryChange={everywhere ? setTerm : undefined}
                debounceMs={SEARCH_SETTLE_MS}
                hasMore={everywhere && searched.hasNextPage}
                onLoadMore={() => void searched.fetchNextPage()}
                placeholder={t("apiKeys.agentSearch")}
                loading={everywhere ? searched.isFetching : mine.isPending}
                loadingMessage={t("apiKeys.agentLoading")}
                emptyMessage={t(
                  noAgents ? "apiKeys.noAgents" : "apiKeys.agentEmpty",
                )}
                resultCountMessage={(count) =>
                  t("apiKeys.agentCount", { count })
                }
              />
            </div>
            <FieldDescription>{t("apiKeys.agentHint")}</FieldDescription>
          </Field>
          <NameField value={name} onChange={setName} />
          <ScopePicker
            available={held}
            chosen={scopes}
            onChange={setScopes}
            note="apiKeys.selfApproval"
          />
          <ExpiryField
            value={expires}
            onChange={setExpires}
            hint="apiKeys.agentExpiresHint"
          />
        </div>
        <FormFoot
          listTo={SCREEN.agent.list}
          reason={reason}
          disabled={busy || granted.length === 0 || chosenAgent === null}
        />
      </form>
    </div>
  );
}
