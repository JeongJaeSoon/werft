import { Link } from "@tanstack/react-router";
import { Button, Card, cn, Heading, Skeleton, Text } from "@werft-ai/ui";
import type { ReactNode } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

export type StatusKind =
  | "loading"
  | "checking-login"
  | "not-found"
  | "login-required"
  | "forbidden"
  | "bootstrap-required"
  | "error";

export type StatusScreenProps =
  | {
      readonly kind: Exclude<StatusKind, "error">;
      /** Where login-required sends the reader back to after logging in. */
      readonly redirect?: string | undefined;
      /** Off where the screen already is the way forward (the login form). */
      readonly action?: boolean;
    }
  | {
      readonly kind: "error";
      readonly detail?: MessageKey;
      readonly onRetry?: () => void;
    }
  | {
      /** A state only its screen can word, such as an invite's outcome. */
      readonly kind: "custom";
      /** `data-status`, naming the state for tests and styles. */
      readonly status: string;
      readonly title: string;
      readonly body: string;
      readonly alert?: boolean;
      readonly actions?: ReactNode;
    };

type Frame = {
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly tone?: "danger" | "attention" | undefined;
  readonly actions?: ReactNode;
};

function StatusFrame({ status, title, body, tone, actions }: Frame) {
  return (
    <Card
      className={cn(
        "items-start px-4",
        tone === "danger" && "border-[var(--werft-tone-danger-border)]",
        tone === "attention" && "border-[var(--werft-tone-attention-border)]",
      )}
      data-status={status}
      role={tone === "danger" ? "alert" : undefined}
    >
      <Heading>{title}</Heading>
      <Text variant="sub">{body}</Text>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </Card>
  );
}

export function StatusScreen(props: StatusScreenProps) {
  const { t } = useI18n();
  switch (props.kind) {
    case "loading":
      return <Skeleton lines={3} label={t("status.loading.title")} />;
    // Full-page wait before any layout exists; a placeholder of lines would
    // mimic content that is not there. Waits for the ui FullPageState.
    case "checking-login":
      return (
        <Card
          className="items-start px-4"
          data-status={props.kind}
          aria-busy="true"
        >
          <output className="m-0 flex items-center gap-2 font-medium text-body">
            <span
              className="size-4 animate-spin rounded-full border-2 border-input border-t-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("status.checkingLogin.title")}
          </output>
        </Card>
      );
    case "custom":
      return (
        <StatusFrame
          status={props.status}
          title={props.title}
          body={props.body}
          tone={props.alert ? "danger" : undefined}
          actions={props.actions}
        />
      );
    case "error":
      return (
        <StatusFrame
          status={props.kind}
          title={t("status.error.title")}
          body={t(props.detail ?? "error.UNKNOWN")}
          tone="danger"
          actions={
            props.onRetry ? (
              <Button type="button" variant="outline" onClick={props.onRetry}>
                {t("common.retry")}
              </Button>
            ) : null
          }
        />
      );
    case "forbidden":
      return (
        <StatusFrame
          status={props.kind}
          title={t("status.forbidden.title")}
          body={t("status.forbidden.body")}
          tone="danger"
        />
      );
    case "not-found":
      return (
        <StatusFrame
          status={props.kind}
          title={t("status.notFound.title")}
          body={t("status.notFound.body")}
          actions={
            <Button asChild>
              <Link to="/">{t("status.notFound.action")}</Link>
            </Button>
          }
        />
      );
    case "login-required": {
      const { redirect, action = true } = props;
      return (
        <StatusFrame
          status={props.kind}
          title={t("status.loginRequired.title")}
          body={t("status.loginRequired.body")}
          actions={
            action ? (
              <Button asChild>
                <Link to="/login" search={redirect ? { redirect } : {}}>
                  {t("status.loginRequired.action")}
                </Link>
              </Button>
            ) : null
          }
        />
      );
    }
    case "bootstrap-required":
      return (
        <StatusFrame
          status={props.kind}
          title={t("status.bootstrapRequired.title")}
          body={t("status.bootstrapRequired.body")}
          tone="attention"
          actions={
            props.action === false ? null : (
              <Button asChild>
                <Link to="/bootstrap">
                  {t("status.bootstrapRequired.action")}
                </Link>
              </Button>
            )
          }
        />
      );
  }
}
