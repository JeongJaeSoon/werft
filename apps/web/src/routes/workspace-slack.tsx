import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  PutSlackConfigTokenResponse,
  SlackConfigTokenSummary,
  SlackPublicUrls,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  cn,
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FormActions,
  formatTimestamp,
  Heading,
  IconTile,
  Input,
  Link,
  RowList,
  RowListItem,
  Skeleton,
  Steps,
  Text,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { SlackMark } from "../components/brand-marks.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { RowMenu, RowMenuItem } from "../components/row-menu.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { IntegrationsLayout } from "./integrations.tsx";
import {
  type OnOutcome,
  SETTINGS_CARD,
  SlackGuest,
} from "./workspace-settings.tsx";
import { SlackApps, useWorkspaceSlackApps } from "./workspace-slack-apps.tsx";

const SLACK_APPS_URL = "https://api.slack.com/apps";

const tokenKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "slack-config-token");

function useConfigToken() {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  return useQuery({
    queryKey: tokenKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
    retry: (failures, error) => !storeOff(error) && failures < 3,
  });
}

/**
 * Integrations › Slack, laid out like Integrations › GitHub: one Slack card (the
 * app-making token, then the apps it made) and the guest card. Until a token
 * works and no app exists, nothing else can take effect, so only the card's
 * start is shown.
 */
export function WorkspaceSlackScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const canManage = useHasPermission("workspace.manage");
  const token = useConfigToken();
  const apps = useWorkspaceSlackApps();
  // A token that does not work yet hides what depends on it until the app
  // list says whether any app already runs. A failed read, even a refetch
  // over old data, is not an empty workspace; members can read neither.
  const unready = token.status === "success" && token.data.state !== "active";
  const deciding = unready && apps.status === "pending";
  const tokenOnly =
    unready && apps.status === "success" && apps.data.items.length === 0;
  const guest = <SlackGuest onOutcome={setOutcome} />;
  return (
    <>
      <OutcomeLine outcome={outcome} />
      {/* Members can only read the guest setting; it leads for them. */}
      {canManage ? null : guest}
      <SlackCard
        start={tokenOnly && token.data?.state === "unset"}
        deciding={deciding}
        withApps={!tokenOnly && !deciding}
        onOutcome={setOutcome}
      />
      {canManage && !tokenOnly && !deciding ? guest : null}
    </>
  );
}

export function WorkspaceSlackRoute() {
  return (
    <IntegrationsLayout tab="slack">
      <WorkspaceSlackScreen />
    </IntegrationsLayout>
  );
}

/**
 * Back to the button that opened the form, else the menu, else the token's
 * heading once neither is on the page any more.
 */
const focusFirst = (...refs: RefObject<HTMLElement | null>[]) =>
  refs
    .map((ref) => ref.current)
    .find((element) => element?.isConnected)
    ?.focus();

/** Slack's mark in the tile's one colour, as GitHub's is on its card. */
function TileMark({ className }: { readonly className?: string }) {
  return (
    <SlackMark
      className={cn(
        className,
        "text-(--werft-color-tile-foreground) [&_path]:fill-current",
      )}
    />
  );
}

/**
 * The token only reads as a state and who saved it when; the value never
 * comes back. Replacing it is the same PUT as setting it the first time.
 */
