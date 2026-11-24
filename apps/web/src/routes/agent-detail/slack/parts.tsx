import { Link as RouterLink } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ConfirmDialog,
  DangerZoneRow,
  FieldError,
  Link,
} from "@werft-ai/ui";
import { useHasPermission, useMe } from "../../../auth/guard.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import type { SlackApp } from "./actions.ts";
import { SLACK_WARNING_KEY, slackFailure } from "./shared.ts";

type Warning = NonNullable<SlackApp["app"]["data"]>["warnings"][number];

/** At most one reason sessions would fail, after any token issuer change. */
export function SlackWarnings({
  warnings,
}: {
  readonly warnings: readonly Warning[];
}) {
  const { t } = useI18n();
  return warnings.map((warning) => (
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
  ));
}

/** Why the create button is off: the workspace's token is missing or unusable. */
export function SlackTokenBlock({
  id,
  block,
}: {
  readonly id: string;
  readonly block: "unset" | "needs_reentry";
}) {
  const { t } = useI18n();
  const manageWorkspace = useHasPermission("workspace.manage");
  return (
    <p id={id} className="m-0 text-muted-foreground">
      <span>{t(`slack.configToken.${block}`)}</span>{" "}
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
  );
}

const REMOVAL = {
  delete: {
    mutation: "remove",
    title: "slack.delete",
    consequence: "slack.deleteWarning",
  },
  revoke: {
    mutation: "revoke",
    title: "slack.revoke",
    consequence: "slack.revokeWarning",
  },
} as const;

/** Confirms deleting the app, or disconnecting it from Slack. */
export function SlackRemovalDialog({
  slack,
  action,
  open,
  onOpenChange,
}: {
  readonly slack: SlackApp;
  readonly action: keyof typeof REMOVAL;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const words = REMOVAL[action];
  const mutation = slack[words.mutation];
  const appId = slack.record?.app_id;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(words.title)}
      consequence={t(words.consequence)}
      target={appId ? `${t("slack.appId")} ${appId}` : undefined}
      confirmLabel={t(words.title)}
      cancelLabel={t("common.cancel")}
      tone="danger"
      busy={mutation.isPending}
      onConfirm={() =>
        mutation.mutate(undefined, { onSuccess: () => onOpenChange(false) })
      }
    >
      {mutation.error ? (
        <FieldError>{slackFailure(mutation.error, t)}</FieldError>
      ) : null}
    </ConfirmDialog>
  );
}

/** The danger zone's rows: disconnect while installed, then delete. */
export function SlackDangerRows({
  slack,
  onRevoke,
  onDelete,
}: {
  readonly slack: SlackApp;
  readonly onRevoke: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const { record, identity, busy } = slack;
  return (
    <>
      {identity ? (
        <DangerZoneRow
          title={t("slack.revokeTitle")}
          description={t("slack.revokeWarning")}
          actionLabel={t("slack.revoke")}
          disabled={busy}
          onAction={onRevoke}
        />
      ) : null}
      <DangerZoneRow
        title={t("slack.deleteTitle")}
        description={t("slack.deleteWarning")}
        actionLabel={t("workspace.delete")}
        // A delete that failed in Werft leaves the app "deleting";
        // asking again is how it finishes.
        disabled={busy || record?.state === "creating" || !me?.workspace}
        onAction={onDelete}
      />
    </>
  );
}
