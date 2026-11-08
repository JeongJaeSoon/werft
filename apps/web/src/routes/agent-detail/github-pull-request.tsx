import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type { AgentPullRequestSettings } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Section,
  Skeleton,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import type { Notify } from "../../components/toast.tsx";
import { errorKey, useI18n } from "../../i18n/i18n.tsx";

/** The anchor the tab's side nav jumps to. */
export const PULL_REQUEST_SECTION = "github-pull-request";
const SECTION_PROPS = {
  id: PULL_REQUEST_SECTION,
  tabIndex: -1,
  className: "scroll-mt-4 outline-none",
} as const;

export const AGENT_TEMPLATE_MAX_BYTES = 16 * 1024;
export const AGENT_TEMPLATE_NAME_MAX_LENGTH = 100;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const key = (client: ApiClient, agentId: string) =>
  [client, "agent", agentId, "pull-request-settings"] as const;

const REFUSALS = {
  template_too_large: "agentPullRequest.tooLarge",
  template_not_utf8: "agentPullRequest.invalidText",
  template_unsupported: "agentPullRequest.unsupported",
} as const;

export function AgentPullRequestSettingsCard({
  agentId,
  notify,
}: {
  readonly agentId: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const read = useQuery({
    queryKey: key(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github/pull-request", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
  if (read.isPending) {
    return (
      <Section {...SECTION_PROPS} title={t("agentPullRequest.title")}>
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }
  if (read.data === undefined) {
    return (
      <Section {...SECTION_PROPS} title={t("agentPullRequest.title")}>
        <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
      </Section>
    );
  }
  return (
    <Form
      key={read.data.pull_request_revision}
      agentId={agentId}
      saved={read.data.pull_request}
      revision={read.data.pull_request_revision}
      notify={notify}
    />
  );
}

function Form({
  agentId,
  saved,
  revision,
  notify,
}: {
  readonly agentId: string;
  readonly saved: AgentPullRequestSettings;
  readonly revision: number;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const manages = useManagesAgent();
  const ids = {
    formatting: useId(),
    template: useId(),
    name: useId(),
    hint: useId(),
  };
  const [formatting, setFormatting] = useState(saved.formatting);
  const [template, setTemplate] = useState(saved.template ?? "");
  const [name, setName] = useState(saved.template_name ?? "");

  const next: AgentPullRequestSettings = {
    formatting,
    template: template.trim() === "" ? null : template,
    template_name: name.trim() === "" ? null : name.trim(),
  };
  const bytes = byteLength(template);
  const tooLarge = bytes > AGENT_TEMPLATE_MAX_BYTES;
  const changed = JSON.stringify(next) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: (body: AgentPullRequestSettings) =>
      unwrap(
        client.PUT("/v1/agents/{id}/github/pull-request", {
          params: { path: { id: agentId } },
          body: { pull_request: body, revision },
        }),
      ),
    onSuccess: async () => {
      notify(t("agentPullRequest.saved"));
      await cache.invalidateQueries({ queryKey: key(client, agentId) });
    },
    onError: async (error) => {
      if (isApiError(error, "REVISION_CONFLICT")) {
        await cache.invalidateQueries({ queryKey: key(client, agentId) });
      }
    },
  });

  const reason = (save.error as { details?: { reason_code?: string } } | null)
    ?.details?.reason_code;
  const failure = save.error
    ? isApiError(save.error, "REVISION_CONFLICT")
      ? t("agentPullRequest.conflict")
      : reason && reason in REFUSALS
        ? t(REFUSALS[reason as keyof typeof REFUSALS], {
            max: AGENT_TEMPLATE_MAX_BYTES,
          })
        : t(
            errorKey(
              (save.error as { code?: string } | null)?.code ??
                "INTERNAL_ERROR",
            ),
          )
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || tooLarge || !changed || !manages) return;
    save.mutate(next);
  };

  return (
    <Section
      {...SECTION_PROPS}
      title={t("agentPullRequest.title")}
      description={t("agentPullRequest.hint")}
    >
      <form className={SECTION_BODY} onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor={ids.formatting}>
            {t("agentPullRequest.formatting")}
          </FieldLabel>
          <NativeSelect
            id={ids.formatting}
            className="w-auto max-w-full"
            value={formatting}
            disabled={!manages}
            onChange={(event) =>
              setFormatting(
                event.target.value as AgentPullRequestSettings["formatting"],
              )
            }
          >
            <NativeSelectOption value="inherit">
              {t("agentPullRequest.formatting.inherit")}
            </NativeSelectOption>
            <NativeSelectOption value="on">
              {t("agentPullRequest.formatting.on")}
            </NativeSelectOption>
            <NativeSelectOption value="off">
              {t("agentPullRequest.formatting.off")}
            </NativeSelectOption>
          </NativeSelect>
          <FieldDescription>
            {t("agentPullRequest.formattingHint")}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.name}>
            {t("agentPullRequest.templateName")}
          </FieldLabel>
          <Input
            id={ids.name}
            className="max-w-80"
            maxLength={AGENT_TEMPLATE_NAME_MAX_LENGTH}
            value={name}
            readOnly={!manages}
            disabled={formatting === "off"}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldDescription>
            {t("agentPullRequest.templateNameHint")}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.template}>
            {t("agentPullRequest.template")}
          </FieldLabel>
          <Textarea
            id={ids.template}
            rows={8}
            value={template}
            readOnly={!manages}
            disabled={formatting === "off"}
            aria-invalid={tooLarge || undefined}
            aria-describedby={ids.hint}
            onChange={(event) => setTemplate(event.target.value)}
          />
          <FieldDescription id={ids.hint}>
            {t("agentPullRequest.templateHint", {
              bytes,
              max: AGENT_TEMPLATE_MAX_BYTES,
            })}
          </FieldDescription>
        </Field>
        {failure ? <FieldError>{failure}</FieldError> : null}
        {manages ? (
          <div>
            <Button
              type="submit"
              size="sm"
              aria-disabled={save.isPending || undefined}
              disabled={!changed || tooLarge}
            >
              {t("agentPullRequest.save")}
            </Button>
          </div>
        ) : null}
      </form>
    </Section>
  );
}