function SlackCard({
  start,
  deciding,
  withApps,
  onOutcome,
}: {
  /** No token and no app yet: the card holds only the way to start. */
  readonly start: boolean;
  /** Whether `start` applies is not known yet. */
  readonly deciding: boolean;
  /** The apps the token made, under the token. */
  readonly withApps: boolean;
  readonly onOutcome: OnOutcome;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const apps = useWorkspaceSlackApps();
  const titleId = useId();
  const tokenTitleId = useId();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The visible register button, when the row has one.
  const actionRef = useRef<HTMLButtonElement>(null);
  // The ⋯ button the form or the delete dialog was opened from.
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const tokenHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasEditing = useRef(false);
  // Saving or deleting can swap the button that held the focus for another.
  const focusOnState = useRef<"save" | "delete" | null>(null);
  const token = useConfigToken();
  const summary = token.data;
  // The form replaces the button that opened it; focus returns to that
  // button when the form closes, unless the user already moved on.
  useEffect(() => {
    if (
      !editing &&
      wasEditing.current &&
      document.activeElement === document.body
    )
      focusFirst(actionRef, menuRef, tokenHeadingRef);
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    const after = focusOnState.current;
    if (summary?.state && after) {
      focusOnState.current = null;
      // Only when the focus went with what was swapped out (or sits in the
      // closing delete dialog), not when the user moved elsewhere.
      const at = document.activeElement;
      if (
        !at ||
        at === document.body ||
        !at.isConnected ||
        (after === "delete" &&
          at.closest('[role="dialog"], [role="alertdialog"]'))
      )
        focusFirst(actionRef, menuRef, tokenHeadingRef);
    }
  }, [summary?.state]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: tokenKey(client, workspaceId) });
  const refusal = (error: ApiError) =>
    isApiError(error, "CONFIG_TOKEN_INVALID")
      ? t("workspace.tokenRejected")
      : storeOff(error)
        ? t("workspace.tokenStoreUnavailable")
        : refusalText(t, error, "workspace.manage", role);

  const save = useMutation<PutSlackConfigTokenResponse, ApiError, string>({
    // The variables hold the token; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: (value) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
          body: { value },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setFormError(null);
    },
    onSuccess: async (stored) => {
      if (summary?.state !== "active") focusOnState.current = "save";
      // The answer is the new summary; show it before the re-read lands.
      const { receipt_id: _receipt, warnings: _warnings, ...next } = stored;
      queryClient.setQueryData<SlackConfigTokenSummary>(
        tokenKey(client, workspaceId),
        next,
      );
      setEditing(false);
      // The PUT itself is Slack's check: say who Slack says issued it.
      const verified = stored.issuer
        ? t("workspace.tokenVerified", {
            team: stored.issuer.team_id,
            user: stored.issuer.user_id,
          })
        : t("workspace.tokenStored");
      onOutcome({
        kind: "notice",
        text:
          stored.warnings.length > 0
            ? `${verified} ${t("workspace.tokenIssuerChanged")}`
            : verified,
      });
      // Not awaited: the reset that drops the value waits for this callback.
      void refresh();
    },
    onError: (error) => {
      setFormError(refusal(error));
      // A lost answer may still have spent the pasted token; read the state.
      void refresh();
    },
  });
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setDeleting(false);
      focusOnState.current = "delete";
      onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
      await refresh();
    },
    onError: async (error) => {
      setDeleting(false);
      // Another tab or person deleted it first: the token is gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        const again = await token.refetch();
        if (again.data?.state === "unset") {
          focusOnState.current = "delete";
          onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
          return;
        }
      }
      onOutcome({ kind: "error", text: refusal(error) });
    },
  });

  const close = () => {
    setFormError(null);
    setEditing(false);
  };
  const form = editing ? (
    <TokenForm
      pending={save.isPending}
      error={formError}
      onCancel={close}
      onSubmit={(value) => {
        if (!save.isPending) {
          // Detach the observer so gcTime 0 drops the attempt and its value.
          save.mutate(value, { onSettled: () => save.reset() });
        }
      }}
    />
  ) : null;

  const status = !canManage
    ? permissionReason(t, "workspace.manage", role)
    : start
      ? t("workspace.slackNone")
      : apps.isSuccess
        ? t("workspace.slackCount", { count: apps.data.items.length })
        : " ";

  const onEdit = (menu: HTMLButtonElement | null) => {
    menuRef.current = menu;
    setEditing(true);
  };
  const onDelete = (menu: HTMLButtonElement | null) => {
    menuRef.current = menu;
    setDeleting(true);
  };

  const body = !canManage ? null : start ? (
    <div className="flex flex-col items-start gap-3">
      <Text weight="medium">{t("workspace.slackEmpty")}</Text>
      <Text variant="sub">{t("workspace.slackEmptyHint")}</Text>
      {form ?? (
        <Button ref={actionRef} type="button" onClick={() => setEditing(true)}>
          {t("workspace.tokenAdd")}
        </Button>
      )}
    </div>
  ) : (
    <>
      <section aria-labelledby={tokenTitleId} className="flex flex-col gap-2">
        <Heading
          id={tokenTitleId}
          ref={tokenHeadingRef}
          level={3}
          tabIndex={-1}
          className="focus-visible:outline-none"
        >
          {t("workspace.tokenSection")}
        </Heading>
        <RowList variant="joined" framed={false} aria-labelledby={tokenTitleId}>
          {token.isPending || deciding ? (
            <RowListItem>
              <Skeleton width="50%" />
            </RowListItem>
          ) : token.isError ? (
            <>
              <RowListItem>
                {storeOff(token.error) ? (
                  <ErrorState
                    title={t("status.loadFailed")}
                    message={t("workspace.tokenStoreUnavailable")}
                  />
                ) : (
                  <LoadFailure
                    error={token.error}
                    onRetry={() => void token.refetch()}
                  />
                )}
              </RowListItem>
              {/* A token read before the failure can still be deleted. */}
              {summary?.configured ? (
                <RowListItem>
                  <Text as="span" weight="medium" className="flex-1" truncate>
                    {t("workspace.token")}
                  </Text>
                  <TokenMenu
                    active={false}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                </RowListItem>
              ) : null}
            </>
          ) : (
            <TokenRow
              summary={summary}
              editing={editing}
              actionRef={actionRef}
              onEdit={onEdit}
              onDelete={onDelete}
              form={form}
              locale={locale}
            />
          )}
        </RowList>
        {/* Says what the row's "last token check" means; no token, no check. */}
        {summary?.updated_at ? (
          <Text variant="meta">{t("workspace.tokenHint")}</Text>
        ) : null}
      </section>
      {summary ? (
        <SlackAddresses urls={summary.urls} onOutcome={onOutcome} />
      ) : null}
      {withApps ? <SlackApps /> : null}
    </>
  );

  return (
    <section aria-labelledby={titleId} className={SETTINGS_CARD}>
      <div className="flex items-center gap-3">
        <IconTile icon={TileMark} hue="slate" size="two-line" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Heading id={titleId} level={2}>
            Slack
          </Heading>
          <Text variant="sub">{status}</Text>
        </div>
      </div>
      <Text variant="sub" className="border-b pb-2">
        {t("workspace.slackCardHint")}
      </Text>
      {body}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("workspace.tokenDeleteTitle")}
        consequence={t("workspace.tokenDeleteHint")}
        target={summary?.last4 ? `••••${summary.last4}` : undefined}
        confirmLabel={t("workspace.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate();
        }}
      />
    </section>
  );
}

