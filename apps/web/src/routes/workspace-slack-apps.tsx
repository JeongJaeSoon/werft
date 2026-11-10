import { useIsFetching, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type { ListWorkspaceSlackAppsResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Code,
  cn,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  linkVariants,
  RelativeTime,
  RowLines,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { useEffect, useRef } from "react";
import { scopedKey } from "../api/queries.ts";
import { useHasPermission, useMe } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";

type MadeApp = ListWorkspaceSlackAppsResponse["items"][number];

export const SLACK_APPS_ANCHOR = "slack-apps";

/** The apps the console made; only owners and admins may read them. */
export function useWorkspaceSlackApps() {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  return useQuery({
    queryKey: scopedKey(client, "workspace", workspaceId, "slack-apps"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/slack/apps", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
  });
}

/**
 * The Slack apps the console made: their state, changed elsewhere. Only an
 * owner or admin reads them, so only the Slack card of one shows this.
 */
export function SlackApps() {
  const { t } = useI18n();
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const apps = useWorkspaceSlackApps();
  const anchored = useLocation({
    select: (location) => location.hash === SLACK_APPS_ANCHOR,
  });
  const loading =
    useIsFetching({ queryKey: scopedKey(client, "workspace", workspaceId) }) >
      0 ||
    (canManage && apps.isPending);
  const scrolled = useRef(false);
  // The router scrolls to the hash on render, while the cards above this one
  // are still loading and the page is too short to move; land here once
  // they have settled.
  useEffect(() => {
    if (!anchored || loading || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(SLACK_APPS_ANCHOR)?.scrollIntoView({
      block: "start",
    });
  }, [anchored, loading]);

  return (
    <SettingsSection
      id={SLACK_APPS_ANCHOR}
      titleAs="h3"
      title={t("workspace.slackApps")}
      description={t("workspace.slackAppsHint")}
      box={apps.isPending || apps.isError || apps.data.items.length === 0}
    >
      {apps.isPending ? (
        <Skeleton width="50%" />
      ) : apps.isError ? (
        <LoadFailure error={apps.error} onRetry={() => void apps.refetch()} />
      ) : apps.data.items.length === 0 ? (
        <Text variant="sub">{t("workspace.slackAppsEmpty")}</Text>
      ) : (
        <AppTable items={apps.data.items} />
      )}
    </SettingsSection>
  );
}

function AppTable({ items }: { readonly items: readonly MadeApp[] }) {
  const { t, locale } = useI18n();
  return (
    <GridTable
      aria-label={t("workspace.slackAppsList")}
      columns={COLUMNS[0]}
      narrowAt={640}
      narrowColumns={COLUMNS[1]}
      framed
    >
      <GridTableHeader>
        <GridTableColumnHeader>
          {t("workspace.slackAppsApp")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("workspace.slackAppsAgent")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("workspace.slackAppsState")}
        </GridTableColumnHeader>
        <GridTableColumnHeader align="end" hideNarrow>
          {t("workspace.slackAppsUpdated")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          <span className="sr-only">{t("workspace.slackAppsMore")}</span>
        </GridTableColumnHeader>
      </GridTableHeader>
      {items.map((item) => {
        const name =
          item.slack_app.kind === "link"
            ? t("workspace.slackAppsLinkApp")
            : t("workspace.slackAppsAgentApp", {
                name: item.agent?.name ?? t("workspace.slackAppsNoAgent"),
              });
        const updated = (
          <RelativeTime value={item.slack_app.updated_at} locale={locale} />
        );
        return (
          <GridTableRow key={item.slack_app.id}>
            <GridTableCell>
              <RowLines>
                <Text
                  as="span"
                  weight="medium"
                  className="[overflow-wrap:anywhere]"
                >
                  {name}
                </Text>
                <Code className="text-muted-foreground">
                  {item.slack_app.app_id ?? t("workspace.slackAppsNoId")}
                </Code>
                {/* Plain text: the row's details link already opens the agent.
                    GridTable's narrowAt={640}, where those columns drop. */}
                <Text
                  as="span"
                  variant="meta"
                  className="hidden [@container(max-width:640px)]:block"
                >
                  {item.agent?.name ?? t("workspace.slackAppsNoAgent")}
                  {" · "}
                  {updated}
                </Text>
              </RowLines>
            </GridTableCell>
            <GridTableCell hideNarrow className="text-muted-foreground">
              {item.agent ? (
                <Link
                  to="/agents/$id"
                  params={{ id: item.agent.id }}
                  className={cn(linkVariants(), "[overflow-wrap:anywhere]")}
                >
                  {item.agent.name}
                </Link>
              ) : (
                t("workspace.slackAppsNoAgent")
              )}
            </GridTableCell>
            <GridTableCell>
              <AppState item={item} />
            </GridTableCell>
            <GridTableCell
              align="end"
              hideNarrow
              className="text-caption text-muted-foreground"
            >
              {updated}
            </GridTableCell>
            <GridTableCell align="end">
              {item.agent ? (
                <Link
                  to="/agents/$id"
                  params={{ id: item.agent.id }}
                  search={{ tab: "settings", section: "slack" }}
                  className={linkVariants()}
                >
                  {t("workspace.slackAppsMore")}
                  <span className="sr-only">: {name}</span>
                </Link>
              ) : null}
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

function AppState({ item }: { readonly item: MadeApp }) {
  const { t } = useI18n();
  const { state, kind, secrets } = item.slack_app;
  const link = kind === "link";
  // Sign in with Slack needs the client secret; an agent app needs its bot installed.
  const connected =
    state === "created" &&
    (link ? secrets.slack_client_secret.configured : !!item.agent?.installed);
  return (
    <RowLines>
      {state === "creating" ? (
        <Badge>{t("workspace.slackAppsCreating")}</Badge>
      ) : state === "deleting" ? (
        <Badge variant="red">{t("workspace.slackAppsDeleting")}</Badge>
      ) : connected ? (
        <Badge variant="green">{t("workspace.slackAppsConnected")}</Badge>
      ) : link ? (
        <Badge>{t("workspace.slackAppsNoSecret")}</Badge>
      ) : (
        <Badge>{t("workspace.slackAppsNotInstalled")}</Badge>
      )}
      {connected ? (
        <Text as="span" variant="meta">
          {link ? t("workspace.slackAppsSignIn") : `@${item.agent?.slug}`}
        </Text>
      ) : null}
    </RowLines>
  );
}

// App, agent, state, updated, details; a phone keeps the app, the state and
// the details link, and the app cell names the agent and the time.
const COLUMNS = [
  "minmax(0,1.4fr) minmax(0,1fr) 136px 120px 64px",
  "minmax(0,1fr) 120px 64px",
] as const;
