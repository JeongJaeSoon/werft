import { useMutation } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubAppRole,
  GitHubSettingsConnection,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Link,
  RadioGroup,
  RadioGroupItem,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { GITHUB_APP_ID_MAX } from "../auth/limits.ts";
import { FormError } from "../components/auth-page.tsx";
import { focusBack } from "../components/row-menu.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { NewAppForm } from "./workspace-github-new-app.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";
import { storeOff } from "./workspace-slack.tsx";

// GitHub's own limit is far below this; the server refuses past it anyway.
const KEY_FILE_MAX_BYTES = 16_384;
const PRIVATE_KEYS_DOC =
  "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps";

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

function keyRefusal(t: Translate, error: ApiError, role?: string): string {
  switch (reasonOf(error)) {
    case "invalid_private_key":
      return t("github.invalidKey");
    case "same_app":
      return t("github.add.sameApp");
    case "no_author_app":
      return t("github.add.noAuthorApp");
    case "github_app_rejected":
      return t("github.rejected");
    case "github_unreachable":
      return t("github.saveUnreachable");
    default:
      return storeOff(error)
        ? t("workspace.tokenStoreUnavailable")
        : refusalText(t, error, "workspace.manage", role);
  }
}

type KeyBody = { readonly appId: number; readonly privateKey: string };

/**
 * A dialog's own error line: the page's outcome line sits behind the
 * overlay. Notices still go to the page, where the dialog closed to.
 */
function useDialogError(onOutcome: OnOutcome) {
  const [error, setError] = useState<string | null>(null);
  const route: OnOutcome = (outcome) => {
    if (outcome?.kind === "error") setError(outcome.text);
    else {
      setError(null);
      onOutcome(outcome);
    }
  };
  const line = error === null ? null : <FormError>{error}</FormError>;
  return { route, line, clear: () => setError(null) };
}

/**
 * App ID and .pem: the file is read only on submit, and the key is held
 * nowhere once the attempt ends. `appId` fixed: a new key of that App.
 */
