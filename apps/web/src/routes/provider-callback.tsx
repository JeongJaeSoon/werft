import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type ApiError, CSRF_HEADER_VALUE, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import { Text, Link as TextLink } from "@werft-ai/ui";
import { useEffect, useRef } from "react";
import { AuthPage, FormError } from "../components/auth-page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { POST_LOGIN_PATH_KEY, safeRedirect } from "./login.tsx";

export interface ProviderCallbackSearch {
  readonly code?: string;
  readonly state?: string;
  readonly iss?: string;
}

export function providerCallbackSearch(
  search: Record<string, unknown>,
): ProviderCallbackSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const code = pick(search.code);
  const state = pick(search.state);
  const iss = pick(search.iss);
  return {
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
    ...(iss ? { iss } : {}),
  };
}

function refusalKey(error: ApiError): MessageKey {
  if (error.code === "UNAUTHORIZED") return "login.provider.rejected";
  if (error.code === "FORBIDDEN") return "login.provider.forbidden";
  // The callback route answers 404 when the provider is gone or turned off.
  if (error.code === "NOT_FOUND") return "login.provider.unavailable";
  return errorKey(error.code);
}

function takePostLoginPath(): string {
  try {
    const stored = sessionStorage.getItem(POST_LOGIN_PATH_KEY);
    sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
    return safeRedirect(stored) ?? "/";
  } catch {
    return "/";
  }
}

/**
 * Where a login provider sends the browser back: the redirect URI registered
 * with it is this path, with the provider's id in it. The code, state and
 * `iss` go to the API as they came; the flow cookie it set at the start
 * proves this browser began the sign-in with this provider.
 */
export function ProviderCallbackScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { providerId } = useParams({ from: "/auth/callback/$providerId" });
  const { code, state, iss } = useSearch({
    from: "/auth/callback/$providerId",
  });
  const sent = useRef(false);

  const finish = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/oidc/callback", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: {
            provider_id: providerId,
            code: code ?? "",
            state: state ?? "",
            ...(iss ? { iss } : {}),
          },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: takePostLoginPath(), replace: true });
    },
  });

  // The code is single use: a second POST (a re-render, StrictMode) would be
  // refused and hide the first one's answer.
  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    finish.mutate();
  }, [code, state, finish]);

  const failure = !code || !state ? "login.provider.cancelled" : null;
  return (
    <AuthPage title={t("login.provider.title")}>
      {failure || finish.error ? (
        <>
          <FormError>
            {t(failure ?? refusalKey(finish.error as ApiError))}
          </FormError>
          <Text variant="sub">
            <TextLink asChild underline="always">
              <Link to="/login">{t("login.provider.backToLogin")}</Link>
            </TextLink>
          </Text>
        </>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </AuthPage>
  );
}
