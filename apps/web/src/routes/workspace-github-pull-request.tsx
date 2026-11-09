import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubSettingsResponse,
  PullRequestSettings,
  PutGitHubPullRequestSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  SettingsSection,
  Switch,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { githubSettingsKey } from "./workspace-github-access.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

export const PULL_REQUEST_TEMPLATE_MAX_BYTES = 16 * 1024;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const REFUSALS = {
  template_too_large: "github.pullRequest.tooLarge",
  template_not_utf8: "github.pullRequest.invalidText",
  template_unsupported: "github.pullRequest.unsupported",
} as const;

export function PullRequestSettingsCard({
  settings,
  onOutcome,
}: {
  readonly settings: GitHubSettingsResponse;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const me = useMe();
  const workspaceId = me?.workspace?.id ?? "";
  const role = useRole();
  const canManage = useHasPermission("workspace.manage");
  const reason = canManage
    ? undefined
    : permissionReason(t, "workspace.manage", role);
  const ids = { mode: useId(), link: useId(), text: useId(), hint: useId() };

  const saved = settings.pull_request;
  const [draft, setDraft] = useState<PullRequestSettings>(saved);
  const [template, setTemplate] = useState(saved.default_template ?? "");
  const next: PullRequestSettings = {
    ...draft,
    default_template: template.trim() === "" ? null : template,
  };
  const bytes = byteLength(template);
  const tooLarge = bytes > PULL_REQUEST_TEMPLATE_MAX_BYTES;
  const changed = JSON.stringify(next) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: (body: PullRequestSettings) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings/pull-request", {
          params: { path: { id: workspaceId } },
          body: {
            pull_request: body,
            revision: settings.pull_request_revision,
          },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result: PutGitHubPullRequestSettingsResponse) => {
      queryClient.setQueryData<GitHubSettingsResponse>(
        githubSettingsKey(client, workspaceId),
        (old) =>
          old
            ? {
                ...old,
                pull_request: result.pull_request,
                pull_request_revision: result.pull_request_revision,
              }
            : old,
      );
      setDraft(result.pull_request);
      setTemplate(result.pull_request.default_template ?? "");
      onOutcome({ kind: "notice", text: t("github.pullRequest.saved") });
    },
    onError: async (error) => {
      if (isApiError(error, "REVISION_CONFLICT")) {
        await queryClient.invalidateQueries({
          queryKey: githubSettingsKey(client, workspaceId),
        });
        onOutcome({ kind: "error", text: t("github.pullRequest.conflict") });
        return;
      }
      const code = (error as { details?: { reason_code?: string } }).details
        ?.reason_code;
      const key =
        code && code in REFUSALS
          ? REFUSALS[code as keyof typeof REFUSALS]
          : null;
      onOutcome({
        kind: "error",
        text: key
          ? t(key, { max: PULL_REQUEST_TEMPLATE_MAX_BYTES })
          : isApiError(error)
            ? refusalText(t, error, "workspace.manage", role)
            : t("github.pullRequest.failed"),
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || tooLarge || !changed) return;
    save.mutate(next);
  };

  return (
    <SettingsSection
      title={t("github.pullRequest.title")}
      description={t("github.pullRequest.hint")}
      box
      onSubmit={submit}
      foot={
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={reason}
          aria-disabled={save.isPending || undefined}
          disabled={!changed || tooLarge}
        >
          {t("workspace.save")}
        </ReasonButton>
      }
    >
      <Field orientation="horizontal">
        <Switch
          id={`${ids.mode}-use`}
          checked={draft.formatting === "on"}
          disabled={reason !== undefined}
          onCheckedChange={(on) =>
            setDraft({ ...draft, formatting: on ? "on" : "off" })
          }
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={`${ids.mode}-use`}>
            {t("github.pullRequest.formatting")}
          </FieldLabel>
          <FieldDescription>
            {t("github.pullRequest.formattingHint")}
          </FieldDescription>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.mode}>
          {t("github.pullRequest.mode")}
        </FieldLabel>
        <NativeSelect
          id={ids.mode}
          className="w-auto max-w-full"
          value={draft.template_mode}
          disabled={reason !== undefined || draft.formatting === "off"}
          onChange={(event) =>
            setDraft({
              ...draft,
              template_mode: event.target
                .value as PullRequestSettings["template_mode"],
            })
          }
        >
          <NativeSelectOption value="repository_first">
            {t("github.pullRequest.mode.repository_first")}
          </NativeSelectOption>
          <NativeSelectOption value="override">
            {t("github.pullRequest.mode.override")}
          </NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.text}>
          {t("github.pullRequest.template")}
        </FieldLabel>
        <Textarea
          id={ids.text}
          rows={10}
          value={template}
          readOnly={reason !== undefined}
          disabled={draft.formatting === "off"}
          aria-invalid={tooLarge || undefined}
          aria-describedby={ids.hint}
          onChange={(event) => setTemplate(event.target.value)}
        />
        <FieldDescription id={ids.hint}>
          {t("github.pullRequest.templateHint", {
            bytes,
            max: PULL_REQUEST_TEMPLATE_MAX_BYTES,
          })}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.link}>
          {t("github.pullRequest.sessionLink")}
        </FieldLabel>
        <NativeSelect
          id={ids.link}
          className="w-auto max-w-full"
          value={draft.session_link}
          disabled={reason !== undefined}
          onChange={(event) =>
            setDraft({
              ...draft,
              session_link: event.target
                .value as PullRequestSettings["session_link"],
            })
          }
        >
          <NativeSelectOption value="url">
            {t("github.pullRequest.sessionLink.url")}
          </NativeSelectOption>
          <NativeSelectOption value="id">
            {t("github.pullRequest.sessionLink.id")}
          </NativeSelectOption>
        </NativeSelect>
        <FieldDescription>
          {t("github.pullRequest.sessionLinkHint")}
        </FieldDescription>
      </Field>
    </SettingsSection>
  );
}
