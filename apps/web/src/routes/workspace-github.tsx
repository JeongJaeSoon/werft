import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubApp,
  GitHubSettingsConnection,
  GitHubSettingsInstallation,
  GitHubSettingsResponse,
} from "@werft-ai/contracts";
import { githubAppWarnings } from "@werft-ai/core/forms";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  cn,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  Link,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RelativeTime,
  RowListItem,
  SettingsSection,
  Skeleton,
  Text,
  type TimestampLocale,
} from "@werft-ai/ui";
import { ArrowUpRight, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { GitHubMark } from "../components/brand-marks.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { RowMenu, RowMenuItem, RowMenuLink } from "../components/row-menu.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  appShortfalls,
  neededFor,
  permissionsUrl,
  type Shortfall,
  unapproved,
} from "./github-permission-table.ts";
import { IntegrationsLayout } from "./integrations.tsx";
import {
  FeatureList,
  featureName,
  githubSettingsKey,
  permissionName,
  permissionsText,
  useGitHubSettings,
} from "./workspace-github-access.tsx";
import {
  AddAppDialog,
  type AddAppStep,
  NewKeyDialog,
} from "./workspace-github-app-dialogs.tsx";
import { githubNavigation } from "./workspace-github-new-app.tsx";
import { PullRequestSettingsCard } from "./workspace-github-pull-request.tsx";
import {
  defaultInstallation,
  outsideInstallations,
  RepositorySheet,
  repositoriesKey,
  useRepositoryPage,
} from "./workspace-github-repositories.tsx";
import { GitHubUserLinkRow } from "./workspace-github-user-link.tsx";
import {
  SETTINGS_CARD as CARD,
  type OnOutcome,
  SECTIONS,
} from "./workspace-settings.tsx";

const GITHUB_WEB = "https://github.com/";
// Installation table: name, type, repositories, App, connected by, status, menu.
const MANAGER_COLUMNS =
  "minmax(0,1.2fr) 88px 96px minmax(0,1fr) minmax(0,1.2fr) 88px 32px";
const MEMBER_COLUMNS = "minmax(0,1.2fr) 88px minmax(0,1fr) 88px";
// At and under 760px of table: name (with the rest moved under it), status, menu.
const MANAGER_NARROW = "minmax(0,1fr) 88px 32px";
const MEMBER_NARROW = "minmax(0,1fr) 88px";
// Shown only while the table is narrow: the columns it dropped, in the name.
const NARROW_ONLY = "[@container(min-width:761px)]:hidden";

/** The address GitHub's setup URL brings the browser back to. */
export type GitHubSetupSearch = {
  installation_id?: number;
  state?: string;
};

export function gitHubSetupSearch(
  search: Record<string, unknown>,
): GitHubSetupSearch {
  const id = Number(search.installation_id);
  return {
    ...(Number.isSafeInteger(id) && id > 0 ? { installation_id: id } : {}),
    ...(typeof search.state === "string" ? { state: search.state } : {}),
  };
}

const appsKey = (
  client: Parameters<typeof scopedKey>[0],
  workspaceId: string,
) => scopedKey(client, "workspace", workspaceId, "github-apps");

/** "2026. 10. 30.": formatTimestamp without its time. */
const dateOf = (iso: string, locale: TimestampLocale) =>
  formatTimestamp(iso, locale).replace(/,? \d{2}:\d{2}$/, "");

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

/** Integrations > GitHub: the Apps agents reach GitHub with and where they are installed. */
export function WorkspaceGitHubScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const settings = useGitHubSettings();
  useSetupReturn(setOutcome);
  const connected = (settings.data?.connections.length ?? 0) > 0;
  return (
    <>
      <OutcomeLine outcome={outcome} live />
      {settings.isPending ? (
        <div className={CARD}>
          <Skeleton width="40%" />
        </div>
      ) : settings.isError ? (
        <LoadFailure
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <GitHubCard settings={settings.data} onOutcome={setOutcome} />
          {connected ? (
            <FeaturesCard settings={settings} onOutcome={setOutcome} />
          ) : null}
          {connected ? (
            <PullRequestSettingsCard
              key={settings.data.pull_request_revision}
              settings={settings.data}
              onOutcome={setOutcome}
            />
          ) : null}
          {connected ? (
            <GitHubUserLinkRow settings={settings} onOutcome={setOutcome} />
          ) : null}
        </>
      )}
    </>
  );
}

