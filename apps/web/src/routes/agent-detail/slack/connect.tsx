import { Link as RouterLink } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  FieldError,
  Heading,
  Link,
  RowAction,
  RowList,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useHasPermission, useMe } from "../../../auth/guard.tsx";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { useSlackApp } from "./actions.ts";
import {
  EVENTS_BADGE,
  RECHECK_ID,
  SECTION,
  SECTION_BOX,
  SLACK_WARNING_KEY,
  slackFailure,
  slackReason,
  slackState,
} from "./shared.ts";

export function SlackSkeleton() {
  return (
    <div className="flex min-h-96 flex-col gap-6" aria-busy="true">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function SlackConnect({
  agentId,
  active = true,
}: {
  readonly agentId: string;
  readonly active?: boolean;
}) {
  const { t } = useI18n();
  const me = useMe();
  // The workspace Slack screen is the workspace managers' (app-sidebar).
  const manageWorkspace = useHasPermission("workspace.manage");
  const tokenBlockId = useId();
  const slack = useSlackApp(agentId);
  const {
    app,
    identities,
    identity,
    record,
    refresh,
    connect,
    remove,
    revoke,
    recheck,
    busy,
    pending,
    notice,
  } = slack;
  const outcome = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (notice) outcome.current?.focus();
  }, [notice]);
  const [deleting, setDeleting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const appTarget = record?.app_id
    ? `${t("slack.appId")} ${record.app_id}`
    : undefined;
  // At most one reason sessions would fail, after any token issuer change.
  const warnings = app.data?.warnings ?? [];
  const { readError, saveError } = slack;
  const errorText = saveError ? slackFailure(saveError, t) : "";
  if (app.isPending || identities.isPending) return <SlackSkeleton />;
  const events = app.data?.events;
  const status = slackState(readError ?? saveError, identity, record);
  // An older API sends no state; leave the create error to say why.
  const configToken = app.data?.config_token;
  const tokenBlock =
    !record && (configToken === "unset" || configToken === "needs_reentry")
      ? configToken
      : null;
  return (
    <>
      <section
        id={SECTION.advanced}
        tabIndex={-1}
        className={SECTION_BOX}
        aria-labelledby={`${SECTION.advanced}-title`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Heading id={`${SECTION.advanced}-title`}>
            {t(record && identity ? "slack.advanced" : "slack.app")}
          </Heading>
          <Badge
            variant={
              status === "connected"
                ? "green"
                : status === "error"
                  ? "red"
                  : "gray"
            }
          >
            {t(`slack.state.${status}`)}
          </Badge>
        </div>
        {warnings.map((warning) => (
          <Alert key={warning.code} variant="amber">
            <AlertTitle>{t(SLACK_WARNING_KEY[warning.code].title)}</AlertTitle>
            <AlertDescription>
              {t(SLACK_WARNING_KEY[warning.code].body, {
                release: "release_id" in warning ? warning.release_id : "",
                previous:
                  "previous_user_id" in warning ? warning.previous_user_id : "",
                user: "user_id" in warning ? warning.user_id : "",
              })}
            </AlertDescription>
          </Alert>
        ))}
        {record ? (
          <RowList variant="joined" framed={false}>
            {record.app_id ? (
              <SettingRow
                title={t("slack.appId")}
                meta={<Code>{record.app_id}</Code>}
              />
            ) : null}
            {record.app_id && identity ? (
              <SettingRow
                title={t("slack.botId")}
                meta={<Code>{identity.bot_user_id}</Code>}
              />
            ) : null}
            <SettingRow
              title={t(identity ? "slack.reinstallTitle" : "slack.install")}
              description={t(
                identity ? "slack.reinstallHint" : "slack.installHint",
              )}
              actions={
                <>
                  <RowAction
                    disabled={
                      busy || pending || Boolean(app.error || identities.error)
                    }
                    onClick={() => connect.mutate()}
                  >
                    {connect.isPending
                      ? t("slack.working")
                      : t(identity ? "slack.reinstall" : "slack.install")}
                  </RowAction>
                  <RowAction
                    disabled={busy || app.isFetching || identities.isFetching}
                    onClick={() => void refresh()}
                  >
                    {t("slack.refresh")}
                  </RowAction>
                </>
              }
            />
            {identity &&
            record.state === "created" &&
            events &&
            app.data?.event_url ? (
              <SettingRow
                title={t("slack.eventsUrl.title")}
                description={t("slack.eventsUrl.hint")}
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
                actions={
                  <RowAction
                    id={RECHECK_ID}
                    disabled={busy || pending}
                    onClick={() => recheck.mutate()}
                  >
                    {recheck.isPending
                      ? t("slack.working")
                      : t("slack.eventsUrl.recheck")}
                  </RowAction>
                }
              />
            ) : null}
          </RowList>
        ) : null}
        <output
          ref={outcome}
          tabIndex={-1}
          aria-live="polite"
          className={notice ? "text-control" : "sr-only"}
        >
          {notice}
        </output>
        {readError ? (
          <LoadFailure
            error={readError}
            guidance={slackReason(readError, t)}
            kept={[app, identities].every(
              (read) => !read.isError || read.data !== undefined,
            )}
            onRetry={() => {
              for (const read of [app, identities])
                if (read.isError) void read.refetch();
            }}
          />
        ) : null}
        {errorText ? (
          <div>
            <FieldError>{errorText}</FieldError>
          </div>
        ) : null}
        {!active ? (
          <p className="m-0 text-muted-foreground">
            {t("slack.activateFirst")}
          </p>
        ) : null}
        {!record ? (
          <div className="flex flex-wrap gap-2">
            {!app.error && !identities.error ? (
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
              disabled={busy || app.isFetching || identities.isFetching}
              onClick={() => void refresh()}
            >
              {t("slack.refresh")}
            </Button>
          </div>
        ) : null}
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
      </section>
      {record ? (
        <DangerZone
          id={SECTION.danger}
          tabIndex={-1}
          className={SECTION_BOX}
          title={t("slack.danger")}
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
            disabled={busy || record?.state === "creating" || !me?.workspace}
            onAction={() => setDeleting(true)}
          />
        </DangerZone>
      ) : null}
    </>
  );
}
