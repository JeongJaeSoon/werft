import { Link as RouterLink } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Code,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  FieldError,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  RelativeTime,
  RowAction,
  RowLines,
  SettingRow,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useHasPermission, useMe } from "../../../auth/guard.tsx";
import {
  RowMenu,
  RowMenuItem,
  RowMenuLink,
} from "../../../components/row-menu.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import type { SlackActionSite, SlackApp } from "./actions.ts";
import {
  EVENTS_BADGE,
  RECHECK_ID,
  SECTION,
  SECTION_TARGET,
  slackFailure,
  slackState,
} from "./shared.ts";

/*
 * The sections this tab shares with Integrations > Slack, under the same
 * names and in the same order: the token the app is made with, the address
 * Slack calls, the app the console made. There they are the workspace's
 * connection; here, what this agent uses.
 */

/** The outcome of the last action, said in the section of its button. */
function Outcome({
  slack,
  at,
}: {
  readonly slack: SlackApp;
  readonly at: SlackActionSite;
}) {
  const ref = useRef<HTMLOutputElement>(null);
  const notice = slack.noticeAt(at);
  useEffect(() => {
    if (notice) ref.current?.focus();
  }, [notice]);
  return (
    <output
      ref={ref}
      tabIndex={-1}
      aria-live="polite"
      className={notice ? "text-control outline-none" : "sr-only"}
    >
      {notice}
    </output>
  );
}

/** A failed action, beside its button; the confirm dialogs say their own. */
function SaveError({ error }: { readonly error: unknown }) {
  const { t } = useI18n();
  return error ? (
    <div>
      <FieldError>{slackFailure(error, t)}</FieldError>
    </div>
  ) : null;
}

/** Integrations > Slack's "Slack app creation", as this agent sees it. */
export function SlackTokenSection({ slack }: { readonly slack: SlackApp }) {
  const { t } = useI18n();
  const manageWorkspace = useHasPermission("workspace.manage");
  // An older API sends no state; say nothing rather than guess.
  const state = slack.app.data?.config_token;
  return (
    <SettingsSection
      id={SECTION.token}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("workspace.tokenSection")}
      description={t("slack.tokenHint")}
      rows={
        slack.app.isPending ? (
          <SettingRow title={<Skeleton width="50%" />} />
        ) : (
          <SettingRow
            title={t("workspace.token")}
            badge={
              state === "active" ? (
                <Badge variant="green">{t("workspace.tokenActive")}</Badge>
              ) : state === "needs_reentry" ? (
                <Badge variant="red">{t("workspace.tokenNeedsReentry")}</Badge>
              ) : state === "unset" ? (
                <Badge>{t("workspace.tokenUnset")}</Badge>
              ) : null
            }
            description={
              state === "unset"
                ? t("workspace.tokenUnsetHint")
                : state === "needs_reentry"
                  ? t("workspace.tokenNeedsReentryHint")
                  : undefined
            }
            actions={
              manageWorkspace ? (
                <RowAction asChild>
                  <RouterLink to="/settings/workspace/integrations/slack">
                    {t("slack.tokenManage")}
                  </RouterLink>
                </RowAction>
              ) : state === "active" ? null : (
                <Text as="span" variant="sub">
                  {t("slack.configToken.askAdmin")}
                </Text>
              )
            }
          />
        )
      }
    />
  );
}

/** Integrations > Slack's "Addresses for a Slack app": this agent's one. */
export function SlackAddressSection({ slack }: { readonly slack: SlackApp }) {
  const { t } = useI18n();
  const { app, record, identity, busy, pending, recheck } = slack;
  const url = record ? app.data?.event_url : null;
  const events = app.data?.events;
  return (
    <SettingsSection
      id={SECTION.addresses}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("workspace.addressesTitle")}
      description={t("slack.addressesHint")}
      box={!url}
      foot={
        url ? (
          <div className="flex flex-col gap-2">
            <SaveError error={recheck.error} />
            <Outcome slack={slack} at="address" />
          </div>
        ) : undefined
      }
      rows={
        url && events ? (
          <SettingRow
            title={t("workspace.addressEvents")}
            meta={<Code className="[overflow-wrap:anywhere]">{url}</Code>}
            badge={
              // Apps checked before the URL was recorded have none.
              events.url === null && events.state === "pending" ? (
                <Badge variant="gray">{t("slack.eventsUrl.unsent")}</Badge>
              ) : (
                <Badge variant={EVENTS_BADGE[events.state]}>
                  {t(`slack.eventsUrl.${events.state}`)}
                </Badge>
              )
            }
            description={t("slack.eventsUrl.hint")}
            actions={
              // Slack sends the check to an installed app only.
              identity && record?.state === "created" ? (
                <RowAction
                  id={RECHECK_ID}
                  disabled={busy || pending}
                  onClick={() => recheck.mutate()}
                >
                  {recheck.isPending
                    ? t("slack.working")
                    : t("slack.eventsUrl.recheck")}
                </RowAction>
              ) : null
            }
          />
        ) : undefined
      }
    >
      {url ? null : app.isPending ? (
        <Skeleton width="50%" />
      ) : (
        <Text variant="sub">{t("slack.addressesNone")}</Text>
      )}
    </SettingsSection>
  );
}