function SlackAddresses({
  urls,
  onOutcome,
}: {
  readonly urls: SlackPublicUrls;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <Heading id={titleId} level={3}>
        {t("workspace.addressesTitle")}
      </Heading>
      <Text variant="sub">{t("workspace.addressesHint")}</Text>
      <AddressField
        label={t("workspace.addressRedirect")}
        value={urls.redirect_url}
        unset={t("workspace.addressNoConsole")}
        onOutcome={onOutcome}
      />
      <AddressField
        label={t("workspace.addressEvents")}
        value={urls.events_url_template}
        unset={t(
          urls.redirect_url === null
            ? "workspace.addressNoConsole"
            : "workspace.addressNoHttps",
        )}
        hint={t("workspace.addressEventsHint")}
        onOutcome={onOutcome}
      />
    </section>
  );
}

function AddressField({
  label,
  value,
  unset,
  hint,
  onOutcome,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly unset: string;
  readonly hint?: string;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const fieldRef = useRef<HTMLInputElement>(null);
  if (value === null) {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <Text variant="sub">{unset}</Text>
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={fieldRef}
          className="font-mono sm:flex-1"
          type="text"
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
        />
        <CopyButton
          value={value}
          variant="outline"
          label={t("workspace.addressCopy")}
          description={label}
          fallbackField={fieldRef}
          onResult={(worked) =>
            onOutcome(
              worked
                ? { kind: "notice", text: t("workspace.addressCopied") }
                : { kind: "error", text: t("workspace.addressCopyFailed") },
            )
          }
        />
      </div>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/**
 * The token as one row of the card, like a GitHub App's: its details, the
 * state on the right, then the ⋯ menu. A token that cannot make apps puts
 * its register button where the menu would lead.
 */
function TokenRow({
  summary,
  editing,
  actionRef,
  onEdit,
  onDelete,
  form,
  locale,
}: {
  readonly summary: SlackConfigTokenSummary | undefined;
  readonly editing: boolean;
  readonly actionRef: RefObject<HTMLButtonElement | null>;
  readonly onEdit: (menu: HTMLButtonElement | null) => void;
  readonly onDelete: (menu: HTMLButtonElement | null) => void;
  readonly form: ReactNode;
  readonly locale: ReturnType<typeof useI18n>["locale"];
}) {
  const { t } = useI18n();
  const active = summary?.state === "active";
  const line = tokenLine(summary, t, locale);
  return (
    <RowListItem className="flex-col flex-nowrap items-stretch gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Text as="span" weight="medium" truncate>
            {t("workspace.token")}
          </Text>
          {line ? <Text variant="meta">{line}</Text> : null}
        </div>
        <TokenBadge summary={summary} />
        {active || editing ? null : (
          <Button
            ref={actionRef}
            type="button"
            size="sm"
            onClick={() => onEdit(null)}
          >
            {t(
              summary?.state === "needs_reentry"
                ? "workspace.tokenReenter"
                : "workspace.tokenAdd",
            )}
          </Button>
        )}
        {summary?.configured ? (
          <TokenMenu active={active} onEdit={onEdit} onDelete={onDelete} />
        ) : null}
      </div>
      {summary?.state === "needs_reentry" ? (
        <Text className="text-(color:--werft-tone-danger-fg)">
          {t("workspace.tokenNeedsReentryHint")}
        </Text>
      ) : null}
      {form}
    </RowListItem>
  );
}

/** Replace (a working token only) and delete, behind the row's ⋯. */
function TokenMenu({
  active,
  onEdit,
  onDelete,
}: {
  readonly active: boolean;
  readonly onEdit: (menu: HTMLButtonElement | null) => void;
  readonly onDelete: (menu: HTMLButtonElement | null) => void;
}) {
  const { t } = useI18n();
  return (
    <RowMenu label={t("workspace.tokenMenu")}>
      {(close) => (
        <>
          {active ? (
            <RowMenuItem onSelect={() => onEdit(close())}>
              {t("workspace.tokenReplace")}
            </RowMenuItem>
          ) : null}
          <RowMenuItem tone="danger" onSelect={() => onDelete(close())}>
            {t("workspace.tokenDelete")}
          </RowMenuItem>
        </>
      )}
    </RowMenu>
  );
}

/** Where to find the value in Slack, then the field that takes it. */
function TokenForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (value: string) => void;
}) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Mounted by the button that opened it; the field is where the user goes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A second paste while the first is out stays in the field.
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("token");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!value) {
      setMissing(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setMissing(false);
    // Slack spends the pasted token on the first try, so it is no use in
    // the field afterwards; keep the secret out of the DOM either way.
    if (input instanceof HTMLInputElement) input.value = "";
    onSubmit(value);
  };
  const shownError = missing ? t("workspace.tokenMissing") : error;

  return (
    <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
      <Steps
        items={[
          {
            id: "open",
            title: (
              <Link
                href={SLACK_APPS_URL}
                target="_blank"
                newTabLabel={t("slack.newTab")}
              >
                {t("workspace.tokenStepOpen")}
              </Link>
            ),
          },
          { id: "generate", title: t("workspace.tokenStepGenerate") },
          { id: "paste", title: t("workspace.tokenStepPaste") },
        ]}
      />
      <Field>
        <FieldLabel>{t("workspace.tokenNew")}</FieldLabel>
        <Input
          ref={inputRef}
          className="max-w-105"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            if (event.target.value.trim()) setMissing(false);
          }}
        />
        <FieldDescription>{t("workspace.tokenNewHint")}</FieldDescription>
        <FieldError>{shownError}</FieldError>
      </Field>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" aria-disabled={pending || undefined}>
          {t("workspace.tokenSubmit")}
        </Button>
      </FormActions>
    </form>
  );
}