function KeyForm({
  appId,
  intro,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  onOutcome,
}: {
  readonly appId?: number | undefined;
  readonly intro?: ReactNode;
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (body: KeyBody, done: () => void) => void;
  readonly onCancel: () => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const [missing, setMissing] = useState<"appId" | "appIdRange" | "key" | null>(
    null,
  );
  const ids = {
    appId: useId(),
    appIdHint: useId(),
    key: useId(),
    keyHint: useId(),
  };
  const submitting = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget.elements;
    const idInput = form.namedItem("app_id");
    const keyInput = form.namedItem("private_key");
    const id =
      appId ??
      Number(idInput instanceof HTMLInputElement ? idInput.value.trim() : "");
    const file =
      keyInput instanceof HTMLInputElement ? keyInput.files?.[0] : undefined;
    if (!Number.isInteger(id) || id <= 0 || id > GITHUB_APP_ID_MAX) {
      setMissing(id > GITHUB_APP_ID_MAX ? "appIdRange" : "appId");
      if (idInput instanceof HTMLInputElement) idInput.focus();
      return;
    }
    if (file === undefined || file.size === 0) {
      setMissing("key");
      if (keyInput instanceof HTMLInputElement) keyInput.focus();
      return;
    }
    setMissing(null);
    if (file.size > KEY_FILE_MAX_BYTES) {
      onOutcome({ kind: "error", text: t("github.invalidKey") });
      return;
    }
    // Reading the file yields, so `busy` alone lets a second submit in.
    if (busy || submitting.current) return;
    submitting.current = true;
    const privateKey = await file.text();
    onSubmit({ appId: id, privateKey }, () => {
      submitting.current = false;
    });
  };

  return (
    <form
      className="flex w-full flex-col gap-4"
      noValidate
      onSubmit={(event) =>
        void submit(event).catch(() => {
          submitting.current = false;
          onOutcome({ kind: "error", text: t("github.invalidKey") });
        })
      }
    >
      {intro}
      {appId === undefined ? (
        <Field>
          <FieldLabel htmlFor={ids.appId}>{t("github.appId")}</FieldLabel>
          <Input
            id={ids.appId}
            className="max-w-80"
            name="app_id"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-describedby={ids.appIdHint}
            aria-invalid={missing?.startsWith("appId") || undefined}
          />
          <FieldDescription id={ids.appIdHint}>
            {t("github.appIdHint")}
          </FieldDescription>
          {missing === "appId" ? (
            <FieldError>{t("github.appIdMissing")}</FieldError>
          ) : missing === "appIdRange" ? (
            <FieldError>{t("github.appIdRange")}</FieldError>
          ) : null}
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor={ids.key}>{t("github.key")}</FieldLabel>
        <Input
          id={ids.key}
          name="private_key"
          type="file"
          accept=".pem,application/x-pem-file"
          aria-describedby={ids.keyHint}
          aria-invalid={missing === "key" || undefined}
          onChange={() => {
            if (missing === "key") setMissing(null);
          }}
        />
        <FieldDescription id={ids.keyHint}>
          {t("github.keyHint")}
        </FieldDescription>
        {missing === "key" ? (
          <FieldError>{t("github.keyMissing")}</FieldError>
        ) : null}
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" aria-disabled={busy || undefined}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export type AddAppStep = "choose" | "new" | "existing";

/**
 * Adding a GitHub App: a new one made from a manifest, or one that already
 * exists, as a writing or a review App. Choosing review says what letting
 * one agent write and approve means.
 */
export function AddAppDialog({
  step,
  onStep,
  blocked,
  opener,
  onOutcome,
  onAdded,
}: {
  /** Null: closed. */
  readonly step: AddAppStep | null;
  readonly onStep: (step: AddAppStep | null) => void;
  readonly opener: HTMLElement | null;
  /** No console origin: GitHub has nowhere to send a manifest back. */
  readonly blocked: boolean;
  readonly onOutcome: OnOutcome;
  readonly onAdded: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [appRole, setAppRole] = useState<GitHubAppRole>("author");
  const roleId = useId();
  const own = useDialogError(onOutcome);
  const add = useMutation<
    unknown,
    ApiError,
    KeyBody & { readonly role: GitHubAppRole }
  >({
    // The variables hold the private key; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: (body) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/github-apps", {
          params: { path: { id: workspaceId } },
          body: {
            role: body.role,
            app_id: body.appId,
            private_key: body.privateKey,
          },
        }),
      ),
    onMutate: () => own.route(null),
    onSuccess: () => {
      close();
      onOutcome({ kind: "notice", text: t("github.add.saved") });
      onAdded();
    },
    onError: (error) =>
      own.route({ kind: "error", text: keyRefusal(t, error, role) }),
  });
  function close() {
    onStep(null);
    setAppRole("author");
    own.clear();
  }

  return (
    <Dialog
      open={step !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[36rem]"
        onCloseAutoFocus={focusBack(opener)}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              step === "new"
                ? "github.newApp"
                : step === "existing"
                  ? "github.add.existing"
                  : "github.add.title",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              step === "new"
                ? "github.newAppHint"
                : step === "existing"
                  ? "github.add.existingHint"
                  : "github.add.hint",
            )}
          </DialogDescription>
        </DialogHeader>
        {own.line}
        {step === "choose" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onStep("existing")}
            >
              {t("github.add.existing")}
            </Button>
            <Button type="button" onClick={() => onStep("new")}>
              {t("github.newApp")}
            </Button>
          </div>
        ) : step === "new" ? (
          <NewAppForm
            workspaceId={workspaceId}
            blocked={blocked}
            onCancel={close}
            onOutcome={own.route}
          />
        ) : step === "existing" ? (
          <KeyForm
            busy={add.isPending}
            submitLabel={t("github.connect")}
            onCancel={close}
            onOutcome={own.route}
            intro={
              <>
                <FieldSet>
                  <FieldLegend id={roleId} variant="label">
                    {t("github.add.role")}
                  </FieldLegend>
                  <RadioGroup
                    value={appRole}
                    onValueChange={(value) =>
                      setAppRole(value === "reviewer" ? "reviewer" : "author")
                    }
                    aria-labelledby={roleId}
                  >
                    <RoleOption value="author" />
                    <RoleOption value="reviewer" />
                  </RadioGroup>
                </FieldSet>
                {appRole === "reviewer" ? (
                  <Alert variant="amber">
                    <AlertTitle>{t("github.add.riskTitle")}</AlertTitle>
                    <AlertDescription>{t("github.add.risk")}</AlertDescription>
                  </Alert>
                ) : null}
                <Link
                  href={PRIVATE_KEYS_DOC}
                  target="_blank"
                  newTabLabel={t("github.newTab")}
                  className="w-fit text-caption"
                >
                  {t("github.privateKeysLink")}
                </Link>
              </>
            }
            onSubmit={(body, done) =>
              add.mutate(
                { ...body, role: appRole },
                {
                  onSettled: () => {
                    done();
                    add.reset();
                  },
                },
              )
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RoleOption({ value }: { readonly value: GitHubAppRole }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <Field orientation="horizontal">
      <RadioGroupItem id={id} value={value} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{t(`github.role.${value}`)}</FieldLabel>
        <FieldDescription>{t(`github.role.${value}Hint`)}</FieldDescription>
      </FieldContent>
    </Field>
  );
}

/**
 * A new private key for the same App, saved on its connection: what a
 * leaked key is swapped for while the old one still works.
 */
export function NewKeyDialog({
  connection,
  opener,
  onClose,
  onOutcome,
  onSaved,
}: {
  /** Null: closed. */
  readonly connection: GitHubSettingsConnection | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOutcome: OnOutcome;
  readonly onSaved: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const own = useDialogError(onOutcome);
  const close = () => {
    own.clear();
    onClose();
  };
  const save = useMutation<unknown, ApiError, KeyBody & { id: string }>({
    gcTime: 0,
    mutationFn: (body) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: body.id } },
          body: { app_id: body.appId, private_key: body.privateKey },
        }),
      ),
    onMutate: () => own.route(null),
    onSuccess: () => {
      close();
      onOutcome({ kind: "notice", text: t("github.newKey.saved") });
      onSaved();
    },
    onError: (error) =>
      own.route({ kind: "error", text: keyRefusal(t, error, role) }),
  });
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="sm:max-w-[32rem]"
        onCloseAutoFocus={focusBack(opener)}
      >
        <DialogHeader>
          <DialogTitle>
            {t("github.newKey.title", { name: connection?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("github.newKey.hint")}</DialogDescription>
        </DialogHeader>
        {own.line}
        {connection ? (
          <KeyForm
            appId={connection.app_id}
            busy={save.isPending}
            submitLabel={t("github.save")}
            onCancel={close}
            onOutcome={own.route}
            onSubmit={(body, done) =>
              save.mutate(
                { ...body, id: connection.connection_id },
                {
                  onSettled: () => {
                    done();
                    save.reset();
                  },
                },
              )
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
