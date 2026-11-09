import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  InstallationProfileState,
  ProfileSummary,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  buttonVariants,
  Code,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Page,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { ChevronDown, ChevronRight, Lock, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { profilesQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import {
  pickable,
  profileName,
  versionOf,
} from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { settingsConnectionsQuery } from "./settings-entries.tsx";

// Name, version, base, default model, permission mode, blocked tools,
// state; a phone keeps the name and the state, and the name cell says the version.
const COLUMNS = [
  "minmax(0,1.6fr) 64px minmax(0,1fr) minmax(0,1fr) 128px 72px 152px",
  "minmax(0,1fr) 128px",
] as const;

export type ProfileState = WorkspaceProfileState | InstallationProfileState;

export const STATE_BADGE: Record<ProfileState, "green" | "red" | "gray"> = {
  usable: "green",
  base_changed: "red",
  base_missing: "red",
  retired: "gray",
  base_retired: "gray",
  base_blocked: "red",
  blocked: "red",
  connection_missing: "red",
  unattended_off: "red",
  definition_drift: "red",
  runtime_unsupported: "red",
};

export const stateOf = (profile: ProfileSummary): ProfileState =>
  profile.workspace?.state ?? profile.installation?.state ?? "usable";

export { profileName, versionOf };

/**
 * The versions of one line, newest first; each group's head is its latest.
 * A line is a `previous_id` chain, which may change name (a catalog import's
 * next version takes one) while another profile may share a name without
 * being linked.
 */
function groupsOf(items: readonly ProfileSummary[]): ProfileSummary[][] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const line = (item: ProfileSummary): { key: string; rank: number } => {
    let at = item;
    let rank = 0;
    for (
      let prev = byId.get(at.installation?.previous_id ?? "");
      prev && rank < items.length;
      prev = byId.get(at.installation?.previous_id ?? "")
    ) {
      at = prev;
      rank += 1;
    }
    return { key: `operator:${at.id}`, rank };
  };
  const groups = new Map<string, { rank: number; item: ProfileSummary }[]>();
  for (const item of items) {
    const { key, rank } = line(item);
    const group = groups.get(key);
    if (group) group.push({ rank, item });
    else groups.set(key, [{ rank, item }]);
  }
  return [...groups.values()]
    .map((group) =>
      group.sort((a, b) => b.rank - a.rank).map(({ item }) => item),
    )
    .sort(([a], [b]) =>
      a && b
        ? profileName(a).localeCompare(profileName(b)) ||
          a.id.localeCompare(b.id)
        : 0,
    );
}

export function ProfilesScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const profiles = useQuery(profilesQuery(client));
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  // Only the one who can manage connections reads them or gets a link to them.
  const owns = useHasPermission("installation.settings.manage");
  // Pending and failed are unknown, not zero: only a loaded answer with no
  // active connection says one is missing.
  const connections = useQuery({
    ...settingsConnectionsQuery(client, owns),
    select: (page) => !page.items.some((item) => item.state === "active"),
  });
  // A refetch that failed keeps the cached data, so success is checked too.
  const noActiveConnection = connections.isSuccess && connections.data;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const items = profiles.data?.items ?? [];
  const ceilings = items.filter((item) => item.source === "operator");
  const groups = groupsOf(items);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Page
      title={t("profiles.title")}
      description={t("profiles.description")}
      actions={
        manages || operates ? (
          // An owner makes a profile from nothing; an admin clones one.
          operates || ceilings.some(pickable) ? (
            <Link className={buttonVariants()} to="/profiles/new">
              <Plus aria-hidden="true" />
              {t("profiles.create")}
            </Link>
          ) : null
        ) : null
      }
    >
      {profiles.isPending ? (
        <Skeleton width="60%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-[var(--werft-space-block)]">
          {manages ? null : (
            <Text variant="meta" className="flex items-center gap-1">
              <Lock aria-hidden="true" className="size-3.5 shrink-0" />
              {t("profiles.locked")}
            </Text>
          )}
          {groups.length === 0 ? (
            <EmptyState
              title={t("profiles.empty")}
              {...(owns && noActiveConnection
                ? {
                    description: t("profiles.empty.noConnection"),
                    action: (
                      <Link
                        className={buttonVariants({ variant: "outline" })}
                        to="/settings/workspace/model-connections"
                      >
                        {t("profiles.new.goToConnections")}
                      </Link>
                    ),
                  }
                : {})}
            />
          ) : (
            <GridTable
              className="[--werft-row-padding-x:0px]"
              aria-label={t("profiles.title")}
              columns={COLUMNS[0]}
              narrowAt={860}
              narrowColumns={COLUMNS[1]}
              framed={false}
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.name")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow>
                  {t("profiles.column.version")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow>
                  {t("profiles.column.base")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow>
                  {t("profiles.column.model")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow>
                  {t("profiles.editor.permissionMode")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow>
                  {t("profiles.column.blocked")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.state")}
                </GridTableColumnHeader>
              </GridTableHeader>
              {groups.flatMap(([latest, ...older]) => {
                if (latest === undefined) return [];
                const open = expanded.has(latest.id);
                return [latest, ...(open ? older : [])].map((item) => (
                  <ProfileRow
                    key={item.id}
                    profile={item}
                    older={
                      item === latest && older.length > 0
                        ? {
                            count: older.length,
                            expanded: open,
                            onToggle: () => toggle(latest.id),
                          }
                        : undefined
                    }
                  />
                ));
              })}
            </GridTable>
          )}
        </div>
      )}
    </Page>
  );
}

function ProfileRow({
  profile,
  older,
}: {
  readonly profile: ProfileSummary;
  /** On the latest version of a name that has earlier ones. */
  readonly older:
    | {
        readonly count: number;
        readonly expanded: boolean;
        readonly onToggle: () => void;
      }
    | undefined;
}) {
  const { t } = useI18n();
  const state = stateOf(profile);
  const Chevron = older?.expanded ? ChevronDown : ChevronRight;
  return (
    <GridTableRow>
      <GridTableCell>
        <GridTableRowOpener
          asChild
          aria-label={t("profiles.open", { name: profile.id })}
        >
          <Link to="/profiles/$profileId" params={{ profileId: profile.id }} />
        </GridTableRowOpener>
        <Stack
          first={
            <>
              <Text as="span" weight="medium">
                {profileName(profile)}
              </Text>
              {older ? (
                <>
                  {" "}
                  <button
                    type="button"
                    aria-expanded={older.expanded}
                    onClick={older.onToggle}
                    // Inline, so a narrow column wraps it between words like
                    // the name beside it instead of pushing into the next column.
                    // Positioned above the row opener, which covers the row.
                    className="relative z-1 inline break-keep rounded-control text-left text-caption text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <Chevron
                      aria-hidden="true"
                      className="mr-0.5 inline size-3.5 align-[-2px]"
                    />
                    {t("profiles.olderVersions", { count: older.count })}
                  </button>
                </>
              ) : null}
            </>
          }
          second={profileName(profile) === profile.id ? null : profile.id}
          secondMono
          narrow={t("profiles.versionTag", { version: versionOf(profile) })}
        />
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta">
          {t("profiles.versionTag", { version: versionOf(profile) })}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Code className="wrap-anywhere">
          {profile.installation?.derived_from ?? "—"}
        </Code>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Code className="wrap-anywhere">{profile.model}</Code>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Code>{profile.permission_mode}</Code>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta">
          {profile.deny == null
            ? "—"
            : t("profiles.blockedCount", { count: profile.deny.length })}
        </Text>
      </GridTableCell>
      <GridTableCell>
        <Badge variant={STATE_BADGE[state]}>
          {t(`profiles.state.${state}`)}
        </Badge>
      </GridTableCell>
    </GridTableRow>
  );
}

// Not GridTableCell `lines`, which truncates: on a phone every value wraps
// in full instead.
function Stack({
  first,
  second,
  secondMono = false,
  narrow,
}: {
  readonly first: ReactNode;
  /** Null when the first line already is the id. */
  readonly second: string | null;
  readonly secondMono?: boolean;
  /** A third line only a phone shows, for the columns it hides. */
  readonly narrow: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
      <span className="wrap-anywhere leading-5">{first}</span>
      {second === null ? null : (
        <Text
          as="span"
          variant="meta"
          mono={secondMono}
          className="wrap-anywhere"
        >
          {second}
        </Text>
      )}
      {/* GridTable's narrowAt={860} breakpoint, the width the columns drop at. */}
      <Text
        as="span"
        variant="meta"
        className="hidden wrap-anywhere [@container(max-width:860px)]:block"
      >
        {narrow}
      </Text>
    </div>
  );
}
