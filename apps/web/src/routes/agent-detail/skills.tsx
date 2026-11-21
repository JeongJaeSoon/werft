import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentSkillList,
  PutSkillAttachmentRequest,
  Skill,
  SkillAttachmentResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Code,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useState } from "react";
import { permissionReason, refusalText, useRole } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { SkillSourceIcon } from "../../components/skill-source.tsx";
import { StatusScreen } from "../../components/status-screen.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import {
  type AttachMode,
  agentSkillsKey,
  agentSkillsQuery,
  attachable,
  MODE_LABEL,
  MODES,
  skillRefusalKey,
  skillsQuery,
  versionLabel,
} from "../skills-data.ts";

type Mode = AttachMode;
type AgentSkill = AgentSkillList["items"][number];

export function AgentSkills({
  agentId,
  result,
  onOutcome,
}: {
  readonly agentId: string;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const role = useRole();
  const manages = useManagesAgent();
  const attached = useQuery(agentSkillsQuery(client, agentId));
  const refused = (error: ApiError) => {
    const known = skillRefusalKey(error);
    onOutcome({
      kind: "error",
      text: known ? t(known) : refusalText(t, error, "agent.manage", role),
    });
  };
  const reread = () =>
    cache.invalidateQueries({ queryKey: agentSkillsKey(client, agentId) });
  const remove = useMutation<SkillAttachmentResponse, ApiError, string>({
    mutationFn: (name) =>
      unwrap(
        client.DELETE("/v1/agents/{id}/skills/{name}", {
          params: { path: { id: agentId, name } },
        }),
      ) as Promise<SkillAttachmentResponse>,
    onMutate: () => onOutcome(null),
    onSuccess: (_answer, name) =>
      onOutcome({ kind: "notice", text: t("agentSkills.removed", { name }) }),
    onError: refused,
    onSettled: reread,
  });

  const title = t("agentSkills.title");
  if (attached.isPending)
    return (
      <Section title={title}>
        <div className={SECTION_BODY}>
          <StatusScreen kind="loading" />
        </div>
      </Section>
    );
  if (attached.isError)
    return (
      <Section title={title}>
        <div className={SECTION_BODY}>
          {isApiError(attached.error, "FORBIDDEN") ? (
            <Text variant="sub">
              {permissionReason(t, "agent.manage", role)}
            </Text>
          ) : (
            <LoadFailure
              error={attached.error}
              onRetry={() => void attached.refetch()}
            />
          )}
        </div>
      </Section>
    );

  return (
    <Section title={title} description={t("agentSkills.description")}>
      <div className={SECTION_BODY}>
        {result}
        {attached.data.items.length === 0 ? (
          <Text variant="sub">{t("agentSkills.empty")}</Text>
        ) : (
          <RowList aria-label={title}>
            {attached.data.items.map((item) => (
              <SkillRow
                key={`${item.scope}:${item.name}`}
                item={item}
                removable={manages && item.scope === "agent"}
                busy={remove.isPending}
                onRemove={() => remove.mutate(item.name)}
              />
            ))}
          </RowList>
        )}
        {manages ? (
          <AttachForm
            agentId={agentId}
            onOutcome={onOutcome}
            onRefused={refused}
            onSaved={reread}
          />
        ) : null}
      </div>
    </Section>
  );
}

function SkillRow({
  item,
  removable,
  busy,
  onRemove,
}: {
  readonly item: AgentSkill;
  readonly removable: boolean;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const version =
    item.version === null
      ? t("agentSkills.noVersion")
      : item.follows
        ? `${t("skills.workspace.follows")} · ${versionLabel(t, item.version)}`
        : versionLabel(t, item.version);
  return (
    <RowListItem>
      <RowLines>
        <div className="flex flex-wrap items-center gap-2">
          {item.version ? (
            <SkillSourceIcon source={item.version.source} />
          ) : null}
          <Text as="span" weight="medium" className="wrap-anywhere">
            <Code size="inherit">{item.name}</Code>
          </Text>
          <Badge variant={item.mode === "forbidden" ? "red" : "gray"}>
            {t(MODE_LABEL[item.mode])}
          </Badge>
          <Badge>
            {t(
              item.scope === "workspace"
                ? "agentSkills.fromWorkspace"
                : "agentSkills.fromAgent",
            )}
          </Badge>
        </div>
        <Text as="span" variant="meta" className="wrap-anywhere">
          {version}
        </Text>
        {item.scope === "workspace" ? (
          <Text as="span" variant="meta">
            {t("agentSkills.locked")}
          </Text>
        ) : null}
      </RowLines>
      {removable ? (
        <RowAction
          variant="danger"
          disabled={busy}
          aria-label={t("agentSkills.removeFor", { name: item.name })}
          onClick={onRemove}
        >
          {t("agentSkills.remove")}
        </RowAction>
      ) : null}
    </RowListItem>
  );
}

function AttachForm({
  agentId,
  onOutcome,
  onRefused,
  onSaved,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly onRefused: (error: ApiError) => void;
  readonly onSaved: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const library = useQuery(skillsQuery(client));
  const [name, setName] = useState("");
  const [versionId, setVersionId] = useState("");
  const [mode, setMode] = useState<Mode>("optional");
  const save = useMutation<
    SkillAttachmentResponse,
    ApiError,
    { name: string; body: PutSkillAttachmentRequest }
  >({
    mutationFn: ({ name: skill, body }) =>
      unwrap(
        client.PUT("/v1/agents/{id}/skills/{name}", {
          params: { path: { id: agentId, name: skill } },
          body,
        }),
      ) as Promise<SkillAttachmentResponse>,
    onMutate: () => onOutcome(null),
    onSuccess: (answer) => {
      setName("");
      setVersionId("");
      onOutcome({
        kind: "notice",
        text: t("agentSkills.saved", { name: answer.name }),
      });
    },
    onError: onRefused,
    onSettled: onSaved,
  });
  // A failed re-read keeps the form on the last answer.
  if (library.data === undefined) {
    return library.isError && !isApiError(library.error, "FORBIDDEN") ? (
      <LoadFailure
        error={library.error}
        onRetry={() => void library.refetch()}
      />
    ) : null;
  }
  const choices = library.data.items.filter(
    (skill) => attachable(skill, "forbidden").length > 0,
  );
  if (choices.length === 0)
    return <Text variant="sub">{t("agentSkills.noApproved")}</Text>;
  const picked = choices.find((skill) => skill.name === name);
  const versions = picked ? attachable(picked, mode) : [];
  const firstOf = (skill: Skill | undefined, next: Mode) =>
    skill ? (attachable(skill, next)[0]?.id ?? "") : "";
  // A re-read may drop the picked version (rejected, archived): what is shown
  // and what is sent are the same valid one.
  const chosen = versions.some((item) => item.id === versionId)
    ? versionId
    : (versions[0]?.id ?? "");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked === undefined || chosen === "" || save.isPending) return;
        save.mutate({
          name: picked.name,
          body: { version_id: chosen, mode },
        });
      }}
    >
      <Text as="span" weight="medium">
        {t("agentSkills.add")}
      </Text>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel>{t("agentSkills.skill")}</FieldLabel>
          <NativeSelect
            value={name}
            onChange={(event) => {
              const next = choices.find(
                (skill) => skill.name === event.target.value,
              );
              setName(event.target.value);
              setVersionId(firstOf(next, mode));
            }}
          >
            <NativeSelectOption value="">
              {t("agentSkills.pick")}
            </NativeSelectOption>
            {choices.map((skill) => (
              <NativeSelectOption key={skill.name} value={skill.name}>
                {skill.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel>{t("agentSkills.version")}</FieldLabel>
          <NativeSelect
            value={chosen}
            disabled={picked === undefined}
            onChange={(event) => setVersionId(event.target.value)}
          >
            {versions.map((version) => (
              <NativeSelectOption key={version.id} value={version.id}>
                {versionLabel(t, version)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel>{t("agentSkills.mode")}</FieldLabel>
          <NativeSelect
            value={mode}
            onChange={(event) => {
              const next = event.target.value as Mode;
              setMode(next);
              if (
                picked &&
                !attachable(picked, next).some((item) => item.id === versionId)
              )
                setVersionId(firstOf(picked, next));
            }}
          >
            {MODES.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {t(MODE_LABEL[item])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div>
        <Button
          type="submit"
          variant="outline"
          disabled={picked === undefined || chosen === "" || save.isPending}
        >
          {save.isPending ? t("agentSkills.saving") : t("agentSkills.save")}
        </Button>
      </div>
    </form>
  );
}