function TokenBadge({
  summary,
}: {
  readonly summary: SlackConfigTokenSummary | undefined;
}) {
  const { t } = useI18n();
  if (summary?.state === "active") {
    return <Badge variant="green">{t("workspace.tokenActive")}</Badge>;
  }
  if (summary?.state === "needs_reentry") {
    return <Badge variant="red">{t("workspace.tokenNeedsReentry")}</Badge>;
  }
  return <Badge>{t("workspace.tokenUnset")}</Badge>;
}

function tokenLine(
  summary: SlackConfigTokenSummary | undefined,
  t: ReturnType<typeof useI18n>["t"],
  locale: ReturnType<typeof useI18n>["locale"],
): string | undefined {
  if (summary?.state === "unset") return t("workspace.tokenUnsetHint");
  if (!summary?.updated_at) return undefined;
  const at = formatTimestamp(summary.updated_at, locale);
  // updated_at moves on every successful exchange with Slack, registering or
  // the automatic refresh; updated_by stays the last person who registered.
  return [
    summary.last4 ? `••••${summary.last4}` : null,
    summary.issuer
      ? t("workspace.tokenTeam", { id: summary.issuer.team_id })
      : null,
    summary.issuer
      ? t("workspace.tokenIssuer", { id: summary.issuer.user_id })
      : null,
    t("workspace.tokenCheckedAt", { at }),
    summary.updated_by
      ? t("workspace.tokenRegisteredBy", {
          by: summary.updated_by.display_name,
        })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** `details.reason_code` of an error, when the server named one. */
export const reasonCodeOf = (error: unknown): string | undefined => {
  if (!isApiError(error)) return undefined;
  const code = (error.details as { reason_code?: unknown } | null)?.reason_code;
  return typeof code === "string" ? code : undefined;
};

// The API names this reason when it runs without its secret key; a retry
// cannot help, an administrator has to configure the store. Other
// non-retryable BACKEND_UNAVAILABLE answers (Slack refusing a call, an unset
// address) are not this.
export const storeOff = (error: unknown) =>
  isApiError(error, "BACKEND_UNAVAILABLE") &&
  reasonCodeOf(error) === "secret_store_off";
