import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiError, components } from "@werft-ai/client";
import type {
  AgentCard,
  ConnectionOption,
  ListConnectionOptionsResponse,
} from "@werft-ai/contracts";
import { draftCapabilities } from "@werft-ai/core/forms";
import {
  Alert,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from "@werft-ai/ui";
import { errorKey, LOCALE_NAMES, useI18n } from "../i18n/i18n.tsx";
import { ConnectionOptions } from "./connection-options.tsx";

/** The card languages; agent-card-form.test.ts pins it to the contract. */
export const AGENT_CARD_LANGUAGE_VALUES: readonly AgentCard["language"][] = [
  "follow-user",
  "ko",
  "en",
  "ja",
];

/** What a language reads as: its own name, or the follow-the-user choice. */
export function languageLabel(
  t: (key: "agentCard.language.followUser") => string,
  value: AgentCard["language"],
): string {
  return value === "follow-user"
    ? t("agentCard.language.followUser")
    : LOCALE_NAMES[value];
}

/** The card as the form holds it. */
export interface CardDraft {
  readonly language: AgentCard["language"];
  readonly model: string;
}

export const EMPTY_DRAFT: CardDraft = {
  // A new card follows the person; a stored card keeps what it holds.
  language: "follow-user",
  model: "",
};

type ApiCard = components["schemas"]["CreateAgentRequest"]["card"];

// The contract types an optional key as `T | undefined`, which the generated
// request type refuses under exactOptionalPropertyTypes; JSON drops it.
export const toApiCard = (card: AgentCard): ApiCard => card as ApiCard;

export function draftFromCard(card: AgentCard): CardDraft {
  return {
    language: card.language,
    model: card.model,
  };
}

/**
 * A draft from input kept across a reload (history.state, sessionStorage),
 * which may predate this form; null when it is not one.
 */
export function cardDraftOf(value: unknown): CardDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const kept = value as Record<keyof CardDraft, unknown>;
  if (
    typeof kept.model !== "string" ||
    !AGENT_CARD_LANGUAGE_VALUES.includes(kept.language as never)
  )
    return null;
  return {
    language: kept.language as CardDraft["language"],
    model: kept.model,
  };
}

/**
 * The card to send. An edit starts from `base` and overwrites only what the
 * form has a field for, so fields without an editor (rules, tool_policy,
 * credential_refs, an earlier role and instructions) survive the save.
 */
export function cardFromDraft(draft: CardDraft, base?: AgentCard): ApiCard {
  return toApiCard({
    ...(base ?? { rules: [] }),
    language: draft.language,
    model: draft.model.trim(),
    capabilities: draftCapabilities(base?.capabilities),
  });
}

export interface ModelOption {
  readonly model: string;
  /** False for a model the connection does not offer. */
  readonly offered: boolean;
}

/**
 * One option per model of the connection. A current model the connection
 * lacks stays as the last option, so a card saved without touching the
 * field keeps it.
 */
export function modelOptions(
  connection: Pick<ConnectionOption, "models"> | undefined,
  current: string,
): ModelOption[] {
  const models = connection?.models ?? [];
  const options = models.map((model) => ({ model, offered: true }));
  return current === "" || models.includes(current)
    ? options
    : [...options, { model: current, offered: false }];
}

/**
 * The card around an agent form: a fixed 8px from label to control and from
 * control to hint, so a long hint does not open a wider gap than a short one.
 */
export const AGENT_FORM =
  "flex w-full flex-col gap-4 rounded-card border bg-card p-4 [&_[data-slot=field-description]]:mt-0! [&_[data-slot=field-description]]:text-caption [&_[data-slot=field-label]]:text-control [&_[data-slot=field][data-orientation=vertical]]:gap-2";

export const CARD_ERROR_FIELDS = [
  "model",
] as const satisfies readonly (keyof CardDraft)[];

/** A message per card field, from a form that validates the card. */
export type CardErrors = Partial<
  Record<(typeof CARD_ERROR_FIELDS)[number], string>
>;

export function AgentCardFields({
  draft,
  catalog,
  connectionId,
  onConnectionChange,
  onChange,
  errors = {},
}: {
  readonly draft: CardDraft;
  readonly catalog: UseQueryResult<ListConnectionOptionsResponse>;
  /** The connection the release runs on: the model list is its. */
  readonly connectionId: string;
  readonly onConnectionChange: (connectionId: string) => void;
  readonly onChange: (draft: CardDraft) => void;
  readonly errors?: CardErrors | undefined;
}) {
  const { t } = useI18n();
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const connection = catalog.data?.items.find(
    (item) => item.id === connectionId,
  );
  // Before a connection is picked, every model some connection offers.
  const offered =
    connectionId === "" && catalog.data
      ? {
          models: [
            ...new Set(catalog.data.items.flatMap((item) => item.models)),
          ].sort(),
        }
      : connection;
  return (
    <>
      {catalog.isPending ? (
        <Skeleton label={t("agentCard.modelsLoading")} />
      ) : catalog.error ? (
        <FieldError>
          {t("agentCard.modelsFailed", {
            reason: t(errorKey((catalog.error as ApiError).code)),
          })}
        </FieldError>
      ) : (
        <>
          <Field>
            <FieldLabel>{t("agentCard.connection")}</FieldLabel>
            <NativeSelect
              value={connectionId}
              onChange={(event) => onConnectionChange(event.target.value)}
            >
              {connectionId === "" ? (
                <NativeSelectOption value="" disabled>
                  {t("agentCard.connectionPick")}
                </NativeSelectOption>
              ) : null}
              {connectionId !== "" && connection === undefined ? (
                <NativeSelectOption value={connectionId} disabled>
                  {t("agentCard.connectionGone", { id: connectionId })}
                </NativeSelectOption>
              ) : null}
              <ConnectionOptions connections={catalog.data.items} />
            </NativeSelect>
            <FieldDescription>{t("agentCard.connectionHint")}</FieldDescription>
            {catalog.data.items.length === 0 ? (
              <FieldDescription>
                {t("agentCard.connectionNone")}
              </FieldDescription>
            ) : null}
          </Field>
          <ModelSelect
            options={modelOptions(offered, draft.model)}
            value={draft.model}
            error={errors.model}
            onChange={(model) => set("model", model)}
          />
        </>
      )}
      <Field>
        <FieldLabel>{t("agentCard.language")}</FieldLabel>
        <NativeSelect
          value={draft.language}
          onChange={(event) =>
            set("language", event.target.value as CardDraft["language"])
          }
        >
          {AGENT_CARD_LANGUAGE_VALUES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {languageLabel(t, value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>{t("agentCard.language.hint")}</FieldDescription>
      </Field>
    </>
  );
}

function ModelSelect({
  options,
  value,
  error,
  onChange,
}: {
  readonly options: readonly ModelOption[];
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const uncataloged = options.some(
    (option) => option.model === value && !option.offered,
  );
  return (
    <Field>
      <FieldLabel>{t("agentCard.model")}</FieldLabel>
      <NativeSelect
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === "" ? (
          <NativeSelectOption value="" disabled>
            {t("agentCard.modelPick")}
          </NativeSelectOption>
        ) : null}
        {options.map((option) => (
          <NativeSelectOption key={option.model} value={option.model}>
            {!option.offered
              ? t("agentCard.modelUncataloged", { model: option.model })
              : option.model}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{t("agentCard.modelHint")}</FieldDescription>
      {uncataloged ? (
        <Alert variant="amber">
          <FieldDescription>
            {t("agentCard.modelUncatalogedWarning")}
          </FieldDescription>
        </Alert>
      ) : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}
