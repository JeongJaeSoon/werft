import {
  type UseQueryResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type { GitHubSettingsResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  SettingsSection,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { FormError } from "../components/auth-page.tsx";
import { focusBack, RowMenu, RowMenuItem } from "../components/row-menu.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { githubSettingsKey } from "./workspace-github-access.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";
import { storeOff } from "./workspace-slack.tsx";

export function githubSettingsQuery(client: ApiClient, workspaceId: string) {
  return {
    queryKey: githubSettingsKey(client, workspaceId),
    queryFn: (): Promise<GitHubSettingsResponse> =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  };
}

/** Whether people can link their GitHub account in this workspace. */
export function userLinkReady(settings: GitHubSettingsResponse | undefined) {
  const oauth = settings?.oauth;
  return Boolean(
    oauth?.client_id && oauth.client_secret_set && oauth.callback_url,
  );
}

/**
 * Members link their GitHub accounts through an author App's user
 * authorization. Saving the secret is not proof it works, so the line says
 * only whether it is set; a failed link is told to the member linking.
 */
export function GitHubUserLinkRow({
  settings,
  onOutcome,
}: {
  readonly settings: UseQueryResult<GitHubSettingsResponse>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [dialog, setDialog] = useState<"secret" | "callback" | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const selectId = useId();
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const show = (next: "secret" | "callback", from: HTMLElement | null) => {
    setOpener(from);
    setDialog(next);
  };
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: githubSettingsKey(client, workspaceId),
    });

  const choose = useMutation<unknown, ApiError, string>({
    mutationFn: (connectionId) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings/user-link-app", {
          params: { path: { id: workspaceId } },
          body: { connection_id: connectionId },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: () => {
      setSwitching(null);
      onOutcome({ kind: "notice", text: t("githubUserLink.appChosen") });
      void refresh();
    },
    onError: (error) => {
      setSwitching(null);
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      });
      void refresh();
    },
  });

  const data = settings.data;
  if (!data) return null;
  const oauth = data.oauth;
  const authors = data.connections.filter(
    (connection) => connection.role === "author",
  );
  const chosen = authors.find(
    (connection) => connection.connection_id === oauth.connection_id,
  );
  const ready = userLinkReady(data);
  const controls = (
    <>
      {canManage && authors.length > 1 ? (
        <NativeSelect
          id={selectId}
          size="sm"
          aria-label={t("githubUserLink.appLabel")}
          className="w-auto"
          value={oauth.connection_id ?? ""}
          disabled={choose.isPending}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) return;
            // Another App's secret is entered again: ask while one is set.
            if (oauth.client_secret_set) setSwitching(next);
            else choose.mutate(next);
          }}
        >
          {oauth.connection_id ? null : (
            <NativeSelectOption value="" disabled>
              {t("githubUserLink.appChoose")}
            </NativeSelectOption>
          )}
          {authors.map((connection) => (
            <NativeSelectOption
              key={connection.connection_id}
              value={connection.connection_id}
            >
              {connection.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <Badge variant={ready ? "green" : "amber"}>
        {t(ready ? "githubUserLink.on" : "githubUserLink.setupNeeded")}
      </Badge>
      {canManage && (oauth.client_id || oauth.callback_url) ? (
        <RowMenu label={t("githubUserLink.menu")}>
          {(close) => (
            <>
              {oauth.client_id ? (
                <RowMenuItem onSelect={() => show("secret", close())}>
                  {t(
                    oauth.client_secret_set
                      ? "githubUserLink.replace"
                      : "githubUserLink.enter",
                  )}
                </RowMenuItem>
              ) : null}
              {oauth.callback_url ? (
                <RowMenuItem onSelect={() => show("callback", close())}>
                  {t("githubUserLink.callbackView")}
                </RowMenuItem>
              ) : null}
            </>
          )}
        </RowMenu>
      ) : null}
    </>
  );

  return (
    <SettingsSection
      title={t("githubUserLink.title")}
      description={
        chosen
          ? t("githubUserLink.via", { name: chosen.name })
          : t(
              authors.length > 1
                ? "githubUserLink.choose"
                : "githubUserLink.noApp",
            )
      }
      actions={controls}
    >
      <SecretDialog
        open={dialog === "secret"}
        clientId={oauth.client_id}
        opener={opener}
        onClose={() => setDialog(null)}
        onOutcome={onOutcome}
        onSaved={() => void refresh()}
      />
      <Dialog
        open={dialog === "callback"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent onCloseAutoFocus={focusBack(opener)}>
          <DialogHeader>
            <DialogTitle>{t("githubUserLink.callback")}</DialogTitle>
            <DialogDescription>
              {t("githubUserLink.callbackHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <Text
              as="div"
              mono
              className="min-w-0 flex-1 [overflow-wrap:anywhere]"
            >
              {oauth.callback_url}
            </Text>
            {oauth.callback_url ? (
              <CopyButton
                value={oauth.callback_url}
                variant="outline"
                size="sm"
                label={t("githubUserLink.copy")}
                copiedLabel={t("githubUserLink.copied")}
                description={t("githubUserLink.callback")}
              />
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog(null)}
            >
              {t("common.done")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={switching !== null}
        onOpenChange={(open) => {
          if (!open) setSwitching(null);
        }}
        title={t("githubUserLink.switchTitle")}
        consequence={t("githubUserLink.switchBody")}
        confirmLabel={t("githubUserLink.switchConfirm")}
        cancelLabel={t("common.cancel")}
        busy={choose.isPending}
        onConfirm={() => {
          if (switching && !choose.isPending) choose.mutate(switching);
        }}
      />
    </SettingsSection>
  );
}

/** The client secret, typed once and never shown again, not even in part. */
function SecretDialog({
  open,
  clientId,
  opener,
  onClose,
  onOutcome,
  onSaved,
}: {
  readonly open: boolean;
  /** The App the secret is typed for: another one meanwhile is refused. */
  readonly clientId: string | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOutcome: OnOutcome;
  readonly onSaved: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const save = useMutation<
    unknown,
    ApiError,
    { clientId: string; secret: string }
  >({
    // The variables hold the secret; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: ({ clientId: id, secret }) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings/oauth-client-secret", {
          params: { path: { id: workspaceId } },
          body: { client_id: id, client_secret: secret },
        }),
      ),
    onMutate: () => setError(null),
    onSuccess: () => {
      close();
      onOutcome({ kind: "notice", text: t("githubUserLink.saved") });
      onSaved();
    },
    onError: (failure) => {
      setError(
        storeOff(failure)
          ? t("workspace.tokenStoreUnavailable")
          : refusalText(t, failure, "workspace.manage", role),
      );
      // Another App by now: its client id shows before a secret is typed again.
      if (failure.code === "REVISION_CONFLICT") onSaved();
    },
  });
  function close() {
    setMissing(false);
    setError(null);
    onClose();
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("client_secret");
    const secret = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (secret === "") {
      setMissing(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setMissing(false);
    if (save.isPending || clientId === null) return;
    // Out of the DOM before the request goes, so nothing keeps it after.
    form.reset();
    save.mutate({ clientId, secret }, { onSettled: () => save.reset() });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent onCloseAutoFocus={focusBack(opener)}>
        <DialogHeader>
          <DialogTitle>{t("githubUserLink.secret")}</DialogTitle>
          <DialogDescription>
            {t("githubUserLink.secretHint")}
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : <FormError>{error}</FormError>}
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor={inputId}>
              {t("githubUserLink.secret")}
            </FieldLabel>
            <Input
              id={inputId}
              name="client_secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              aria-invalid={missing || undefined}
              onChange={() => {
                if (missing) setMissing(false);
              }}
            />
            <FieldDescription id={hintId}>
              {t("githubUserLink.secretInputHint")}
            </FieldDescription>
            {missing ? (
              <FieldError>{t("githubUserLink.secretMissing")}</FieldError>
            ) : null}
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" aria-disabled={save.isPending || undefined}>
              {t("githubUserLink.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
