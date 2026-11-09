import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import type {
  AgentCard,
  ListProfilesResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { draftCapabilities } from "@werft-ai/core/forms";
import {
  Alert,
  Badge,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import type { components } from "../api/schema.gen.ts";
import { errorKey, LOCALE_NAMES, useI18n } from "../i18n/i18n.tsx";
import { ProfileOptions, pickable } from "./profile-options.tsx";

/** The card languages; agent-card-form.test.ts pins it to the contract. */
export const AGENT_CARD_LANGUAGE_VALUES: readonly AgentCard["language"][] = [
  "ko",
  "en",
];

/** The card as the form holds it. */
export interface CardDraft {
  readonly language: AgentCard["language"];
  readonly model: string;
}

export const EMPTY_DRAFT: CardDraft = {
  language: "ko",
  model: "",
};

export type ApiCard = components["schemas"]["CreateAgentRequest"]["card"];

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
  return {
    ...(base ?? { rules: [] }),
    language: draft.language,
    model: draft.model.trim(),
    capabilities: draftCapabilities(base?.capabilities),
  } as unknown as ApiCard;
}

/** The usable profiles that run `model`: what a release of the card may name. */
export function runningProfiles(
  profiles: readonly ProfileSummary[],
  model: string,
): ProfileSummary[] {
  return profiles.filter(
    (profile) => pickable(profile) && profile.models.includes(model),
  );
}

/**
 * The profiles whose tools the checklist offers, the first being the
 * default: those of `previewable` (the new-agent flow's own releases) when
 * any runs the model, else every one that does, released from the agent's
 * releases tab.
 */
export function previewProfiles(
  profiles: readonly ProfileSummary[],
  model: string,
  previewable: (profile: ProfileSummary) => boolean = pickable,
): ProfileSummary[] {
  const running = runningProfiles(profiles, model);
  const preferred = running.filter(previewable);
  return preferred.length > 0 ? preferred : running;
}

/**
 * The profile the checklist shows and a new release starts from: `wanted`
 * while it is one of `previewProfiles`, else the first of them. The agent
 * detail resolves both through here, so the two cannot name different ones.
 */
export function chosenProfile(
  profiles: readonly ProfileSummary[],
  model: string,
  wanted: string | undefined,
  previewable?: (profile: ProfileSummary) => boolean,
): ProfileSummary | undefined {
  const candidates = previewProfiles(profiles, model, previewable);
  return candidates.find((profile) => profile.id === wanted) ?? candidates[0];
}

export interface ModelOption {
  readonly model: string;
  /** The profiles that run it; empty for a model the catalog does not have. */
  readonly profileIds: readonly string[];
}

/**
 * One option per catalog model. A current model the catalog lacks stays as
 * the last option, so a card saved without touching the field keeps it.
 */
export function modelOptions(
  profiles: readonly ProfileSummary[],
  current: string,
): ModelOption[] {
  const byModel = new Map<string, string[]>();
  for (const profile of profiles.filter(pickable))
    for (const model of profile.models)
      byModel.set(model, [...(byModel.get(model) ?? []), profile.id]);
  const options = [...byModel].map(([model, profileIds]) => ({
    model,
    profileIds,
  }));
  return current === "" || byModel.has(current)
    ? options
    : [...options, { model: current, profileIds: [] }];
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
  onChange,
  errors = {},
  previewable,
  previewId,
  onPreviewChange,
}: {
  readonly draft: CardDraft;
  readonly catalog: UseQueryResult<ListProfilesResponse>;
  readonly onChange: (draft: CardDraft) => void;
  readonly errors?: CardErrors | undefined;
  /** Which profiles may preview the tools; every usable one by default. */
  readonly previewable?: (profile: ProfileSummary) => boolean;
  /**
   * The profile picked to preview, held by a caller that outlives this form
   * (the new-agent flow, which releases with it); else the form holds it.
   */
  readonly previewId?: string | undefined;
  readonly onPreviewChange?: (profileId: string) => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) =>
    onChange({ ...draft, [key]: value });
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
          <ModelSelect
            options={modelOptions(catalog.data.items, draft.model)}
            value={draft.model}
            error={errors.model}
            onChange={(model) => set("model", model)}
          />
          <BlockedTools
            model={draft.model}
            profiles={catalog.data.items}
            previewable={previewable}
            previewId={previewId}
            onPreviewChange={onPreviewChange}
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
              {LOCALE_NAMES[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </>
  );
}

function BlockedTools({
  model,
  profiles,
  previewable,
  previewId,
  onPreviewChange,
}: {
  readonly model: string;
  readonly profiles: readonly ProfileSummary[];
  readonly previewable: ((profile: ProfileSummary) => boolean) | undefined;
  readonly previewId: string | undefined;
  readonly onPreviewChange: ((profileId: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const candidates = previewProfiles(profiles, model, previewable);
  const [ownPick, setOwnPick] = useState<string>();
  const preview = chosenProfile(
    profiles,
    model,
    previewId ?? ownPick,
    previewable,
  );
  const resolved = preview?.id;
  const usable = previewable ?? pickable;
  const sharedGone =
    previewId !== undefined &&
    profiles.length > 0 &&
    !profiles.some((profile) => profile.id === previewId && usable(profile));
  const modelSeen = useRef(model);
  useEffect(() => {
    const modelChanged = modelSeen.current !== model;
    modelSeen.current = model;
    if (!modelChanged && !sharedGone) return;
    if (resolved !== undefined && resolved !== previewId) {
      onPreviewChange?.(resolved);
    }
  }, [model, sharedGone, resolved, previewId, onPreviewChange]);
  const deny = preview?.deny ?? null;
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label">{t("agentCard.blockedTools")}</FieldLegend>
      {candidates.length > 0 ? (
        <Field>
          <FieldLabel>{t("agentCard.previewProfile")}</FieldLabel>
          <NativeSelect
            value={preview?.id ?? ""}
            onChange={(event) => {
              setOwnPick(event.target.value);
              onPreviewChange?.(event.target.value);
            }}
          >
            <ProfileOptions profiles={candidates} />
          </NativeSelect>
          <FieldDescription>
            {t("agentCard.previewProfileHint")}
          </FieldDescription>
        </Field>
      ) : model === "" ? null : (
        <FieldDescription>{t("agentCard.noPreview")}</FieldDescription>
      )}
      {preview === undefined ? null : deny === null ? (
        <FieldDescription>{t("agentCard.blockedUnknown")}</FieldDescription>
      ) : deny.length === 0 ? (
        <FieldDescription>{t("agentCard.blockedNone")}</FieldDescription>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {deny.map((tool) => (
            <li key={tool}>
              <Badge variant="mono">{tool}</Badge>
            </li>
          ))}
        </ul>
      )}
      <FieldDescription>{t("agentCard.blockedHint")}</FieldDescription>
    </FieldSet>
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
    (option) => option.model === value && option.profileIds.length === 0,
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
            {option.profileIds.length === 0
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