export function WorkspaceGitHubRoute() {
  return (
    <IntegrationsLayout tab="github">
      <WorkspaceGitHubScreen />
    </IntegrationsLayout>
  );
}

/**
 * Back from GitHub's install page with `installation_id` and the state the
 * console started: record who connected it, once, and wipe both from the
 * address bar.
 */
function useSetupReturn(onOutcome: OnOutcome) {
  const search = useSearch({
    from: "/authed/settings/workspace/integrations/github",
  });
  const [sent] = useState(() => search);
  const navigate = useNavigate();
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const workspaceId = useMe()?.workspace?.id;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || workspaceId === undefined) return;
    if (sent.installation_id === undefined || sent.state === undefined) return;
    started.current = true;
    void navigate({
      to: "/settings/workspace/integrations/github",
      search: {},
      replace: true,
    });
    void unwrap(
      client.POST("/v1/workspaces/{id}/github-apps/installations/complete", {
        params: { path: { id: workspaceId } },
        body: { installation_id: sent.installation_id, state: sent.state },
      }),
    ).then(
      () => {
        onOutcome({ kind: "notice", text: t("github.install.done") });
        void queryClient.invalidateQueries({
          queryKey: githubSettingsKey(client, workspaceId),
        });
      },
      (error: unknown) =>
        onOutcome({
          kind: "error",
          text:
            isApiError(error) && reasonOf(error) === "state_invalid"
              ? t("github.install.stateInvalid")
              : t("github.install.notRecorded"),
        }),
    );
  }, [sent, workspaceId, navigate, client, queryClient, onOutcome, t]);
}

/** The keys' dates and who saved them; only owners and admins read these. */
function useKeyLines(enabled: boolean) {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: appsKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-apps", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: enabled && workspaceId !== "",
  });
}

