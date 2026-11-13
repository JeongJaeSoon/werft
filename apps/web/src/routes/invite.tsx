import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  type ApiError,
  CSRF_HEADER_VALUE,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import { acceptInviteStep } from "@werft-ai/core/forms";
import {
  formAlerts,
  submitStep,
  useStepForm,
  useStepper,
  useWerft,
} from "@werft-ai/react";
import {
  Button,
  buttonVariants,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Stepper,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useId, useState } from "react";
import { loginMethodsQuery, viewerQuery } from "../api/queries.ts";
import {
  DISPLAY_NAME_MAX,
  INVITE_TOKEN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../auth/limits.ts";
import { AuthPage, FormError } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { StepHeading, useStepMoved } from "../components/step-heading.tsx";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";
import { POST_LOGIN_PATH_KEY } from "./login.tsx";

/**
 * Redeeming an invite link. Whoever opens it may or may not be signed in,
 * and there is no way to ask the server whether the address already has an
 * account without spending the token, so the form takes a password either
 * way: an existing account proves itself with it, a new one is created with
 * it. Only the server's answer says which happened.
 */
export function InviteScreen() {
  const { t } = useI18n();
  const { token } = useParams({ from: "/invite/$token" });
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const viewer = useQuery(viewerQuery(client));

  const logout = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(client.POST("/v1/auth/logout")).catch((error: unknown) => {
        if (!isApiError(error, "UNAUTHORIZED")) throw error;
      }),
    onSuccess: () => {
      queryClient.clear();
    },
  });

  let body: ReactNode;
  if (viewer.isPending) body = <StatusScreen kind="loading" />;
  else if (viewer.error) {
    body = (
      <LoadFailure error={viewer.error} onRetry={() => void viewer.refetch()} />
    );
  } else if (viewer.data) {
    // One workspace per installation: anyone signed in is already a member.
    body = (
      <StatusScreen
        kind="custom"
        status="invite-member"
        title={t("invite.member.title")}
        body={t("invite.member.body", {
          workspace: viewer.data.workspace?.name ?? "",
          email: viewer.data.user?.email ?? "",
        })}
        actions={
          <>
            <Link className={buttonVariants()} to="/">
              {t("invite.member.home")}
            </Link>
            <Button
              type="button"
              variant="outline"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t("invite.member.switch")}
            </Button>
            {logout.error ? (
              <FormError>
                {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
              </FormError>
            ) : null}
          </>
        }
      />
    );
  } else if (
    // A link cut short or made up has a token the server can only call an
    // invalid request, so its length is checked here.
    token.length < INVITE_TOKEN_LENGTH.min ||
    token.length > INVITE_TOKEN_LENGTH.max
  ) {
    body = (
      <StatusScreen
        kind="custom"
        status="invite-invalid"
        alert
        title={t("invite.invalid.title")}
        body={t("invite.invalid.body")}
      />
    );
  } else body = <AcceptFlow key={token} token={token} />;

  return <AuthPage title={t("invite.title")}>{body}</AuthPage>;
}

type Account = "existing" | "new";

type AcceptSteps = {
  account: { account?: Account };
  password: { account: Account };
};

const isObject = (data: unknown): data is AcceptSteps["account"] =>
  typeof data === "object" && data !== null;
const hasAccount = (data: unknown): data is AcceptSteps["password"] =>
  isObject(data) &&
  ((data as { account?: unknown }).account === "existing" ||
    (data as { account?: unknown }).account === "new");

/*
 * Which account the reader says they have only shapes the form (autofill, the
 * name field); the request is the same either way. The password never goes
 * into the flow's stored input, so a reload on the second step asks for it
 * again.
 */
