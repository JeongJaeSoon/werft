import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  ProfileSummary,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  buttonVariants,
  Code,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  EmptyState,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  KeyValueList,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  Section,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
  agentsOnProfileQuery,
  profilesQuery,
  queryKeysOf,
} from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { installationOptionsQuery } from "./profile-tools.tsx";
import { blockedNewTools } from "./profile-tools-model.ts";
import { profileName, STATE_BADGE, stateOf, versionOf } from "./profiles.tsx";

const HISTORY_COLUMNS = [
  "minmax(0,1fr) 152px 168px",
  "minmax(0,1fr) 128px",
] as const;
const AGENT_COLUMNS = "minmax(0,1fr) minmax(0,1fr)";

/**
 * The versions of `profile`'s line: a workspace profile's name, or for a
 * ceiling every row the `previous_id` links reach, either way.
 */
function lineOf(
  profile: ProfileSummary,
  items: readonly ProfileSummary[],
): ProfileSummary[] {
  if (profile.workspace) {
    return items.filter(
      (item) => item.workspace?.name === profile.workspace?.name,
    );
  }
  const ceilings = items.filter((item) => item.source === "operator");
  const line = new Set([profile.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of ceilings) {
      const previous = item.installation?.previous_id;
      if (line.has(item.id) && previous && !line.has(previous)) {
        line.add(previous);
        grew = true;
      } else if (previous && line.has(previous) && !line.has(item.id)) {
        line.add(item.id);
        grew = true;
      }
    }
  }
  return ceilings.filter((item) => line.has(item.id));
}