function GitHubCard({
  settings,
  onOutcome,
}: {
  readonly settings: GitHubSettingsResponse;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [adding, setAdding] = useState<AddAppStep | null>(null);
  const [sheet, setSheet] = useState(false);
  // The button a dialog opened from, to focus again as it closes.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const add = (step: AddAppStep, from: HTMLElement) => {
    setOpener(from);
    setAdding(step);
  };
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const connections = settings.connections;
  const accounts = new Set(
    connections.flatMap((connection) =>
      connection.installations.map((installation) => installation.account),
    ),
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: githubSettingsKey(client, workspaceId),
      }),
      queryClient.invalidateQueries({ queryKey: appsKey(client, workspaceId) }),
      queryClient.invalidateQueries({
        queryKey: repositoriesKey(client, workspaceId),
      }),
    ]);
  const empty = connections.length === 0;

  return (
    <section aria-labelledby={titleId} className={SECTIONS}>
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <IconTile icon={TileMark} hue="slate" size="two-line" />
          <div className="flex min-w-0 flex-1 flex-col">
            <Heading
              id={titleId}
              ref={headingRef}
              level={2}
              tabIndex={-1}
              className="focus-visible:outline-none"
            >
              GitHub
            </Heading>
            <Text variant="sub">
              {empty
                ? t("github.card.none")
                : t("github.card.counts", {
                    apps: connections.length,
                    accounts: accounts.size,
                  })}
            </Text>
          </div>
        </div>
        <Text variant="sub">{t("github.card.hint")}</Text>
      </div>
      {empty ? (
        <div className="flex flex-col items-start gap-3 rounded-card border bg-card p-4">
          <Text weight="medium">{t("github.empty.title")}</Text>
          <Text variant="sub">{t("github.empty.hint")}</Text>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={(event) => add("new", event.currentTarget)}
              >
                {t("github.empty.create")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={(event) => add("existing", event.currentTarget)}
              >
                {t("github.add.existing")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <AppList
            settings={settings}
            onAdd={(from) => add("choose", from)}
            onOutcome={onOutcome}
            onChanged={refresh}
          />
          <Installations connections={connections} onOutcome={onOutcome} />
          {canManage ? (
            <RepositoriesLine
              connections={connections}
              onOpen={(from) => {
                setOpener(from);
                setSheet(true);
              }}
            />
          ) : null}
        </>
      )}
      {canManage ? (
        <>
          <AddAppDialog
            step={adding}
            onStep={setAdding}
            blocked={settings.oauth.callback_url === null}
            opener={opener}
            onOutcome={onOutcome}
            onAdded={() => {
              // The first App replaces the empty state and the button with it.
              setOpener(headingRef.current);
              void refresh();
            }}
          />
          <RepositorySheet
            open={sheet}
            onOpenChange={setSheet}
            opener={opener}
            connections={connections}
            onOutcome={onOutcome}
          />
        </>
      ) : null}
    </section>
  );
}

function TileMark({ className }: { readonly className?: string }) {
  return (
    <GitHubMark
      className={cn(className, "text-(--werft-color-tile-foreground)")}
    />
  );
}

/**
 * "조직 추가": the App's install page on GitHub, through a state the console
 * keeps so it can say who connected the installation. With several Apps,
 * a menu picks which one is installed.
 */
function AddAccount({
  connections,
  onOutcome,
}: {
  readonly connections: readonly GitHubSettingsConnection[];
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const start = useMutation<{ install_url: string }, ApiError, string>({
    mutationFn: (connectionId) =>
      unwrap(
        client.POST(
          "/v1/workspaces/{id}/github-apps/{connectionId}/installations/start",
          { params: { path: { id: workspaceId, connectionId } } },
        ),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: ({ install_url }) => {
      if (install_url.startsWith(GITHUB_WEB)) {
        githubNavigation.assign(install_url);
      }
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      }),
  });
  const text = (
    <>
      <Plus aria-hidden="true" />
      {t("github.card.addAccount")}
    </>
  );
  const only = connections.length === 1 ? connections[0] : undefined;
  if (only) {
    return (
      <Button
        type="button"
        aria-disabled={start.isPending || undefined}
        onClick={() => {
          if (!start.isPending) start.mutate(only.connection_id);
        }}
      >
        {text}
      </Button>
    );
  }
  return (
    <RowMenu label={t("github.card.addAccount")} text={text}>
      {(close) =>
        connections.map((connection) => (
          <RowMenuItem
            key={connection.connection_id}
            onSelect={() => {
              close();
              if (!start.isPending) start.mutate(connection.connection_id);
            }}
          >
            {t("github.card.install", { name: connection.name })}
          </RowMenuItem>
        ))
      }
    </RowMenu>
  );
}

type AppState = "rejected" | "short" | "pending" | "unknown" | "ok";

function appState(
  connection: GitHubSettingsConnection,
  shortfalls: readonly Shortfall[],
): AppState {
  if (connection.key_status === "rejected") return "rejected";
  if (shortfalls.length > 0) return "short";
  if (
    connection.installations.some(
      (installation) => installation.status === "approval_pending",
    )
  ) {
    return "pending";
  }
  return connection.key_status === "unknown" ? "unknown" : "ok";
}

function AppList({
  settings,
  onAdd,
  onOutcome,
  onChanged,
}: {
  readonly settings: GitHubSettingsResponse;
  readonly onAdd: (from: HTMLElement) => void;
  readonly onOutcome: OnOutcome;
  readonly onChanged: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const canManage = useHasPermission("workspace.manage");
  const keys = useKeyLines(canManage);
  const [newKey, setNewKey] = useState<GitHubSettingsConnection | null>(null);
  // Kept past the close: the dialog reads it as it closes.
  const [keyOpener, setKeyOpener] = useState<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<GitHubSettingsConnection | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <SettingsSection
        titleAs="h3"
        titleRef={headingRef}
        title={t("github.apps.title")}
        actions={
          canManage ? (
            <Button
              type="button"
              size="sm"
              aria-haspopup="dialog"
              onClick={(event) => onAdd(event.currentTarget)}
            >
              <Plus aria-hidden="true" />
              {t("github.apps.add")}
            </Button>
          ) : null
        }
        rows={settings.connections.map((connection) => (
          <AppRow
            key={connection.connection_id}
            connection={connection}
            settings={settings}
            keyLine={keys.data?.github_apps.find(
              (app) => app.connection_id === connection.connection_id,
            )}
            onNewKey={(opener) => {
              setKeyOpener(opener);
              setNewKey(connection);
            }}
            onRemove={() => setRemoving(connection)}
          />
        ))}
      />
      <NewKeyDialog
        connection={newKey}
        opener={keyOpener}
        onClose={() => setNewKey(null)}
        onOutcome={onOutcome}
        onSaved={() => void onChanged()}
      />
      <RemoveApp
        connection={removing}
        connections={settings.connections}
        onClose={() => setRemoving(null)}
        onOutcome={onOutcome}
        onRemoved={async () => {
          await onChanged();
          headingRef.current?.focus();
        }}
      />
    </>
  );
}

function AppRow({
  connection,
  settings,
  keyLine,
  onNewKey,
  onRemove,
}: {
  readonly connection: GitHubSettingsConnection;
  readonly settings: GitHubSettingsResponse;
  readonly keyLine: GitHubApp | undefined;
  readonly onNewKey: (opener: HTMLElement | null) => void;
  readonly onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const canManage = useHasPermission("workspace.manage");
  const shortfalls = appShortfalls(connection, settings.ceiling);
  const state = appState(connection, shortfalls);
  const pending = connection.installations.filter(
    (installation) => installation.status === "approval_pending",
  );
  const key = keyLine?.private_key;
  const meta = key
    ? key.updated_by
      ? t("github.apps.keyLine", {
          id: String(connection.app_id),
          at: dateOf(key.updated_at, locale),
          by: key.updated_by.display_name,
        })
      : t("github.apps.keyLineAt", {
          id: String(connection.app_id),
          at: dateOf(key.updated_at, locale),
        })
    : t("github.apps.idLine", { id: String(connection.app_id) });
  return (
    <RowListItem className="flex-col items-stretch gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="span" weight="medium" truncate>
              {connection.name}
            </Text>
            <Badge>{t(`github.role.${connection.role}`)}</Badge>
            <WideBadge connection={connection} />
          </div>
          <Text variant="meta">{meta}</Text>
        </div>
        <AppStateBadge state={state} pending={pending.length} />
        {canManage ? (
          <RowMenu label={t("github.apps.menu", { name: connection.name })}>
            {(close) => (
              <>
                <RowMenuItem onSelect={() => onNewKey(close())}>
                  {t("github.apps.newKey")}
                </RowMenuItem>
                <RowMenuItem
                  tone="danger"
                  onSelect={() => {
                    close();
                    onRemove();
                  }}
                >
                  {t("github.apps.remove")}
                </RowMenuItem>
              </>
            )}
          </RowMenu>
        ) : null}
      </div>
      {state === "rejected" ? (
        <Text className="text-(color:--werft-tone-danger-fg)">
          {t("github.apps.rejected")}
        </Text>
      ) : (
        <>
          {state === "short" ? (
            <NeedBlock
              connection={connection}
              shortfalls={shortfalls}
              canManage={canManage}
            />
          ) : null}
          {pending.length > 0 ? (
            <PendingBlock
              connection={connection}
              pending={pending}
              canManage={canManage}
            />
          ) : null}
        </>
      )}
    </RowListItem>
  );
}

function AppStateBadge({
  state,
  pending,
}: {
  readonly state: AppState;
  readonly pending: number;
}) {
  const { t } = useI18n();
  switch (state) {
    case "rejected":
      return <Badge variant="red">{t("github.apps.state.rejected")}</Badge>;
    case "short":
      return <Badge variant="amber">{t("github.apps.state.short")}</Badge>;
    case "pending":
      return (
        <Badge variant="amber">
          {t("github.apps.state.pending", { count: pending })}
        </Badge>
      );
    case "unknown":
      return <Badge>{t("github.apps.state.unknown")}</Badge>;
    case "ok":
      return <Badge variant="green">{t("github.apps.state.ok")}</Badge>;
  }
}

/** Permissions wider than the role's guidance: one badge, the names behind it. */
function WideBadge({
  connection,
}: {
  readonly connection: GitHubSettingsConnection;
}) {
  const { t } = useI18n();
  const wide = githubAppWarnings(connection.role, connection.permissions);
  if (wide.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant="gray">
          <button type="button">{t("github.apps.wide")}</button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent>
        {t("github.apps.wideBody", {
          list: wide
            .map(
              (item) =>
                `${permissionName(t, item.permission)} ${t(`github.permissions.level.${item.level}`)}`,
            )
            .join(", "),
        })}
      </PopoverContent>
    </Popover>
  );
}

const noteButton = "h-auto min-h-7 whitespace-normal text-link";

/** What the App lacks for the features on, where to add it, and a note for its owner. */
function NeedBlock({
  connection,
  shortfalls,
  canManage,
}: {
  readonly connection: GitHubSettingsConnection;
  readonly shortfalls: readonly Shortfall[];
  readonly canManage: boolean;
}) {
  const { t } = useI18n();
  const need = permissionsText(t, neededFor(shortfalls));
  const features = shortfalls.map((item) => featureName(t, item.feature));
  const url = permissionsUrl(connection);
  const note = t("github.apps.ownerNote", {
    name: connection.name,
    permissions: need,
    url: url ?? connection.html_url,
  });
  return (
    <div className="flex flex-col gap-2">
      <Text className="text-(color:--werft-tone-caution-fg)">
        {t("github.apps.need", {
          features: features.join(", "),
          permissions: need,
        })}
      </Text>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {url ? (
            <ExternalButton href={url} text={t("github.apps.addPermissions")} />
          ) : null}
          <CopyButton
            value={note}
            variant="ghost"
            size="sm"
            className={noteButton}
            icon="none"
            label={t("github.apps.copyOwnerNote")}
            copiedLabel={t("github.copied")}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Installations that have not approved what the App asks for yet. */
function PendingBlock({
  connection,
  pending,
  canManage,
}: {
  readonly connection: GitHubSettingsConnection;
  readonly pending: readonly GitHubSettingsInstallation[];
  readonly canManage: boolean;
}) {
  const { t } = useI18n();
  const missing = new Set(
    pending.flatMap((installation) =>
      unapproved(installation, connection.permissions),
    ),
  );
  const asked = Object.fromEntries(
    [...missing].sort().map((name) => [name, connection.permissions?.[name]]),
  );
  const permissions =
    missing.size > 0
      ? permissionsText(t, asked as Record<string, "read" | "write" | "admin">)
      : t("github.apps.pendingSome");
  const accounts = pending.map((installation) => installation.account);
  const note = t("github.apps.installNote", {
    name: connection.name,
    permissions,
    lines: pending
      .map(
        (installation) =>
          `- ${installation.account}: ${installation.detail?.html_url ?? GITHUB_WEB}`,
      )
      .join("\n"),
  });
  return (
    <div className="flex flex-col gap-2">
      <Text className="text-(color:--werft-tone-caution-fg)">
        {t("github.apps.pendingLine", {
          accounts: accounts.join(", "),
          permissions,
        })}
      </Text>
      {canManage ? (
        <CopyButton
          value={note}
          variant="ghost"
          size="sm"
          className={cn(noteButton, "w-fit")}
          icon="none"
          label={t("github.apps.copyInstallNote")}
          copiedLabel={t("github.copied")}
        />
      ) : null}
    </div>
  );
}

function ExternalButton({
  href,
  text,
}: {
  readonly href: string;
  readonly text: string;
}) {
  const { t } = useI18n();
  return (
    <Button asChild variant="outline" size="sm">
      <Link
        href={href}
        target="_blank"
        newTabLabel={t("github.newTab")}
        className="text-foreground hover:no-underline"
      >
        {text}
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </Link>
    </Button>
  );
}

/** Disconnecting an App, with what goes with it read first. */
const otherAuthors = (
  connections: readonly GitHubSettingsConnection[],
  connection: GitHubSettingsConnection | null,
) =>
  connections.filter(
    (held) =>
      held.role === "author" &&
      held.connection_id !== connection?.connection_id,
  );

function RemoveApp({
  connection,
  connections,
  onClose,
  onOutcome,
  onRemoved,
}: {
  readonly connection: GitHubSettingsConnection | null;
  readonly connections: readonly GitHubSettingsConnection[];
  readonly onClose: () => void;
  readonly onOutcome: OnOutcome;
  readonly onRemoved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const id = connection?.connection_id ?? "";
  const usage = useQuery({
    queryKey: [...appsKey(client, workspaceId), id, "usage"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: id } },
        }),
      ),
    enabled: connection !== null && workspaceId !== "",
    gcTime: 0,
    // Reopening the dialog reads it again; meanwhile removal stays blocked.
    retry: false,
  });
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      const name = connection?.name ?? "";
      onClose();
      onOutcome({ kind: "notice", text: t("github.apps.removed", { name }) });
      await onRemoved();
    },
    onError: (error) => {
      onClose();
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      });
    },
  });
  const read = usage.data?.usage;
  // People link accounts with it while another author App exists: the
  // server refuses until linking moves to that one.
  const held =
    read?.user_link === true &&
    otherAuthors(connections, connection).length > 0;
  const consequence: ReactNode = usage.isPending ? (
    <Skeleton width="80%" />
  ) : usage.isError ? (
    t("github.apps.removeUsageFailed")
  ) : held ? (
    t("github.apps.removeHeld")
  ) : read ? (
    <>
      {t("github.apps.removeUsage", {
        pinned: read.pinned_repository_count,
        agents: read.agent_count,
        sessions: read.active_session_count,
      })}
      {read.user_link ? ` ${t("github.apps.removeUserLink")}` : ""}{" "}
      {t("github.apps.removeHint")}
    </>
  ) : (
    t("github.apps.removeHint")
  );
  return (
    <ConfirmDialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("github.apps.removeTitle")}
      target={connection?.name}
      consequence={consequence}
      confirmLabel={t("github.apps.remove")}
      cancelLabel={t("common.cancel")}
      tone="danger"
      busy={remove.isPending}
      confirmDisabled={held || usage.isPending || usage.isError}
      onConfirm={() => {
        if (!remove.isPending) remove.mutate();
      }}
    />
  );
}

