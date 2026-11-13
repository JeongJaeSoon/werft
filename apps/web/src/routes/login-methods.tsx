import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  ListMyLoginMethodsResponse,
  MyLoginMethod,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Code,
  ConfirmDialog,
  EmptyState,
  Page,
  RelativeTime,
  SettingRow,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";
import { Action } from "./login-providers.tsx";

/**
 * The `state` of the link this tab left for the provider with, so the
 * callback of that flow, and of no other, knows where back is.
 */
export const LINK_FLOW_KEY = "ap.loginMethodLink";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The callback of a link that went through; said on this screen. */
    readonly loginMethodLinked?: boolean;
  }
}

const listKey = (client: ApiClient) => scopedKey(client, "my-login-methods");

export function myLoginMethodsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: listKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/auth/me/login-methods"),
      ) as Promise<ListMyLoginMethodsResponse>,
    retry: false,
    // Whether this session may change anything turns false on its own.
    staleTime: 0,
  });
}

/** The words for a refused change: the server's reason first. */
function refusal(t: Translate, error: ApiError): string {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  if (reason === "session_too_old") return t("loginMethods.reason.stale");
  if (reason === "last_login_method") return t("loginMethods.reason.last");
  return t(errorKey(error.code));
}

const nameOf = (t: Translate, method: MyLoginMethod) =>
  method.kind === "password"
    ? t("loginMethods.password")
    : (method.provider?.display_name ?? t("loginMethods.providerGone"));

/**
 * The signed-in person's own ways to sign in: what is linked, what can be,
 * and removing one. The server allows a change only from a session made in
 * the last ten minutes and says so in `can_change`.
 */
