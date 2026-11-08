import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  ConfirmDialog,
  CopyButton,
  DangerZone,
  DangerZoneRow,
  FieldError,
  Heading,
  Input,
  Link,
  RowAction,
  RowList,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useHasPermission, useMe } from "../../../auth/guard.tsx";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { useProfileDisplay } from "../../../components/profile-options.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { useAppServices } from "../../../services.tsx";
import type { Notify } from "../toast.tsx";
import { useSlackState } from "./queries.ts";
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
  manage = true,
  inPage = false,
  notify,
  invite,
}: {
  readonly agentId: string;
  /** The `/invite` line a user pastes into a channel to add the bot. */
  readonly invite?: string;
  readonly active?: boolean;
  readonly manage?: boolean;
  /** Rendered as the side list's Advanced section, below the status strip. */
  readonly inPage?: boolean;
  /** Offers app ID copy and open actions, reporting the copy through it. */
  readonly notify?: Notify;
}) {
  const { t } = useI18n();
  const profile = useProfileDisplay();
  const { client } = useWerft();
  const cache = useQueryClient();
  const me = useMe();
  // The workspace Slack screen is the workspace managers' (app-sidebar).
  const manageWorkspace = useHasPermission("workspace.manage");
  const tokenBlockId = useId();
  const { leave } = useAppServices();
  const { app, identities, key } = useSlackState(agentId);
  const [notice, setNotice] = useState("");
  const outcome = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (notice) outcome.current?.focus();
  }, [notice]);
  const [inviteManual, setInviteManual] = useState(false);
  const inviteField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inviteManual) inviteField.current?.focus();
  }, [inviteManual]);
  const [deleting, setDeleting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const identity = identities.data?.items.find(
    (item) => item.provider === "slack_bot" && item.status === "active",
  );
  const record = app.data?.slack_app;
  const appTarget = record?.app_id
    ? `${t("slack.appId")} ${record.app_id}`
    : undefined;
  // At most one reason sessions would fail, after any token issuer change.
  const warnings = app.data?.warnings ?? [];
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const connect = useMutation({
    mutationFn: async () => {
      if (!record)
        await unwrap(
          client.POST("/v1/agents/{id}/slack/app", {
            params: { path: { id: agentId } },
            body: { replace_uncertain: false },
          }),
        );
      await refresh();
      return unwrap(
        client.POST("/v1/agents/{id}/slack/install/start", {
          params: { path: { id: agentId } },
        }),
      );
    },
    onSuccess: ({ authorize_url }) => {
      leave(authorize_url);
    },
  });
  const remove = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: async () => {
      if (!record || !me?.workspace) return;
      await unwrap(
        client.DELETE("/v1/workspaces/{id}/slack/apps/{app_id}", {
          params: { path: { id: me.workspace.id, app_id: record.id } },
        }),
      );
    },
    onSuccess: async () => {
      setDeleting(false);
      setNotice(t("slack.deleted"));
      await refresh();
    },
  });
  const revoke = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: async () => {
      if (!identity) return;
      await unwrap(
        client.DELETE("/v1/agents/{id}/identities/{identity_id}", {
          params: { path: { id: agentId, identity_id: identity.id } },
        }),
      );
    },
    onSuccess: async () => {
      setRevoking(false);
      setNotice(t("slack.revoked"));
      await refresh();
    },
  });
  const recheck = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/app/events/recheck", {
          params: { path: { id: agentId } },
        }),
      ),
    onSuccess: async (read) => {
      setNotice(
        t(
          read.events.state === "verified"
            ? "slack.eventsUrl.done"
            : "slack.eventsUrl.sent",
        ),
      );
      await refresh();
    },
  });
  const readError = app.error ?? identities.error;
  const saveError =
    connect.error ?? remove.error ?? revoke.error ?? recheck.error;
  const errorText = saveError ? slackFailure(saveError, t) : "";
  if (app.isPending || identities.isPending) return <SlackSkeleton />;
  const busy =
    connect.isPending ||
    remove.isPending ||
    revoke.isPending ||
    recheck.isPending;
  const events = app.data?.events;
  const pending = record?.state === "creating" || record?.state === "deleting";
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
            {t(
              inPage || (record && identity)
                ? manage
                  ? "slack.advanced"
                  : "slack.connection"
                : "slack.app",
            )}
          </Heading>
          {inPage ? null : (
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
          )}
        </div>
        {warnings.map((warning) => (
          <Alert key={warning.code} variant="amber">
            <AlertTitle>{t(SLACK_WARNING_KEY[warning.code].title)}</AlertTitle>
            <AlertDescription>
              {t(SLACK_WARNING_KEY[warning.code].body, {
                profile:
                  "profile_id" in warning
                    ? profile.show(warning.profile_id)
                    : "",
                previous:
                  "previous_user_id" in warning ? warning.previous_user_id : "",
                user: "user_id" in warning ? warning.user_id : "",
              })}
            </AlertDescription>
          </Alert>
        ))}
        {record && (record.app_id || manage) ? (
          <RowList variant="joined">
            {record.app_id ? (
              <SettingRow
                title={t("slack.appId")}
                meta={<Code>{record.app_id}</Code>}
                actions={
                  notify ? (
                    <RowAction asChild>
                      <Link
                        href={`https://api.slack.com/apps/${encodeURIComponent(record.app_id)}`}
                        target="_blank"
                        newTabLabel={t("slack.newTab")}
                        className="text-inherit hover:no-underline"
                      >
                        {t("slack.openInSlack")}
                      </Link>
                    </RowAction>
                  ) : null
                }
              />
            ) : null}
            {invite && notify && identity ? (
              <SettingRow
                title={t("slack.inviteTitle")}
                description={t("slack.inviteHint")}
                meta={<Code>{invite}</Code>}
                actions={
                  <>
                    <CopyButton
                      value={invite}
                      variant="outline"
                      size="sm"
                      aria-label={t("slack.copyInvite")}
                      label={t("slack.copy")}
                      icon="copy"
                      iconClassName="stroke-[1.5]"
                      fallbackField={inviteField}
                      onResult={(ok) => {
                        setInviteManual(!ok);
                        notify(t(ok ? "slack.copied" : "slack.copyFailed"));
                      }}
                    />
                    {inviteManual ? (
                      <Input
                        ref={inviteField}
                        readOnly
                        value={invite}
                        size={invite.length}
                        aria-label={t("slack.inviteCommand")}
                        className="h-8 w-auto px-2 font-mono text-caption"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    ) : null}
                  </>
                }
              />
            ) : null}
            {!inPage && record.app_id && identity ? (
              <SettingRow
                title={t("slack.botId")}
                meta={<Code>{identity.bot_user_id}</Code>}
              />
            ) : null}
            {manage ? (
              <SettingRow
                title={t(identity ? "slack.reinstallTitle" : "slack.install")}
                description={t(
                  identity ? "slack.reinstallHint" : "slack.installHint",
                )}
                actions={
                  <>
                    <RowAction
                      disabled={
                        busy ||
                        pending ||
                        Boolean(app.error || identities.error)
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
            ) : null}
            {manage &&
            identity &&
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
        {/* In the page, the status section above reports a failed read. */}
        {readError && !inPage ? (
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
                <RouterLink to="/settings/workspace/slack">
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
          onConfirm={() => remove.mutate()}
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
          onConfirm={() => revoke.mutate()}
        >
          {revoke.error ? (
            <FieldError>{slackFailure(revoke.error, t)}</FieldError>
          ) : null}
        </ConfirmDialog>
      </section>
      {manage && record ? (
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