function AcceptFlow({ token }: { readonly token: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const funnel = useFunnel<AcceptSteps>({
    id: "accept",
    initial: { step: "account", context: {} },
    steps: {
      account: { guard: isObject },
      password: { guard: hasAccount },
    },
  });
  const stepper = useStepper({
    steps: [
      { id: "account", label: t("invite.step.account") },
      { id: "password", label: t("invite.step.password") },
    ],
    currentStepId: funnel.step,
    onStepSelect: () => void funnel.history.back(),
  });
  const moved = useStepMoved(funnel.step);
  // Kept apart from the mutation, which is reset so the password goes too.
  const [ended, setEnded] = useState<
    "INVITE_EXPIRED" | "INVITE_USED" | undefined
  >();

  const accept = useMutation<
    unknown,
    ApiError,
    { password: string; display_name?: string | undefined }
  >({
    // A 401 here is a wrong password, not an ended session.
    meta: { public: true },
    // The variables hold the password; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: ({ password, display_name }) =>
      unwrap(
        client.POST("/v1/invites/accept", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: { token, password, ...(display_name ? { display_name } : {}) },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/" });
    },
  });

  const send = async (values: Parameters<typeof accept.mutateAsync>[0]) => {
    try {
      await accept.mutateAsync(values);
    } catch (error) {
      // Detach the observer so gcTime 0 drops the failed attempt.
      accept.reset();
      if (isApiError(error, "INVITE_EXPIRED")) setEnded("INVITE_EXPIRED");
      else if (isApiError(error, "INVITE_USED")) setEnded("INVITE_USED");
      throw error;
    }
  };

  if (ended === "INVITE_EXPIRED") {
    return (
      <StatusScreen
        kind="custom"
        status="invite-expired"
        alert
        title={t("invite.expired.title")}
        body={t("invite.expired.body")}
      />
    );
  }
  if (ended === "INVITE_USED") {
    return (
      <StatusScreen
        kind="custom"
        status="invite-used"
        alert
        title={t("invite.used.title")}
        body={t("invite.used.body")}
        actions={
          <Link className={buttonVariants()} to="/login">
            {t("invite.used.login")}
          </Link>
        }
      />
    );
  }

  return (
    <>
      <FunnelResetNotice funnel={funnel} />
      <Stepper label={t("invite.steps")} {...stepper} />
      <funnel.Render
        account={({ history }) => (
          <>
            <AccountStep
              focus={moved}
              onPick={(account) => void history.push("password", { account })}
            />
            <ProviderSignUp token={token} onEnded={setEnded} />
          </>
        )}
        password={({ context, history }) => (
          <PasswordStep
            account={context.account}
            focus={moved}
            pending={accept.isPending}
            send={send}
            onBack={() => void history.back()}
          />
        )}
      />
    </>
  );
}

function AccountStep({
  focus,
  onPick,
}: {
  readonly focus: boolean;
  readonly onPick: (account: Account) => void;
}) {
  const { t } = useI18n();
  const questionId = useId();
  return (
    <section className="flex flex-col gap-3" aria-labelledby={questionId}>
      <p className="m-0">{t("invite.intro")}</p>
      <StepHeading focus={focus} id={questionId}>
        {t("invite.account.question")}
      </StepHeading>
      <Button type="button" onClick={() => onPick("existing")}>
        {t("invite.account.existing")}
      </Button>
      <Button type="button" variant="outline" onClick={() => onPick("new")}>
        {t("invite.account.new")}
      </Button>
    </section>
  );
}

/**
 * Joining with a provider's account in place of a password: one button per
 * login provider that is on. The start binds the flow to this invite and
 * spends nothing; the callback makes the account, with the invite's address
 * and role. A failed lookup leaves the password steps.
 */
function ProviderSignUp({
  token,
  onEnded,
}: {
  readonly token: string;
  readonly onEnded: (code: "INVITE_EXPIRED" | "INVITE_USED") => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const { leave } = useAppServices();
  const methods = useQuery(loginMethodsQuery(client));

  // The variables are the provider's id alone: the token stays out of them.
  const start = useMutation<{ authorization_url: string }, ApiError, string>({
    meta: { public: true },
    mutationFn: (id) =>
      unwrap(
        client.POST("/v1/auth/providers/{id}/invite/start", {
          params: {
            path: { id },
            header: { "X-Requested-With": CSRF_HEADER_VALUE },
          },
          body: { invite_token: token },
        }),
      ),
    onSuccess: ({ authorization_url }) => {
      try {
        // A place an earlier sign-in of this tab meant to return to is not
        // where a new member lands.
        sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
      } catch {
        // Nothing to forget where nothing could be kept.
      }
      leave(authorization_url);
    },
    onError: (error) => {
      if (isApiError(error, "INVITE_EXPIRED")) onEnded("INVITE_EXPIRED");
      else if (isApiError(error, "INVITE_USED")) onEnded("INVITE_USED");
    },
  });

  const providers = methods.data?.providers ?? [];
  if (providers.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("invite.provider.alternatives")}
    >
      <Text variant="sub" className="text-center">
        {t("login.or")}
      </Text>
      <Text variant="sub">{t("invite.provider.hint")}</Text>
      {start.error ? (
        <FormError>{t(errorKey(start.error.code))}</FormError>
      ) : null}
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          // Not held after success: back from the provider's page (bfcache)
          // must be able to start again.
          disabled={start.isPending}
          onClick={() => start.mutate(provider.id)}
        >
          {start.isPending && start.variables === provider.id
            ? t("login.provider.starting")
            : t("invite.provider.submit", { name: provider.display_name })}
        </Button>
      ))}
    </section>
  );
}

const FIELDS = ["display_name", "password"] as const;

function PasswordStep({
  account,
  focus,
  pending,
  send,
  onBack,
}: {
  readonly account: Account;
  readonly focus: boolean;
  readonly pending: boolean;
  readonly send: (values: {
    password: string;
    display_name?: string | undefined;
  }) => Promise<unknown>;
  readonly onBack: () => void;
}) {
  const { t } = useI18n();
  const form = useStepForm(acceptInviteStep, {
    defaultValues: { password: "", display_name: "" },
  });
  const { errors } = form.formState;
  const alerts = formAlerts(errors, FIELDS);

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitStep(form, send, (error) =>
        isApiError(error, "UNAUTHORIZED")
          ? t("invite.wrongPassword")
          : t(errorKey(isApiError(error) ? error.code : "UNKNOWN")),
      )}
    >
      <StepHeading focus={focus}>
        {t(
          account === "existing"
            ? "invite.passwordTitle.existing"
            : "invite.passwordTitle.new",
        )}
      </StepHeading>
      {alerts.map((alert) => (
        <FormError key={alert}>{alert}</FormError>
      ))}
      {account === "new" ? (
        <Field>
          <FieldLabel>{t("invite.displayName")}</FieldLabel>
          <Input
            type="text"
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX}
            {...form.register("display_name")}
          />
          <FieldDescription>{t("invite.displayNameHint")}</FieldDescription>
          <FieldError>{errors.display_name?.message}</FieldError>
        </Field>
      ) : null}
      <Field>
        <FieldLabel>{t("invite.password")}</FieldLabel>
        <Input
          type="password"
          autoComplete={
            account === "existing" ? "current-password" : "new-password"
          }
          {...form.register("password")}
        />
        <FieldDescription>
          {t("invite.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        </FieldDescription>
        <FieldError>{errors.password?.message}</FieldError>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          {t("invite.back")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("invite.submitting") : t("invite.submit")}
        </Button>
      </div>
    </form>
  );
}