export function LoginMethodsScreen() {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const { leave } = useAppServices();
  const queryClient = useQueryClient();
  const list = useQuery(myLoginMethodsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [removing, setRemoving] = useState<MyLoginMethod | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // Back from a link that went through. Read from the history entry and not
  // from a mark taken once: on its way in from the callback this screen
  // mounts twice, and the second mount would find such a mark spent. Said
  // after the render, so the live region has a change to announce.
  const justLinked = useLocation({
    select: (location) => location.state.loginMethodLinked === true,
  });
  useEffect(() => {
    if (justLinked)
      setOutcome({ kind: "notice", text: t("loginMethods.done.linked") });
  }, [justLinked, t]);
  // The entry stops saying it with the first thing the person does here, so
  // Back or a reload after that does not bring the notice over newer news.
  const acted = () => {
    setOutcome(null);
    if (justLinked)
      void navigate({
        to: ".",
        replace: true,
        state: ({ loginMethodLinked: _, ...rest }) => rest,
      });
  };
  // A refusal is often news: the session grew old, a provider went off.
  const reread = () =>
    queryClient.invalidateQueries({ queryKey: listKey(client) });

  const link = useMutation<{ authorization_url: string }, ApiError, string>({
    mutationFn: (providerId) =>
      unwrap(
        client.POST("/v1/auth/me/login-methods/{provider_id}/link/start", {
          params: { path: { provider_id: providerId } },
        }),
      ),
    onSuccess: ({ authorization_url }) => {
      try {
        sessionStorage.setItem(
          LINK_FLOW_KEY,
          new URL(authorization_url).searchParams.get("state") ?? "",
        );
      } catch {
        // Without it the callback's way back is the login page's.
      }
      leave(authorization_url);
    },
    onError: (error) => {
      setOutcome({
        kind: "error",
        text:
          error.code === "NOT_FOUND"
            ? t("loginMethods.error.providerOff")
            : refusal(t, error),
      });
      void reread();
    },
  });
  const unlink = useMutation<
    { sessions_revoked: number },
    ApiError,
    MyLoginMethod
  >({
    mutationFn: (method) =>
      unwrap(
        client.DELETE("/v1/auth/me/login-methods/{id}", {
          params: { path: { id: method.id } },
        }),
      ),
    onSuccess: (answer) => {
      setRemoving(null);
      setOutcome({
        kind: "notice",
        text: t("loginMethods.done.unlinked", {
          count: answer.sessions_revoked,
        }),
      });
      // The row the dialog was opened from is gone with the method.
      outcomeRef.current?.focus();
    },
    onError: (error) =>
      setDialogError(
        error.code === "NOT_FOUND"
          ? t("loginMethods.error.gone")
          : refusal(t, error),
      ),
    onSettled: reread,
  });
  const busy = link.isPending || unlink.isPending;

  const body = () => {
    if (list.isPending) return <Skeleton width="60%" />;
    if (list.isError)
      return (
        <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
      );
    const { methods, linkable, can_change: canChange } = list.data;
    const stale = canChange ? undefined : t("loginMethods.reason.stale");
    const usable = methods.filter((method) => method.usable);
    // The server refuses to remove the last way that works; so does this.
    const isLast = (method: MyLoginMethod) =>
      usable.every((other) => other.id === method.id);
    return (
      <>
        {canChange ? null : (
          <Alert variant="amber" role="status">
            <AlertDescription>{t("loginMethods.stale")}</AlertDescription>
          </Alert>
        )}
        <SettingsSection
          title={t("loginMethods.section.mine")}
          rows={methods.map((method) => (
            <SettingRow
              key={method.id}
              title={nameOf(t, method)}
              badge={
                method.usable ? undefined : (
                  <Badge variant="amber">{t("loginMethods.off")}</Badge>
                )
              }
              meta={
                <>
                  {method.issuer ? (
                    <Code className="wrap-anywhere">{method.issuer}</Code>
                  ) : null}
                  {method.email_at_link ? (
                    <Text as="span" variant="meta" className="wrap-anywhere">
                      {method.email_at_link}
                    </Text>
                  ) : null}
                  <Text as="span" variant="meta">
                    {method.last_login_at ? (
                      <>
                        {t("loginMethods.lastLogin")}{" "}
                        <RelativeTime
                          value={method.last_login_at}
                          locale={locale}
                        />
                      </>
                    ) : (
                      t("loginMethods.neverUsed")
                    )}
                  </Text>
                </>
              }
              actions={
                <Action
                  label={t("loginMethods.unlink")}
                  name={t("loginMethods.unlinkNamed", {
                    name: nameOf(t, method),
                  })}
                  reason={
                    stale ??
                    (isLast(method) ? t("loginMethods.reason.last") : undefined)
                  }
                  busy={busy}
                  onClick={() => {
                    acted();
                    setDialogError(null);
                    setRemoving(method);
                  }}
                />
              }
            />
          ))}
        />
        <SettingsSection
          title={t("loginMethods.section.linkable")}
          description={t("loginMethods.section.linkableHint")}
          rows={
            linkable.length === 0
              ? undefined
              : linkable.map((provider) => (
                  <SettingRow
                    key={provider.id}
                    title={provider.display_name}
                    actions={
                      <Action
                        label={t("loginMethods.link")}
                        name={t("loginMethods.linkNamed", {
                          name: provider.display_name,
                        })}
                        reason={stale}
                        busy={busy}
                        onClick={() => {
                          acted();
                          link.mutate(provider.id);
                        }}
                      />
                    }
                  />
                ))
          }
        >
          {linkable.length === 0 ? (
            <EmptyState framed title={t("loginMethods.linkable.none")} />
          ) : null}
        </SettingsSection>
      </>
    );
  };

  return (
    <Page
      title={t("loginMethods.title")}
      description={t("loginMethods.description")}
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <div ref={outcomeRef} tabIndex={-1} className="outline-none">
          <OutcomeLine outcome={outcome} live />
        </div>
        {body()}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("loginMethods.unlinkTitle", {
          name: removing ? nameOf(t, removing) : "",
        })}
        consequence={t(
          removing?.kind === "password"
            ? "loginMethods.unlinkConsequence.password"
            : "loginMethods.unlinkConsequence",
        )}
        target={removing?.email_at_link ?? undefined}
        confirmLabel={t("loginMethods.unlink")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={unlink.isPending}
        onConfirm={() => {
          if (removing) unlink.mutate(removing);
        }}
      >
        {dialogError ? (
          <Alert variant="red" role="alert">
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        ) : null}
      </ConfirmDialog>
    </Page>
  );
}