export function ProfileDetailScreen() {
  const { t } = useI18n();
  const { profileId } = useParams({ from: "/authed/profiles/$profileId" });
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  const profiles = useQuery(profilesQuery(client));
  // Kept per profile id: the screen stays mounted when another version's
  // link changes the param.
  const [retiring, setRetiring] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly on: string;
    readonly text: string;
  } | null>(null);

  const items = profiles.data?.items ?? [];
  const profile = items.find((item) => item.id === profileId);
  const ceiling = profile?.source === "operator";
  // Only an owner reads the catalogs, which say what a newer engine added.
  const options = useQuery({
    ...installationOptionsQuery(client),
    enabled: ceiling && operates,
  });
  // Workspace versions answer to an owner or admin, ceilings to an owner.
  const changes = ceiling ? operates : manages;

  const retire = useMutation<WorkspaceProfileChangeResponse, ApiError, string>({
    mutationFn: (id) =>
      unwrap(
        ceiling
          ? client.POST("/v1/installation-profiles/{profile_id}/retire", {
              params: { path: { profile_id: id } },
            })
          : client.POST("/v1/workspace-profiles/{profile_id}/retire", {
              params: { path: { profile_id: id } },
            }),
      ),
    onMutate: () => setRetireError(null),
    onSuccess: async ({ profile: retired }) => {
      setRetiring(null);
      setNotice({
        on: retired.id,
        text: t("profiles.retired", { id: retired.id }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setRetireError(
        ceiling && failure.code === "FORBIDDEN"
          ? t("profiles.ceiling.ownerOnly")
          : refusalText(t, failure, "workspace.manage", role),
      ),
  });

  // Which way the dialog goes is fixed when it opens, so a list refresh
  // underneath cannot turn a block into an unblock.
  const [blocking, setBlocking] = useState<{
    readonly id: string;
    readonly block: boolean;
  } | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  // Block sits in the danger zone and unblock in the head, so the button
  // that opened the dialog is gone once the list refetches; focus moves to
  // the one that replaces it when it mounts.
  const focusNext = useRef<"block" | "unblock" | null>(null);
  const focusWhen =
    (which: "block" | "unblock") => (button: HTMLButtonElement | null) => {
      if (button && focusNext.current === which) {
        focusNext.current = null;
        button.focus();
      }
    };
  const block = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    { readonly id: string; readonly block: boolean }
  >({
    mutationFn: ({ id, block }) =>
      unwrap(
        block
          ? client.POST("/v1/installation-profiles/{profile_id}/block", {
              params: { path: { profile_id: id } },
            })
          : client.POST("/v1/installation-profiles/{profile_id}/unblock", {
              params: { path: { profile_id: id } },
            }),
      ),
    onMutate: () => setBlockError(null),
    onSuccess: async ({ profile: changed }, { block }) => {
      focusNext.current = block ? "unblock" : "block";
      setBlocking(null);
      setNotice({
        on: changed.id,
        text: t(block ? "profiles.blockDone" : "profiles.unblockDone", {
          id: changed.id,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setBlockError(
        failure.code === "FORBIDDEN"
          ? t("profiles.blockOwnerOnly")
          : refusalText(t, failure, "workspace.manage", role),
      ),
  });

  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to="/profiles" activeOptions={{ exact: true }}>
          {t("profiles.title")}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{profileId}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );

  if (profiles.isPending)
    return (
      <Page title={profileId} breadcrumb={breadcrumb}>
        <Skeleton width="60%" />
      </Page>
    );
  if (profiles.isError)
    return (
      <Page title={profileId} breadcrumb={breadcrumb}>
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      </Page>
    );
  if (profile === undefined)
    return (
      <Page
        title={t("profiles.detail.notFound.title")}
        description={t("profiles.detail.notFound.text", { id: profileId })}
        breadcrumb={breadcrumb}
      >
        <Link
          className={buttonVariants({
            variant: "outline",
            className: "self-start",
          })}
          to="/profiles"
        >
          {t("profiles.detail.back")}
        </Link>
      </Page>
    );

  const state = stateOf(profile);
  // The server takes a new version of a name only from its latest; an
  // imported ceiling has no name, so any new name may follow it. An owner
  // versions any profile, an admin only a workspace profile (one with a source).
  const ceilingName = profile.installation?.name;
  const versionable =
    ceiling &&
    (operates || (manages && profile.installation?.derived_from != null)) &&
    !(
      ceilingName &&
      items.some(
        (item) =>
          item.installation?.name === ceilingName &&
          versionOf(item) > versionOf(profile),
      )
    );
  const blockedNew =
    ceiling && options.data
      ? blockedNewTools(options.data, profile)
      : { catalog: "", tools: [] };
  const actions: ReactNode[] = [];
  if (ceiling) {
    if (manages && pickable(profile))
      actions.push(
        <Link
          key="narrow"
          className={buttonVariants({ variant: "outline" })}
          to="/profiles/new"
          search={{ from: profile.id }}
        >
          {t("profiles.detail.createFrom")}
        </Link>,
      );
    if (versionable)
      actions.push(
        <Link
          key="version"
          className={buttonVariants()}
          to="/profiles/new"
          search={{ from: profile.id, mode: "version" }}
        >
          {t("profiles.newVersion")}
        </Link>,
      );
  }
  const canRetire = changes && state !== "retired";
  // Only the owner blocks a ceiling; a retired one can be blocked too.
  // Unblocking undoes nothing, so it stays in the head; blocking is in the
  // danger zone.
  const blocked = state === "blocked";
  const canBlock = ceiling && operates && !blocked;
  if (ceiling && operates && blocked)
    actions.push(
      <Button
        key="unblock"
        ref={focusWhen("unblock")}
        type="button"
        variant="outline"
        onClick={() => {
          setBlockError(null);
          setBlocking({ id: profile.id, block: false });
        }}
      >
        {t("profiles.unblock")}
      </Button>,
    );

  // Losing the role closes the dialog; a request already sent still reports here.
  const retireOpen = retiring === profile.id && changes;
  const blockOpen = blocking?.id === profile.id && ceiling && operates;
  const blockAction = blocking?.block ?? true;

  return (
    <Page
      breadcrumb={breadcrumb}
      title={
        <span className="[overflow-wrap:anywhere]">{profileName(profile)}</span>
      }
      titleAside={
        <span className="flex items-center gap-2">
          <Text as="span" variant="meta">
            {t("profiles.versionTag", { version: versionOf(profile) })}
          </Text>
          <Badge variant={STATE_BADGE[state]}>
            {t(`profiles.state.${state}`)}
          </Badge>
        </span>
      }
      description={t("profiles.detail.description")}
      actions={
        actions.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">{actions}</div>
        )
      }
    >
      <Notice>{notice?.on === profile.id ? notice.text : undefined}</Notice>
      {retireError === null || retireOpen ? null : (
        <Alert variant="red" role="alert" className="border-0">
          <AlertDescription>{retireError}</AlertDescription>
        </Alert>
      )}
      {blockError === null || blockOpen ? null : (
        <Alert variant="red" role="alert" className="border-0">
          <AlertDescription>{blockError}</AlertDescription>
        </Alert>
      )}
      {state === "usable" ? null : (
        <Alert
          variant={STATE_BADGE[state] === "red" ? "red" : "blue"}
          className="border-0"
        >
          <AlertDescription>
            {t(`profiles.stateReason.${state}`, {
              base: profile.workspace?.base_profile_id ?? "",
            })}
          </AlertDescription>
        </Alert>
      )}
      {blockedNew.tools.length === 0 ? null : (
        <Alert variant="amber" className="border-0">
          <AlertTitle>
            {t("profiles.tools.blockedNew", {
              count: blockedNew.tools.length,
            })}
          </AlertTitle>
          <AlertDescription>
            {t("profiles.tools.blockedNewText", {
              tools: blockedNew.tools.join(", "),
              catalog: blockedNew.catalog,
            })}
            {versionable ? (
              <>
                {" "}
                <Link
                  className="font-medium underline underline-offset-4"
                  to="/profiles/new"
                  search={{ from: profile.id, mode: "version" }}
                >
                  {t("profiles.tools.makeVersion")}
                </Link>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      <Section
        title={t("profiles.detail.settings")}
        className="[&>div:first-child]:mb-4"
      >
        {changes ? null : (
          <Text variant="meta" className="mb-3 flex items-center gap-1">
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            {t(ceiling ? "profiles.detail.ownerOnly" : "profiles.locked")}
          </Text>
        )}
        <Settings profile={profile} />
      </Section>
      <Section
        title={t("profiles.detail.audit.title")}
        className="[&>div:first-child]:mb-4"
      >
        <Audit profile={profile} />
      </Section>
      <History profile={profile} versions={lineOf(profile, items)} />
      {ceiling ? <Narrowings ceiling={profile} items={items} /> : null}
      {ceiling ? <Rollout profile={profile} operates={operates} /> : null}
      <AgentsOn profile={profile} />
      {canRetire || canBlock ? (
        <DangerZone
          title={t("workspace.danger")}
          framed={false}
          className="gap-4 [--werft-row-padding-x:0px]"
        >
          {canBlock ? (
            <DangerZoneRow
              title={t("profiles.blockRow")}
              description={t("profiles.blockRowHint")}
              actionLabel={t("profiles.block")}
              actionName={t("profiles.blockRow")}
              actionRef={focusWhen("block")}
              onAction={() => {
                setBlockError(null);
                setBlocking({ id: profile.id, block: true });
              }}
            />
          ) : null}
          {canRetire ? (
            <DangerZoneRow
              title={t("profiles.retireRow")}
              description={t("profiles.retireRowHint")}
              actionLabel={t("profiles.retire")}
              actionName={t("profiles.retireRow")}
              onAction={() => {
                setRetireError(null);
                setRetiring(profile.id);
              }}
            />
          ) : null}
        </DangerZone>
      ) : null}
      <ConfirmDialog
        open={retireOpen}
        onOpenChange={(next) => {
          if (!next && !retire.isPending) {
            setRetiring(null);
            setRetireError(null);
          }
        }}
        title={t("profiles.retireTitle", { id: profile.id })}
        consequence={t(
          ceiling ? "profiles.retireCeilingText" : "profiles.retireText",
        )}
        confirmLabel={
          retire.isPending ? t("profiles.retiring") : t("profiles.retire")
        }
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={retire.isPending}
        onConfirm={() => {
          if (retireOpen && !retire.isPending) retire.mutate(profile.id);
        }}
      >
        {retireError === null ? null : (
          <Alert variant="red" role="alert" className="border-0">
            <AlertDescription>{retireError}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={blockOpen}
        onOpenChange={(next) => {
          if (!next && !block.isPending) {
            setBlocking(null);
            setBlockError(null);
          }
        }}
        title={t(
          blockAction ? "profiles.blockTitle" : "profiles.unblockTitle",
          {
            id: profile.id,
          },
        )}
        consequence={t(
          blockAction ? "profiles.blockText" : "profiles.unblockText",
        )}
        confirmLabel={
          block.isPending
            ? t(blockAction ? "profiles.blocking" : "profiles.unblocking")
            : t(blockAction ? "profiles.block" : "profiles.unblock")
        }
        cancelLabel={t("common.cancel")}
        tone={blockAction ? "danger" : "default"}
        busy={block.isPending}
        onConfirm={() => {
          if (blockOpen && !block.isPending)
            block.mutate({ id: profile.id, block: blockAction });
        }}
      >
        {blockError === null ? null : (
          <Alert variant="red" role="alert" className="border-0">
            <AlertDescription>{blockError}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </Page>
  );
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono [overflow-wrap:anywhere]">{children}</span>;
}

function ProfileLink({ id }: { readonly id: string }) {
  return (
    <Link
      className="font-mono underline-offset-4 hover:underline [overflow-wrap:anywhere]"
      to="/profiles/$profileId"
      params={{ profileId: id }}
    >
      {id}
    </Link>
  );
}

function Settings({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  const list = (values: readonly string[], none: string) =>
    values.length === 0 ? (
      none
    ) : (
      <span className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="mono">
            {value}
          </Badge>
        ))}
      </span>
    );
  const ceiling = profile.installation;
  const item = (id: string, label: string, value: ReactNode) => ({
    id,
    label,
    value,
  });
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          item("id", t("profiles.detail.id"), <Mono>{profile.id}</Mono>),
          ...(profile.installation?.derived_from
            ? [
                item(
                  "base",
                  t("profiles.editor.base"),
                  <ProfileLink id={profile.installation.derived_from} />,
                ),
              ]
            : []),
          ...(ceiling
            ? [
                item(
                  "connection",
                  t("profiles.ceiling.connection"),
                  ceiling.connection_id === null ? (
                    t("profiles.state.connection_missing")
                  ) : (
                    <Mono>{ceiling.connection_id}</Mono>
                  ),
                ),
              ]
            : []),
          item(
            "runtime",
            t("profiles.ceiling.runtime"),
            <Mono>{`${profile.runtime_kind} ${profile.runtime_version}`}</Mono>,
          ),
          item(
            "model",
            t("profiles.editor.defaultModel"),
            <Mono>{profile.model}</Mono>,
          ),
          item(
            "models",
            t("profiles.detail.models"),
            list(profile.models, t("profiles.noTools")),
          ),
          ...(ceiling
            ? [
                item(
                  "title-model",
                  t("profiles.ceiling.titleModel"),
                  ceiling.title_model === null ? (
                    t("profiles.detail.titleModelDefault")
                  ) : (
                    <Mono>{ceiling.title_model}</Mono>
                  ),
                ),
              ]
            : []),
          item(
            "deny",
            t("profiles.tools.blocked"),
            profile.deny == null
              ? t("profiles.tools.allowList")
              : list(profile.deny, t("profiles.tools.noneBlocked")),
          ),
          ...(profile.mcp_deny?.length
            ? [
                item(
                  "mcp-deny",
                  t("profiles.tools.mcp.blocked"),
                  list(profile.mcp_deny, t("profiles.tools.noneBlocked")),
                ),
              ]
            : []),
          item(
            "tools",
            t("profiles.tools.running"),
            list(profile.tools, t("profiles.noTools")),
          ),
          item(
            "mode",
            t("profiles.editor.permissionMode"),
            <Mono>{profile.permission_mode}</Mono>,
          ),
          item(
            "billing",
            t("profiles.detail.billing"),
            t(`profiles.billing.${profile.billing}`),
          ),
          ...(ceiling
            ? [
                item(
                  "claude-md",
                  t("profiles.ceiling.claudeMd"),
                  t(
                    ceiling.project_settings.claude_md
                      ? "profiles.on"
                      : "profiles.off",
                  ),
                ),
              ]
            : []),
        ]}
      />
    </div>
  );
}

function Audit({ profile }: { readonly profile: ProfileSummary }) {
  const { t, locale } = useI18n();
  const me = useMe()?.user?.id;
  const record = profile.installation ?? profile.workspace;
  const imported = profile.installation?.origin === "catalog";
  const who = (id: string | null | undefined) =>
    id === null || id === undefined ? (
      t(
        imported
          ? "profiles.detail.audit.imported"
          : "profiles.detail.audit.unknown",
      )
    ) : (
      <Mono>{id === me ? t("profiles.detail.audit.you", { id }) : id}</Mono>
    );
  if (record === undefined) return null;
  const previous = profile.installation?.previous_id;
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          ...(profile.installation
            ? [
                {
                  id: "origin",
                  label: t("profiles.detail.audit.origin"),
                  value: t(`profiles.origin.${profile.installation.origin}`),
                },
              ]
            : []),
          {
            id: "created-by",
            label: t("profiles.detail.audit.createdBy"),
            value: who(record.created_by),
          },
          {
            id: "created-at",
            label: t("profiles.detail.created"),
            value: formatTimestamp(record.created_at, locale),
          },
          ...(profile.installation
            ? [
                {
                  id: "previous",
                  label: t("profiles.detail.audit.previous"),
                  value: previous ? (
                    <ProfileLink id={previous} />
                  ) : (
                    t("profiles.detail.audit.noPrevious")
                  ),
                },
              ]
            : []),
          ...(record.retired_at
            ? [
                {
                  id: "retired-by",
                  label: t("profiles.detail.audit.retiredBy"),
                  value: who(record.retired_by),
                },
                {
                  id: "retired-at",
                  label: t("profiles.detail.retiredAt"),
                  value: formatTimestamp(record.retired_at, locale),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

function History({
  profile,
  versions,
}: {
  readonly profile: ProfileSummary;
  readonly versions: readonly ProfileSummary[];
}) {
  const { t, locale } = useI18n();
  const rows = [...versions].sort(
    (a, b) =>
      (
        b.installation?.created_at ??
        b.workspace?.created_at ??
        ""
      ).localeCompare(
        a.installation?.created_at ?? a.workspace?.created_at ?? "",
      ) || versionOf(b) - versionOf(a),
  );
  return (
    <Section
      title={t("profiles.detail.history.title")}
      className="[&>div:first-child]:mb-4"
      description={t(
        profile.installation
          ? "profiles.detail.history.ceilingDescription"
          : "profiles.workspace.description",
      )}
    >
      <GridTable
        className="[--werft-row-padding-x:0px]"
        aria-label={t("profiles.detail.history.title")}
        columns={HISTORY_COLUMNS[0]}
        narrowAt={640}
        narrowColumns={HISTORY_COLUMNS[1]}
        framed={false}
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("profiles.detail.history.version")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("profiles.column.state")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("profiles.detail.created")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {rows.map((item) => {
          const state = stateOf(item);
          const created =
            item.installation?.created_at ?? item.workspace?.created_at;
          return (
            <GridTableRow key={item.id}>
              <GridTableCell>
                <GridTableRowOpener
                  asChild
                  aria-label={t("profiles.open", { name: item.id })}
                >
                  <Link
                    to="/profiles/$profileId"
                    params={{ profileId: item.id }}
                  />
                </GridTableRowOpener>
                <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                  <span className="leading-5">
                    <Text as="span" weight="medium">
                      {item.workspace
                        ? t("profiles.versionTag", {
                            version: versionOf(item),
                          })
                        : t("profiles.detail.history.named", {
                            name: profileName(item),
                            version: versionOf(item),
                          })}
                    </Text>
                    {item.id === profile.id ? (
                      <Text as="span" variant="meta">
                        {" "}
                        {t("profiles.detail.history.current")}
                      </Text>
                    ) : null}
                  </span>
                  <Code className="text-muted-foreground wrap-anywhere">
                    {item.id}
                  </Code>
                </div>
              </GridTableCell>
              <GridTableCell>
                <Badge variant={STATE_BADGE[state]}>
                  {t(`profiles.state.${state}`)}
                </Badge>
              </GridTableCell>
              <GridTableCell hideNarrow>
                <Text as="span" variant="meta">
                  {created ? formatTimestamp(created, locale) : "—"}
                </Text>
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
    </Section>
  );
}

/** The workspace profiles made on a ceiling. */
function Narrowings({
  ceiling,
  items,
}: {
  readonly ceiling: ProfileSummary;
  readonly items: readonly ProfileSummary[];
}) {
  const { t } = useI18n();
  const rows = items.filter(
    (item) => item.installation?.derived_from === ceiling.id,
  );
  return (
    <Section
      title={t("profiles.detail.narrowings.title")}
      className="[&>div:first-child]:mb-4"
      badge={
        rows.length === 0 ? null : (
          <Badge variant="gray">
            {t("profiles.count", { count: rows.length })}
          </Badge>
        )
      }
      description={t("profiles.detail.narrowings.description")}
    >
      {rows.length === 0 ? (
        <EmptyState title={t("profiles.detail.narrowings.empty")} />
      ) : (
        <GridTable
          className="[--werft-row-padding-x:0px]"
          aria-label={t("profiles.detail.narrowings.title")}
          columns={HISTORY_COLUMNS[0]}
          narrowAt={640}
          narrowColumns={HISTORY_COLUMNS[1]}
          framed={false}
        >
          <GridTableHeader>
            <GridTableColumnHeader>
              {t("profiles.column.name")}
            </GridTableColumnHeader>
            <GridTableColumnHeader>
              {t("profiles.column.state")}
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow>
              {t("profiles.column.model")}
            </GridTableColumnHeader>
          </GridTableHeader>
          {rows.map((item) => {
            const state = stateOf(item);
            return (
              <GridTableRow key={item.id}>
                <GridTableCell>
                  <GridTableRowOpener
                    asChild
                    aria-label={t("profiles.open", { name: item.id })}
                  >
                    <Link
                      to="/profiles/$profileId"
                      params={{ profileId: item.id }}
                    />
                  </GridTableRowOpener>
                  <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                    <Text as="span" weight="medium" className="wrap-anywhere">
                      {t("profiles.detail.history.named", {
                        name: profileName(item),
                        version: versionOf(item),
                      })}
                    </Text>
                    <Code className="text-muted-foreground wrap-anywhere">
                      {item.id}
                    </Code>
                  </div>
                </GridTableCell>
                <GridTableCell>
                  <Badge variant={STATE_BADGE[state]}>
                    {t(`profiles.state.${state}`)}
                  </Badge>
                </GridTableCell>
                <GridTableCell hideNarrow>
                  <Code className="wrap-anywhere">{item.model}</Code>
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
      )}
    </Section>
  );
}

function Rollout({
  profile,
  operates,
}: {
  readonly profile: ProfileSummary;
  readonly operates: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [notice, setNotice] = useState<string | null>(null);
  const rollout = profile.installation?.rollout;

  const retry = useMutation<
    { retried: boolean },
    ApiError,
    { readonly agent_id: string; readonly name: string }
  >({
    mutationFn: ({ agent_id }) =>
      unwrap(
        client.POST("/v1/installation-profiles/{profile_id}/rollout/retry", {
          params: { path: { profile_id: profile.id } },
          body: { agent_id },
        }),
      ),
    onMutate: () => setNotice(null),
    onSuccess: async ({ retried }, { name }) => {
      setNotice(
        t(
          retried ? "profiles.rollout.retried" : "profiles.rollout.notRetried",
          {
            name,
          },
        ),
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setNotice(refusalText(t, failure, "workspace.manage", role)),
  });

  if (!rollout || rollout.total === 0) return null;
  return (
    <Section
      title={t("profiles.rollout.title")}
      className="[&>div:first-child]:mb-4"
      description={t("profiles.rollout.description")}
    >
      <div className="flex flex-col gap-3">
        <Text weight="medium">
          {t("profiles.rollout.progress", {
            total: rollout.total,
            applied: rollout.applied,
          })}
        </Text>
        {rollout.pending === 0 ? null : (
          <Text variant="meta">
            {t("profiles.rollout.pending", { count: rollout.pending })}
          </Text>
        )}
        {rollout.fixed_model_agents === 0 ? null : (
          <Text variant="meta">
            {t("profiles.rollout.fixedModel", {
              count: rollout.fixed_model_agents,
            })}
          </Text>
        )}
        <Notice>{notice ?? undefined}</Notice>
        {rollout.failed_agents.length === 0 ? null : (
          <GridTable
            className="[--werft-row-padding-x:0px]"
            aria-label={t("profiles.rollout.failedAgents")}
            columns="minmax(0,1fr) minmax(0,1fr) auto"
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("profiles.rollout.agent")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("profiles.rollout.reason")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                <span className="sr-only">{t("profiles.rollout.retry")}</span>
              </GridTableColumnHeader>
            </GridTableHeader>
            {rollout.failed_agents.map((failed) => (
              <GridTableRow key={failed.agent_id}>
                <GridTableCell>
                  <Link
                    className="font-medium underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                    to="/agents/$id"
                    params={{ id: failed.agent_id }}
                  >
                    {failed.name}
                  </Link>
                </GridTableCell>
                <GridTableCell>
                  <Text
                    as="span"
                    variant="meta"
                    className="[overflow-wrap:anywhere]"
                  >
                    {failed.reason}
                  </Text>
                </GridTableCell>
                <GridTableCell>
                  {operates ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retry.isPending}
                      aria-label={t("profiles.rollout.retryFor", {
                        name: failed.name,
                      })}
                      onClick={() =>
                        retry.mutate({
                          agent_id: failed.agent_id,
                          name: failed.name,
                        })
                      }
                    >
                      {t("profiles.rollout.retry")}
                    </Button>
                  ) : null}
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        )}
      </div>
    </Section>
  );
}

/** Agents whose active release names this profile. */
function AgentsOn({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  const { client } = useWerft();
  // The server refuses the list to anyone else; they ask for none.
  const lists = useHasPermission("agent.manage");
  const agents = useInfiniteQuery({
    ...agentsOnProfileQuery(client, profile.id),
    enabled: lists,
  });
  const using = agents.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Section
      title={t("profiles.detail.agents.title")}
      className="[&>div:first-child]:mb-4"
      badge={
        // A count only once every page is read; until then the footer says more.
        agents.data && !agents.hasNextPage && using.length > 0 ? (
          <Badge variant="gray">
            {t("profiles.count", { count: using.length })}
          </Badge>
        ) : null
      }
      description={t("profiles.detail.agents.description")}
    >
      {!lists ? (
        <Text variant="meta" className="flex items-center gap-1">
          <Lock aria-hidden="true" className="size-3.5 shrink-0" />
          {t("profiles.detail.agents.withheld")}
        </Text>
      ) : agents.isPending ? (
        <Skeleton width="40%" />
      ) : agents.isError ? (
        <LoadFailure
          error={agents.error}
          onRetry={() => void agents.refetch()}
        />
      ) : using.length === 0 ? (
        <EmptyState title={t("profiles.detail.agents.empty")} />
      ) : (
        <div>
          <GridTable
            className="[--werft-row-padding-x:0px]"
            aria-label={t("profiles.detail.agents.title")}
            columns={AGENT_COLUMNS}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("profiles.detail.agents.agent")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("profiles.detail.agents.release")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {using.map((agent) => (
              <GridTableRow key={agent.id}>
                <GridTableCell>
                  <GridTableRowOpener
                    asChild
                    aria-label={t("profiles.detail.agents.open", {
                      name: agent.name,
                    })}
                  >
                    <Link
                      to="/agents/$id"
                      params={{ id: agent.id }}
                      search={{ tab: "release" }}
                    />
                  </GridTableRowOpener>
                  <Text
                    as="span"
                    weight="medium"
                    className="[overflow-wrap:anywhere]"
                  >
                    {agent.name}
                  </Text>
                </GridTableCell>
                <GridTableCell>
                  {/* As the release tab names it. */}
                  <Text as="span" variant="meta" numeric>
                    {agent.summary?.release_label ?? "?"}
                  </Text>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
          <PagedListFooter list={agents} />
        </div>
      )}
    </Section>
  );
}
