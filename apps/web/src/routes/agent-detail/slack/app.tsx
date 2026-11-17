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
  RELATIVE_TIME_TRACK,
  RelativeTime,
  RowAction,
  RowLines,
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
import type { RecheckSite, SlackActionSite, SlackApp } from "./actions.ts";
import {
  EVENTS_BADGE,
  SECTION,
  SECTION_TARGET,
  STATE_BADGE,
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
export function Outcome({
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

/** Sends the Request URL to Slack again, from the given site. */
export function RecheckButton({
  slack,
  site,
}: {
  readonly slack: SlackApp;
  readonly site: RecheckSite;
}) {
  const { t } = useI18n();
  const { recheck } = slack;
  return (
    <RowAction
      disabled={slack.busy || slack.pending}
      onClick={() => recheck.mutate(site)}
    >
      {recheck.isPending && recheck.variables === site
        ? t("slack.working")
        : t("slack.eventsUrl.recheck")}
    </RowAction>
  );
}

/** A failed recheck, beside the button that asked for it. */
export function RecheckError({
  slack,
  site,
}: {
  readonly slack: SlackApp;
  readonly site: RecheckSite;
}) {
  return (
    <SaveError
      error={slack.recheck.variables === site ? slack.recheck.error : null}
    />
  );
}

/** Integrations > Slack's "Slack app creation", as this agent sees it. */
export function SlackTokenSection({ slack }: { readonly slack: SlackApp }) {
  const { t } = useI18n();
  const manageWorkspace = useHasPermission("workspace.manage");
  // An older API sends no state; say nothing rather than guess.
  const state = slack.app.data?.config_token;
  const stateHint =
    state === "unset"
      ? t("workspace.tokenUnsetHint")
      : state === "needs_reentry"
        ? t("workspace.tokenNeedsReentryHint")
        : null;
  // One token, so its state and link sit on the section's own title line.
  return (
    <SettingsSection
      id={SECTION.token}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("workspace.tokenSection")}
      badge={
        slack.app.isPending ? (
          <Skeleton className="h-4 w-20" />
        ) : state === "active" ? (
          <Badge variant="green">{t("workspace.tokenActive")}</Badge>
        ) : state === "needs_reentry" ? (
          <Badge variant="red">{t("workspace.tokenNeedsReentry")}</Badge>
        ) : state === "unset" ? (
          <Badge>{t("workspace.tokenUnset")}</Badge>
        ) : null
      }
      description={
        <>
          {t("slack.tokenHint", { token: t("workspace.token") })}
          {stateHint ? ` ${stateHint}` : null}
        </>
      }
      actions={
        manageWorkspace ? (
          <RowAction asChild>
            <RouterLink to="/settings/workspace/integrations/slack">
              {t("slack.tokenManage")}
            </RouterLink>
          </RowAction>
        ) : stateHint ? (
          // Only a known missing or unusable token; an unread or older
          // answer says nothing about it.
          <Text as="span" variant="sub">
            {t("slack.configToken.askAdmin")}
          </Text>
        ) : null
      }
    />
  );
}

/** Integrations > Slack's "Addresses for a Slack app": this agent's one. */
export function SlackAddressSection({ slack }: { readonly slack: SlackApp }) {
  const { t } = useI18n();
  const { app, record, identity } = slack;
  const url = eventUrl(slack);
  const events = app.data?.events;
  if (!url || !events) return null;
  // One address, so its state and recheck sit on the section's title line.
  return (
    <SettingsSection
      id={SECTION.addresses}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("workspace.addressesTitle")}
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
      description={t("slack.addressesHint")}
      actions={
        // Slack sends the check to an installed app only.
        identity && record?.state === "created" ? (
          <RecheckButton slack={slack} site="address" />
        ) : null
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Code className="self-start [overflow-wrap:anywhere]">{url}</Code>
        <Text variant="meta">{t("slack.eventsUrl.hint")}</Text>
        <RecheckError slack={slack} site="address" />
        <Outcome slack={slack} at="address" />
      </div>
    </SettingsSection>
  );
}

/**
 * The address Slack calls, once there is an app to put it in; a server that
 * cannot compute one sends none, and the section is left out with it.
 */
export function eventUrl(slack: SlackApp): string | null {
  return slack.record ? (slack.app.data?.event_url ?? null) : null;
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
      {...rest}
    >
      {body}
    </SettingsSection>
  );
  if (app.isPending || identities.isPending)
    return section(<Skeleton width="50%" />);
  // A failed read says nothing about whether the app exists; the card above
  // reports the failure, so this offers only to read again.
  if (app.data === undefined)
    return section(
      <div className="flex flex-col items-start gap-3">
        <Text variant="sub">{t("status.loadFailed")}</Text>
        <Button
          type="button"
          variant="outline"
          disabled={refreshing}
          onClick={() => void slack.refresh()}
        >
          {t("slack.refresh")}
        </Button>
      </div>,
    );
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
  const updated = (
    <RelativeTime
      value={record.updated_at}
      locale={locale}
      className="whitespace-nowrap"
    />
  );
  const badge =
    record.state === "creating" ? (
      <Badge>{t("workspace.slackAppsCreating")}</Badge>
    ) : record.state === "deleting" ? (
      <Badge variant="red">{t("workspace.slackAppsDeleting")}</Badge>
    ) : (
      <Badge variant={STATE_BADGE[state]}>{t(`slack.state.${state}`)}</Badge>
    );
  return section(
    <GridTable
      aria-label={t("workspace.slackAppsList")}
      columns={columns(locale)[0]}
      narrowAt={640}
      narrowColumns={columns(locale)[1]}
      align={["start", "start", "start", "action"]}
      framed
    >
      <GridTableHeader>
        <GridTableColumnHeader>
          {t("workspace.slackAppsApp")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("workspace.slackAppsState")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("workspace.slackAppsUpdated")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>{t("slack.appMenu")}</GridTableColumnHeader>
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
          hideNarrow
          className="text-caption text-muted-foreground"
        >
          {updated}
        </GridTableCell>
        <GridTableCell>
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
        title={t("workspace.danger")}
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
          actionLabel={t("workspace.delete")}
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
// the time under it) and the actions. The app takes the leftover; the state
// fits the longest badge ("재설치 필요" 73px, "再インストールが必要" 124px,
// "Awaiting installation" 132px).
const STATE_TRACK = { ko: "80px", ja: "128px", en: "136px" } as const;
const columns = (locale: keyof typeof RELATIVE_TIME_TRACK) =>
  [
    `minmax(0,1fr) ${STATE_TRACK[locale]} ${RELATIVE_TIME_TRACK[locale]} 160px`,
    "minmax(0,1fr) 160px",
  ] as const;
