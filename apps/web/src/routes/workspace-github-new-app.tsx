import { useMutation } from "@tanstack/react-query";
import {
  Link as RouterLink,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  CompleteGitHubAppManifestResponse,
  StartGitHubAppManifestResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Link,
  Page,
  RadioGroup,
  RadioGroupItem,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import type { Translate } from "../i18n/i18n.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

const GITHUB_WEB = "https://github.com/";
// GitHub's rule for organization logins.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

/**
 * Sends the browser to GitHub with the manifest as a form POST, the only way
 * GitHub takes one. Swapped out in tests.
 */
export const githubNavigation = {
  post(actionUrl: string, manifest: string) {
    const form = document.createElement("form");
    form.method = "post";
    form.action = actionUrl;
    form.hidden = true;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "manifest";
    field.value = manifest;
    form.append(field);
    document.body.append(form);
    form.submit();
  },
  assign(url: string) {
    window.location.assign(url);
  },
};

/** The manifest flow's first half: what to make, then off to GitHub. */
export function NewAppForm({
  workspaceId,
  blocked,
  onCancel,
  onOutcome,
}: {
  readonly workspaceId: string;
  /** Why the server cannot make one; the form says so and does not submit. */
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const [owner, setOwner] = useState<"organization" | "user">("organization");
  const [scope, setScope] = useState<"private" | "public">("private");
  const [actions, setActions] = useState(false);
  const [loginMissing, setLoginMissing] = useState(false);
  const loginRef = useRef<HTMLInputElement>(null);
  const handedOff = useRef(false);
  const ids = {
    owner: useId(),
    org: useId(),
    user: useId(),
    login: useId(),
    scope: useId(),
    private: useId(),
    public: useId(),
    actions: useId(),
    blocked: useId(),
  };
  useEffect(() => {
    loginRef.current?.focus();
    // Back from GitHub may restore this page from the bfcache with the lock set.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) handedOff.current = false;
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const start = useMutation<
    StartGitHubAppManifestResponse,
    ApiError,
    { login: string | null }
  >({
    mutationFn: ({ login }) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/github-apps/author/manifest", {
          params: { path: { id: workspaceId } },
          body: {
            owner:
              login === null
                ? { kind: "user" }
                : { kind: "organization", login },
            public: scope === "public",
            actions,
            replace: false,
          },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (started) => {
      // The server names the URL; only GitHub's own pages get the manifest.
      if (!started.action_url.startsWith(GITHUB_WEB)) {
        onOutcome({ kind: "error", text: t("status.loadFailed") });
        return;
      }
      // The page is leaving; a second click would only mint another state.
      handedOff.current = true;
      githubNavigation.post(started.action_url, started.manifest);
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text:
          reasonOf(error) === "console_origin_unset"
            ? t("github.newApp.blocked")
            : refusalText(t, error, "workspace.manage", role),
      }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || start.isPending || handedOff.current) return;
    const login = loginRef.current?.value.trim() ?? "";
    if (owner === "organization" && !LOGIN.test(login)) {
      setLoginMissing(true);
      loginRef.current?.focus();
      return;
    }
    setLoginMissing(false);
    start.mutate({ login: owner === "organization" ? login : null });
  };

  return (
    <form className="flex w-full flex-col gap-5" noValidate onSubmit={submit}>
      <FieldSet>
        <FieldLegend id={ids.owner} variant="label">
          {t("github.newApp.owner")}
        </FieldLegend>
        <RadioGroup
          value={owner}
          onValueChange={(value) =>
            setOwner(value === "user" ? "user" : "organization")
          }
          aria-labelledby={ids.owner}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={ids.org} value="organization" />
            <FieldContent>
              <FieldLabel htmlFor={ids.org}>
                {t("github.newApp.org")}
              </FieldLabel>
              <FieldDescription>{t("github.newApp.orgHint")}</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={ids.user} value="user" />
            <FieldContent>
              <FieldLabel htmlFor={ids.user}>
                {t("github.newApp.user")}
              </FieldLabel>
              <FieldDescription>{t("github.newApp.userHint")}</FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
      </FieldSet>
      {owner === "organization" ? (
        <Field>
          <FieldLabel htmlFor={ids.login}>
            {t("github.newApp.orgLogin")}
          </FieldLabel>
          <Input
            ref={loginRef}
            id={ids.login}
            className="max-w-80"
            name="login"
            autoComplete="off"
            spellCheck={false}
            maxLength={39}
            placeholder="acme-corp"
            aria-invalid={loginMissing || undefined}
            onChange={() => {
              if (loginMissing) setLoginMissing(false);
            }}
          />
          {loginMissing ? (
            <FieldError>{t("github.newApp.orgLoginMissing")}</FieldError>
          ) : null}
        </Field>
      ) : null}
      <FieldSet>
        <FieldLegend id={ids.scope} variant="label">
          {t("github.newApp.scope")}
        </FieldLegend>
        <RadioGroup
          value={scope}
          onValueChange={(value) =>
            setScope(value === "public" ? "public" : "private")
          }
          aria-labelledby={ids.scope}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={ids.private} value="private" />
            <FieldContent>
              <FieldLabel htmlFor={ids.private}>
                {t("github.newApp.private")}
              </FieldLabel>
              <FieldDescription>
                {t("github.newApp.privateHint")}
              </FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={ids.public} value="public" />
            <FieldContent>
              <FieldLabel htmlFor={ids.public}>
                {t("github.newApp.public")}
              </FieldLabel>
              <FieldDescription>
                {t("github.newApp.publicHint")}
              </FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
      </FieldSet>
      <Field orientation="horizontal">
        <Checkbox
          id={ids.actions}
          checked={actions}
          onCheckedChange={(checked) => setActions(checked === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor={ids.actions}>
            {t("github.newApp.actions")}
          </FieldLabel>
          <FieldDescription>{t("github.newApp.actionsHint")}</FieldDescription>
        </FieldContent>
      </Field>
      {blocked ? (
        <FieldError id={ids.blocked}>{t("github.newApp.blocked")}</FieldError>
      ) : (
        <FieldDescription>{t("github.newApp.next")}</FieldDescription>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={blocked}
          aria-describedby={blocked ? ids.blocked : undefined}
          aria-disabled={start.isPending || undefined}
        >
          {t("github.newApp.submit")}
        </Button>
      </div>
    </form>
  );
}

function failureText(t: Translate, error: ApiError, role?: string): string {
  switch (reasonOf(error)) {
    case "state_invalid":
      return t("github.newApp.stateInvalid");
    case "code_rejected":
      return t("github.newApp.codeRejected");
    case "author_app_changed":
      return t("github.newApp.changed");
    case "store_failed":
      return t("github.newApp.storeFailed");
    case "github_unreachable":
      return t("github.saveUnreachable");
    default:
      return refusalText(t, error, "workspace.manage", role);
  }
}

/** The App GitHub made, when an error says one is left there. */
function appLeftOnGitHub(error: ApiError | null): string | null {
  const url = (error?.details as { html_url?: unknown } | null)?.html_url;
  return typeof url === "string" && url.startsWith(GITHUB_WEB) ? url : null;
}

export type GitHubNewAppSearch = { code?: string; state?: string };

export function gitHubNewAppSearch(
  search: Record<string, unknown>,
): GitHubNewAppSearch {
  return {
    ...(typeof search.code === "string" ? { code: search.code } : {}),
    ...(typeof search.state === "string" ? { state: search.state } : {}),
  };
}

/**
 * GitHub sends the browser here (the manifest's `redirect_url`) with the
 * code and the state; the page hands both to the API once and wipes them
 * from the address bar.
 */
export function GitHubNewAppCallback() {
  const search = useSearch({
    from: "/authed/settings/workspace/github/new-app",
  });
  // Kept from the first render: the address bar loses them right after.
  const [sent] = useState(() => search);
  const navigate = useNavigate();
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id;
  const started = useRef(false);
  const complete = useMutation<CompleteGitHubAppManifestResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST(
          "/v1/workspaces/{id}/github-apps/author/manifest/complete",
          {
            params: { path: { id: workspaceId ?? "" } },
            body: { code: sent.code ?? "", state: sent.state ?? "" },
          },
        ),
      ),
    onSuccess: async (done) => {
      // Installing through a started state records who connected it; the
      // plain install URL still works when that start fails.
      const connectionId = done.github_app.connection_id;
      const started = connectionId
        ? await unwrap(
            client.POST(
              "/v1/workspaces/{id}/github-apps/{connectionId}/installations/start",
              {
                params: { path: { id: workspaceId ?? "", connectionId } },
              },
            ),
          ).catch(() => null)
        : null;
      const next = started?.install_url ?? done.install_url;
      if (next.startsWith(GITHUB_WEB)) githubNavigation.assign(next);
    },
  });
  const missing = !sent.code || !sent.state;
  useEffect(() => {
    if (started.current || workspaceId === undefined) return;
    started.current = true;
    if (!missing) complete.mutate();
    // Through the router, so its own location drops them too.
    void navigate({
      to: "/settings/workspace/github/new-app",
      search: {},
      replace: true,
    });
  }, [complete.mutate, missing, workspaceId, navigate]);

  const appUrl = appLeftOnGitHub(complete.error);
  const settled = missing || complete.isError || complete.isSuccess;
  return (
    <>
      <output aria-live="polite">
        {missing
          ? t("github.newApp.stateInvalid")
          : complete.error
            ? failureText(t, complete.error, role)
            : complete.isSuccess
              ? t("github.newApp.done")
              : t("github.newApp.working")}
      </output>
      {settled ? (
        <div className="flex flex-wrap items-center gap-3">
          {appUrl ? (
            <Link
              href={appUrl}
              target="_blank"
              newTabLabel={t("github.newTab")}
            >
              {t("github.newApp.openApp")}
            </Link>
          ) : null}
          <Button asChild variant="outline">
            <RouterLink to="/settings/workspace/github">
              {t("github.newApp.back")}
            </RouterLink>
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Kept apart from the body so a tab layout can host the body without this frame. */
export function GitHubNewAppRoute() {
  const { t } = useI18n();
  return (
    <Page title={t("github.newApp")}>
      <GitHubNewAppCallback />
    </Page>
  );
}