type Row = {
  readonly connection: GitHubSettingsConnection;
  readonly installation: GitHubSettingsInstallation;
};

/** One row an installation (an account × an App), the account first. */
function Installations({
  connections,
  onOutcome,
}: {
  readonly connections: readonly GitHubSettingsConnection[];
  readonly onOutcome: OnOutcome;
}) {
  const { t, locale } = useI18n();
  const canManage = useHasPermission("workspace.manage");
  const rows: Row[] = connections
    .flatMap((connection) =>
      connection.installations.map((installation) => ({
        connection,
        installation,
      })),
    )
    .sort(
      (a, b) =>
        a.installation.account.localeCompare(b.installation.account) ||
        a.connection.name.localeCompare(b.connection.name),
    );
  const readAt = connections
    .map((connection) => connection.installations_read_at)
    .filter((at): at is string => at !== null)
    .sort()[0];
  const addAccount = (
    <AddAccount connections={connections} onOutcome={onOutcome} />
  );
  const section = (body: ReactNode) => (
    <SettingsSection
      titleAs="h3"
      title={t("github.table.title")}
      actions={canManage && rows.length > 0 ? addAccount : null}
    >
      {body}
    </SettingsSection>
  );
  if (rows.length === 0) {
    // No list yet: the call to action lives in the empty box.
    return section(
      <div className="flex flex-col items-start gap-3 rounded-card border bg-card p-4">
        <Text variant="sub">{t("github.table.empty")}</Text>
        {canManage ? addAccount : null}
      </div>,
    );
  }

  const type = (installation: GitHubSettingsInstallation) =>
    t(`github.table.type.${installation.account_type}`);
  const repos = (installation: GitHubSettingsInstallation) => {
    const detail = installation.detail;
    if (!detail) return "";
    const count = detail.repository_count;
    return detail.repository_selection === "all"
      ? count === null
        ? t("github.table.reposAllUnknown")
        : t("github.table.reposAll", { count })
      : count === null
        ? t("github.table.reposSelectedUnknown")
        : t("github.table.reposSelected", { count });
  };
  const connectedBy = (installation: GitHubSettingsInstallation) => {
    const connected = installation.detail?.connected;
    if (connected) {
      const at = dateOf(connected.at, locale);
      return connected.by ? `${connected.by.display_name} · ${at}` : at;
    }
    const created = installation.detail?.created_at;
    return created
      ? t("github.table.installedAt", { at: dateOf(created, locale) })
      : "—";
  };

  return section(
    <div className="flex flex-col gap-2">
      <GridTable
        aria-label={t("github.table.label")}
        columns={canManage ? MANAGER_COLUMNS : MEMBER_COLUMNS}
        narrowAt={760}
        narrowColumns={canManage ? MANAGER_NARROW : MEMBER_NARROW}
        framed
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("github.table.name")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("github.table.type")}
          </GridTableColumnHeader>
          {canManage ? (
            <GridTableColumnHeader hideNarrow>
              {t("github.table.repositories")}
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader hideNarrow>
            {t("github.table.app")}
          </GridTableColumnHeader>
          {canManage ? (
            <GridTableColumnHeader hideNarrow>
              {t("github.table.connectedBy")}
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader>
            {t("github.table.status")}
          </GridTableColumnHeader>
          {canManage ? (
            <GridTableColumnHeader>
              <Text as="span" className="sr-only">
                {t("github.table.menu")}
              </Text>
            </GridTableColumnHeader>
          ) : null}
        </GridTableHeader>
        {rows.map(({ connection, installation }) => {
          const label = `${installation.account} · ${connection.name}`;
          const moved = canManage
            ? [type(installation), repos(installation), connection.name]
            : [type(installation), connection.name];
          return (
            <GridTableRow
              key={`${connection.connection_id}:${installation.id}`}
            >
              <GridTableCell {...{ role: "rowheader" }} lines>
                <Text as="span" weight="medium" truncate>
                  {installation.account}
                </Text>
                <Text as="span" variant="meta" className={NARROW_ONLY}>
                  {moved.join(" · ")}
                </Text>
                {canManage ? (
                  <Text as="span" variant="meta" className={NARROW_ONLY}>
                    {t("github.table.connectedLine", {
                      by: connectedBy(installation),
                    })}
                  </Text>
                ) : null}
              </GridTableCell>
              <GridTableCell hideNarrow>
                <Text as="span" variant="sub">
                  {type(installation)}
                </Text>
              </GridTableCell>
              {canManage ? (
                <GridTableCell hideNarrow>{repos(installation)}</GridTableCell>
              ) : null}
              <GridTableCell hideNarrow>
                <Text as="span" truncate>
                  {connection.name}
                </Text>
              </GridTableCell>
              {canManage ? (
                <GridTableCell hideNarrow>
                  <Text as="span" truncate>
                    {connectedBy(installation)}
                  </Text>
                </GridTableCell>
              ) : null}
              <GridTableCell>
                <InstallationBadge installation={installation} />
              </GridTableCell>
              {canManage ? (
                <GridTableCell align="end">
                  {installation.detail?.html_url ? (
                    <RowMenu label={t("github.table.rowMenu", { name: label })}>
                      {(close) => (
                        <RowMenuLink
                          href={installation.detail?.html_url ?? GITHUB_WEB}
                          newTabLabel={t("github.newTab")}
                          onSelect={close}
                        >
                          {t(
                            installation.status === "approval_pending"
                              ? "github.table.approve"
                              : "github.table.manage",
                          )}
                        </RowMenuLink>
                      )}
                    </RowMenu>
                  ) : null}
                </GridTableCell>
              ) : null}
            </GridTableRow>
          );
        })}
      </GridTable>
      {readAt ? (
        <Text variant="meta">
          {t("github.table.readAt")} ·{" "}
          <RelativeTime value={readAt} locale={locale} />
        </Text>
      ) : null}
    </div>,
  );
}

const INSTALLATION_BADGE = {
  active: "green",
  approval_pending: "amber",
  suspended: "gray",
  unknown: "gray",
} as const;

function InstallationBadge({
  installation,
}: {
  readonly installation: GitHubSettingsInstallation;
}) {
  const { t } = useI18n();
  return (
    <Badge variant={INSTALLATION_BADGE[installation.status]}>
      {t(`github.table.state.${installation.status}`)}
    </Badge>
  );
}

/** Its own line, apart from the table: open even once every installation is gone. */
function RepositoriesLine({
  connections,
  onOpen,
}: {
  readonly connections: readonly GitHubSettingsConnection[];
  readonly onOpen: (from: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const list = useRepositoryPage(defaultInstallation(connections), 1);
  const catalog = list.data?.catalog ?? [];
  const outside = outsideInstallations(catalog).length;
  return (
    <SettingsSection
      titleAs="h3"
      title={t("github.repos.title")}
      box
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          {t("github.repos.manage")}
        </Button>
      }
    >
      <div>
        <Text variant="sub">
          {list.data
            ? outside > 0
              ? t("github.repos.countsOutside", {
                  count: catalog.length,
                  outside,
                })
              : t("github.repos.counts", { count: catalog.length })
            : " "}
        </Text>
      </div>
    </SettingsSection>
  );
}

function FeaturesCard({
  settings,
  onOutcome,
}: {
  readonly settings: ReturnType<typeof useGitHubSettings>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  return (
    <SettingsSection
      title={t("github.ceiling.title")}
      description={t("github.ceiling.hint")}
    >
      <FeatureList settings={settings} onOutcome={onOutcome} />
    </SettingsSection>
  );
}