/** Integrations > Slack's "Slack apps made here": the one for this agent. */
export function SlackAppSection({
  slack,
  name,
  active,
}: {
  readonly slack: SlackApp;
  /** The agent's name, which the app is listed under. */
  readonly name: string;
  readonly active: boolean;
}) {
  const { t, locale } = useI18n();
  const manageWorkspace = useHasPermission("workspace.manage");
  const tokenBlockId = useId();
  const { app, identities, identity, record, connect, busy, pending } = slack;
  const refreshing = busy || app.isFetching || identities.isFetching;
  const section = (body: ReactNode, rest: { foot?: ReactNode } = {}) => (
    <SettingsSection
      id={SECTION.app}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("workspace.slackApps")}
      description={t("slack.appsHint")}
      box={!record}
      {...rest}
    >
      {body}
    </SettingsSection>
  );
  if (app.isPending || identities.isPending)
    return section(<Skeleton width="50%" />);
  if (!record) {
    // An older API sends no state; leave the create error to say why.
    const configToken = app.data?.config_token;
    const tokenBlock =
      configToken === "unset" || configToken === "needs_reentry"
        ? configToken
        : null;
    // No app yet: the way to make one lives in the empty box.
    return section(
      <div className="flex flex-col items-start gap-3">
        <Text variant="sub">{t("slack.appsEmpty")}</Text>
        {!active ? <Text variant="sub">{t("slack.activateFirst")}</Text> : null}
        <div className="flex flex-wrap gap-2">
          {/* The card above reports a failed read. */}
          {!slack.readError ? (
            <Button
              type="button"
              disabled={!active || busy || tokenBlock !== null}
              aria-describedby={tokenBlock ? tokenBlockId : undefined}
              onClick={() => connect.mutate()}
            >
              {connect.isPending
                ? t("slack.working")
                : t("slack.createInstall")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={() => void slack.refresh()}
          >
            {t("slack.refresh")}
          </Button>
        </div>
        {tokenBlock ? (
          <p id={tokenBlockId} className="m-0 text-muted-foreground">
            <span>{t(`slack.configToken.${tokenBlock}`)}</span>{" "}
            {manageWorkspace ? (
              <Link asChild underline="always">
                <RouterLink to="/settings/workspace/integrations/slack">
                  {t("slack.configToken.settings")}
                </RouterLink>
              </Link>
            ) : (
              t("slack.configToken.askAdmin")
            )}
          </p>
        ) : null}
        <SaveError error={connect.error} />
        <Outcome slack={slack} at="app" />
      </div>,
    );
  }
  const appName = t("slack.appName", { name });
  const state = slackState(slack.readError, identity, record);
  const updated = <RelativeTime value={record.updated_at} locale={locale} />;
  const badge =
    record.state === "creating" ? (
      <Badge>{t("workspace.slackAppsCreating")}</Badge>
    ) : record.state === "deleting" ? (
      <Badge variant="red">{t("workspace.slackAppsDeleting")}</Badge>
    ) : (
      <Badge
        variant={
          state === "connected" ? "green" : state === "error" ? "red" : "gray"
        }
      >
        {t(`slack.state.${state}`)}
      </Badge>
    );
  return section(
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
          {t("workspace.slackAppsState")}
        </GridTableColumnHeader>
        <GridTableColumnHeader align="end" hideNarrow>
          {t("workspace.slackAppsUpdated")}
        </GridTableColumnHeader>
        <GridTableColumnHeader action>
          <span className="sr-only">{t("slack.appMenu")}</span>
        </GridTableColumnHeader>
      </GridTableHeader>
      <GridTableRow>
        <GridTableCell>
          <RowLines>
            <Text
              as="span"
              weight="medium"
              className="[overflow-wrap:anywhere]"
            >
              {appName}
            </Text>
            <Code className="text-muted-foreground">
              {record.app_id ?? t("workspace.slackAppsNoId")}
            </Code>
            {/* GridTable's narrowAt={640}, where those columns drop. */}
            <span className="hidden items-center gap-2 [@container(max-width:640px)]:flex">
              {badge}
              <Text as="span" variant="meta">
                {updated}
              </Text>
            </span>
          </RowLines>
        </GridTableCell>
        <GridTableCell hideNarrow>{badge}</GridTableCell>
        <GridTableCell
          align="end"
          hideNarrow
          className="text-caption text-muted-foreground"
        >
          {updated}
        </GridTableCell>
        <GridTableCell align="end">
          <RowAction
            disabled={busy || pending || Boolean(slack.readError)}
            aria-describedby={`${SECTION.app}-install-hint`}
            onClick={() => connect.mutate()}
          >
            {connect.isPending
              ? t("slack.working")
              : t(identity ? "slack.reinstall" : "slack.install")}
          </RowAction>
          <RowMenu label={t("slack.appMenu")}>
            {(close) => (
              <>
                {record.app_id ? (
                  <RowMenuLink
                    href={`https://api.slack.com/apps/${encodeURIComponent(record.app_id)}`}
                    newTabLabel={t("slack.newTab")}
                    onSelect={close}
                  >
                    {t("slack.openInSlack")}
                  </RowMenuLink>
                ) : null}
                <RowMenuItem
                  onSelect={() => {
                    close();
                    if (!refreshing) void slack.refresh();
                  }}
                >
                  {t("slack.refresh")}
                </RowMenuItem>
              </>
            )}
          </RowMenu>
        </GridTableCell>
      </GridTableRow>
    </GridTable>,
    {
      foot: (
        <div className="flex flex-col gap-2">
          <Text id={`${SECTION.app}-install-hint`} variant="meta">
            {t(identity ? "slack.reinstallHint" : "slack.installHint")}
          </Text>
          <SaveError error={connect.error} />
          <Outcome slack={slack} at="app" />
        </div>
      ),
    },
  );
}

/** Disconnect and delete, last, while there is an app to act on. */
export function SlackDangerSection({ slack }: { readonly slack: SlackApp }) {
  const { t } = useI18n();
  const me = useMe();
  const { record, identity, busy, remove, revoke } = slack;
  const [deleting, setDeleting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  if (!record) return null;
  const appTarget = record.app_id
    ? `${t("slack.appId")} ${record.app_id}`
    : undefined;
  return (
    <>
      <DangerZone
        id={SECTION.danger}
        tabIndex={-1}
        className={SECTION_TARGET}
        title={t("slack.danger")}
        titleAs="h3"
        titleId={`${SECTION.danger}-title`}
      >
        {identity ? (
          <DangerZoneRow
            title={t("slack.revokeTitle")}
            description={t("slack.revokeWarning")}
            actionLabel={t("slack.revoke")}
            disabled={busy}
            onAction={() => setRevoking(true)}
          />
        ) : null}
        <DangerZoneRow
          title={t("slack.deleteTitle")}
          description={t("slack.deleteWarning")}
          actionLabel={t("slack.delete")}
          // A delete Slack refused leaves the app "deleting"; asking
          // again is how it finishes.
          disabled={busy || record.state === "creating" || !me?.workspace}
          onAction={() => setDeleting(true)}
        />
      </DangerZone>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("slack.delete")}
        consequence={t("slack.deleteWarning")}
        target={appTarget}
        confirmLabel={t("slack.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, { onSuccess: () => setDeleting(false) })
        }
      >
        {remove.error ? (
          <FieldError>{slackFailure(remove.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("slack.revoke")}
        consequence={t("slack.revokeWarning")}
        target={appTarget}
        confirmLabel={t("slack.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(undefined, { onSuccess: () => setRevoking(false) })
        }
      >
        {revoke.error ? (
          <FieldError>{slackFailure(revoke.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

// App, state, updated, actions; a phone keeps the app (with the state and
// the time under it) and the actions.
const COLUMNS = [
  "minmax(0,1.4fr) minmax(0,1fr) 120px 160px",
  "minmax(0,1fr) 160px",
] as const;
