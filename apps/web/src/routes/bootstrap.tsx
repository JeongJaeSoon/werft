import { useMutation } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  PASSWORD_MIN_LENGTH,
  SETUP_LINK_TTL_HOURS,
  WORKSPACE_NAME_MAX,
} from "../auth/limits.ts";
import { AuthPage, FormError } from "../components/auth-page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";

const FIELDS = [
  {
    name: "email",
    label: "bootstrap.email",
    type: "email",
    autoComplete: "username",
  },
  {
    name: "display_name",
    label: "bootstrap.displayName",
    type: "text",
    autoComplete: "name",
  },
  {
    name: "password",
    label: "bootstrap.password",
    type: "password",
    autoComplete: "new-password",
  },
  {
    name: "workspace_name",
    label: "bootstrap.workspaceName",
    type: "text",
    autoComplete: "organization",
  },
  {
    name: "workspace_slug",
    label: "bootstrap.workspaceSlug",
    type: "text",
    autoComplete: "off",
  },
] as const satisfies readonly {
  name: string;
  label: MessageKey;
  type: string;
  autoComplete: string;
}[];

/**
 * A URL name (workspace slug), with our sentence in place of the browser's
 * "match the requested format", which cannot say what it is.
 */
function slugInput(message: string) {
  return {
    pattern: "[a-z0-9][a-z0-9\\-]*",
    maxLength: 64,
    onInvalid: (event: FormEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      if (input.validity.patternMismatch) input.setCustomValidity(message);
    },
    onInput: (event: FormEvent<HTMLInputElement>) =>
      event.currentTarget.setCustomValidity(""),
  };
}

type FieldName = (typeof FIELDS)[number]["name"];
type Form = Record<FieldName, string>;

const LENGTHS: Partial<
  Record<FieldName, { minLength?: number; maxLength: number }>
> = {
  email: { maxLength: EMAIL_MAX },
  display_name: { maxLength: DISPLAY_NAME_MAX },
  workspace_name: { maxLength: WORKSPACE_NAME_MAX },
};

const EMPTY: Form = {
  email: "",
  display_name: "",
  password: "",
  workspace_name: "",
  workspace_slug: "",
};

/** The token a setup link carries after `#setup=`, or null without one. */
export function setupTokenFrom(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("setup");
  return token ? token : null;
}

function LoginLink() {
  const { t } = useI18n();
  return (
    <Link className={buttonVariants()} to="/login">
      {t("login.provider.backToLogin")}
    </Link>
  );
}

function LinkUnusable({ missing }: { readonly missing: boolean }) {
  const { t } = useI18n();
  return (
    <StatusScreen
      kind="custom"
      status={missing ? "setup-link-missing" : "setup-link-invalid"}
      alert
      title={t(
        missing ? "bootstrap.linkMissing.title" : "bootstrap.linkInvalid.title",
      )}
      body={
        missing
          ? t("bootstrap.linkMissing.body")
          : t("bootstrap.linkInvalid.body", { hours: SETUP_LINK_TTL_HOURS })
      }
      actions={<LoginLink />}
    />
  );
}

// The form shows only for a live setup link: the link is checked first, and
// a link that dies before the submit (used, expired, replaced) ends the form.
export function BootstrapScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  // The token lives in the fragment, which no request carries.
  const setupToken = useLocation({
    select: (location) => setupTokenFrom(location.hash),
  });

  const check = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/setup-link/check", {
          body: { setup_token: setupToken ?? "" },
        }),
      ),
  });
  const { mutate } = check;
  useEffect(() => {
    if (setupToken !== null) mutate();
  }, [setupToken, mutate]);

  let body: ReactNode;
  if (setupToken === null) body = <LinkUnusable missing />;
  else if (check.isError && check.error.status === 401)
    body = <LinkUnusable missing={false} />;
  else if (check.isError)
    body = (
      <StatusScreen
        kind="error"
        detail={errorKey(check.error.code)}
        onRetry={() => mutate()}
      />
    );
  else if (!check.isSuccess) body = <StatusScreen kind="loading" />;
  else body = <OwnerForm setupToken={setupToken} />;
  return <AuthPage title={t("bootstrap.title")}>{body}</AuthPage>;
}

function OwnerForm({ setupToken }: { readonly setupToken: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);

  const create = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/bootstrap", {
          body: { ...form, setup_token: setupToken },
        }),
      ),
    onSuccess: () =>
      navigate({
        to: "/login",
        search: { notice: "created" },
        // History state, not the URL: the address stays free of the email.
        state: (prev) => ({ ...prev, loginEmail: form.email }),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  if (create.error?.status === 401) return <LinkUnusable missing={false} />;
  const errorText = create.error ? t(errorKey(create.error.code)) : null;

  return (
    <>
      <Text variant="sub">{t("bootstrap.intro")}</Text>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {FIELDS.map((field) => {
          const hint =
            field.name === "password"
              ? t("bootstrap.passwordHint", { min: PASSWORD_MIN_LENGTH })
              : field.name === "workspace_slug"
                ? t("bootstrap.workspaceSlugHint")
                : null;
          return (
            <Field key={field.name}>
              <FieldLabel>{t(field.label)}</FieldLabel>
              <Input
                name={field.name}
                type={field.type}
                autoComplete={field.autoComplete}
                required
                {...LENGTHS[field.name]}
                {...(field.name === "password"
                  ? { minLength: PASSWORD_MIN_LENGTH }
                  : {})}
                {...(field.name === "workspace_slug"
                  ? slugInput(t("field.slugFormat"))
                  : {})}
                value={form[field.name]}
                onChange={(event) =>
                  setForm({ ...form, [field.name]: event.target.value })
                }
              />
              {hint ? <FieldDescription>{hint}</FieldDescription> : null}
            </Field>
          );
        })}
        {errorText ? (
          <FormError>
            {errorText}
            {create.error?.code === "BOOTSTRAP_DONE" ? (
              <>
                {" "}
                <TextLink asChild underline="always">
                  <Link to="/login">{t("bootstrap.ownerExistsLogin")}</Link>
                </TextLink>
              </>
            ) : null}
          </FormError>
        ) : null}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t("bootstrap.submitting") : t("bootstrap.submit")}
        </Button>
      </form>
      <Text variant="sub">
        <TextLink asChild underline="always">
          <Link to="/login">{t("bootstrap.loginLink")}</Link>
        </TextLink>
      </Text>
    </>
  );
}
