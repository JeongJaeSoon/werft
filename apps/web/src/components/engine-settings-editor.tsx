import { useMutation } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import type { PutEngineSettingsResponse } from "@werft-ai/contracts";
import {
  Button,
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  SettingsSection,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { refusalOf } from "../api/engine-settings.ts";
import { ReasonButton } from "../auth/reason-button.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import {
  countOf,
  draftOf,
  ENGINE_LISTS,
  type EngineDraft,
  type EngineList,
  type EngineRules,
  isDirty,
  listId,
  lockedIds,
  settingsOf,
} from "./engine-settings-lists.ts";
import { type Outcome, OutcomeLine } from "./outcome.tsx";

// What one source may save per group; the web takes contracts as types only,
// so a test keeps these equal to ENGINE_SETTINGS_LIMITS.
export const ENGINE_RULE_LIMITS = {
  workspace: { permissions: 48, auto_mode: 16 },
  agent: { permissions: 24, auto_mode: 16 },
} as const;

const REFUSALS = [
  "rule_syntax",
  "rule_no_effect",
  "rule_too_long",
  "too_many_rules",
  "auto_mode_rule_syntax",
  "mcp_rule_verdict",
  "settings_too_large",
  "engine_settings_catalog_ambiguous",
  "engine_settings_catalog_unavailable",
] as const;

export interface EngineSettingsEditorProps {
  readonly source: "workspace" | "agent";
  readonly title: string;
  readonly description: string;
  readonly settings: EngineRules;
  /** The row's revision; null while nothing was saved. */
  readonly revision: number | null;
  /** Why this person may not save, or undefined when they may. */
  readonly withheld: string | undefined;
  readonly save: (body: {
    expected_revision: number | null;
    settings: EngineRules;
  }) => Promise<PutEngineSettingsResponse>;
  /** Called after a save or a reload so the caller refetches the settings. */
  readonly refresh: () => Promise<unknown>;
}

/**
 * One rule per line in a box per list. Untouched, a box follows the server's
 * value as it refreshes; a typed draft stays until it is saved or discarded.
 * The boxes sit in one bordered section and the save row under it, as the
 * settings page's other sections do.
 */
export function EngineSettingsEditor({
  source,
  title,
  description,
  settings,
  revision,
  withheld,
  save,
  refresh,
}: EngineSettingsEditorProps) {
  const { t } = useI18n();
  const readOnlyId = useId();
  // A draft keeps the revision it was started from: a refetch that brings a
  // newer revision must not make the save look like it saw those rules.
  const [typed, setTyped] = useState<{
    readonly draft: EngineDraft;
    readonly base: number | null;
  } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [conflict, setConflict] = useState(false);
  const draft = typed?.draft ?? draftOf(settings);
  const locked = lockedIds(settings);
  const dirty = isDirty(draft, settings);
  const readOnly = withheld !== undefined;

  const mutation = useMutation<
    PutEngineSettingsResponse,
    ApiError,
    EngineRules
  >({
    mutationFn: (next) =>
      save({
        expected_revision: typed ? typed.base : revision,
        settings: next,
      }),
    onMutate: () => {
      setOutcome(null);
      setConflict(false);
    },
    onSuccess: async (saved, sent) => {
      await refresh();
      // Keep anything typed while the save was in flight, now based on it.
      setTyped((now) =>
        now !== null && isDirty(now.draft, sent)
          ? { draft: now.draft, base: saved.settings_revision }
          : null,
      );
      setOutcome({ kind: "notice", text: t("engine.saved") });
    },
    onError: (error) => {
      if (error.code === "REVISION_CONFLICT") {
        setConflict(true);
        setOutcome({ kind: "error", text: t("engine.conflict") });
        return;
      }
      const { code, rule } = refusalOf(error);
      const known = REFUSALS.find((name) => name === code);
      const reason = t(
        known
          ? (`engine.refused.${known}` as MessageKey)
          : "engine.refused.other",
      );
      setOutcome({
        kind: "error",
        text:
          rule === null
            ? t("engine.refused", { reason })
            : t("engine.refusedRule", {
                reason: t("engine.refused", { reason }),
                rule,
              }),
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mutation.isPending || readOnly || !dirty) return;
    mutation.mutate(settingsOf(draft, settings));
  };

  const reload = async () => {
    setTyped(null);
    setConflict(false);
    setOutcome(null);
    await refresh();
  };

  // What explains a box that cannot be typed in, read with the box.
  const describedBy = readOnly ? readOnlyId : undefined;

  const group = (name: "permissions" | "auto_mode") => {
    const lists = ENGINE_LISTS.filter((list) => list.group === name);
    // The server's limit is per list, not per group.
    const max = ENGINE_RULE_LIMITS[source][name];
    return (
      <FieldSet className="gap-3">
        <FieldLegend className="mb-0">{t(`engine.group.${name}`)}</FieldLegend>
        <FieldDescription>
          {t(`engine.list.${name}.hint` as MessageKey)}
        </FieldDescription>
        {lists.map((list) => (
          <ListBox
            key={listId(list)}
            list={list}
            value={draft[listId(list)] ?? ""}
            count={countOf(draft, list, settings)}
            max={max}
            locked={locked.has(listId(list))}
            readOnly={readOnly}
            describedBy={describedBy}
            onChange={(text) =>
              setTyped({
                draft: { ...draft, [listId(list)]: text },
                base: typed ? typed.base : revision,
              })
            }
          />
        ))}
      </FieldSet>
    );
  };

  return (
    <SettingsSection
      title={title}
      description={description}
      box
      onSubmit={submit}
      foot={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ReasonButton
              type="submit"
              className={buttonVariants({ size: "sm" })}
              reason={withheld}
              // aria-disabled, not disabled: a disabled button drops its focus.
              aria-disabled={mutation.isPending || !dirty || undefined}
            >
              {t(mutation.isPending ? "engine.saving" : "engine.save")}
            </ReasonButton>
            {conflict ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void reload()}
              >
                {t("engine.reload")}
              </Button>
            ) : null}
            {!dirty && withheld === undefined ? (
              <Text as="span" variant="meta">
                {t("engine.unchanged")}
              </Text>
            ) : null}
          </div>
          {readOnly ? (
            <Text as="span" variant="meta" id={readOnlyId}>
              {t("workspace.readOnlyMark")}
            </Text>
          ) : null}
        </>
      }
    >
      <OutcomeLine outcome={outcome} />
      {group("permissions")}
      {group("auto_mode")}
    </SettingsSection>
  );
}

function ListBox({
  list,
  value,
  count,
  max,
  locked,
  readOnly,
  describedBy,
  onChange,
}: {
  readonly list: EngineList;
  readonly value: string;
  readonly count: number;
  readonly max: number;
  readonly locked: boolean;
  readonly readOnly: boolean;
  readonly describedBy: string | undefined;
  readonly onChange: (text: string) => void;
}) {
  const { t } = useI18n();
  const inert = readOnly || locked;
  // Field wires the label and every FieldDescription to the box.
  return (
    <Field>
      <FieldLabel>{t(`engine.list.${listId(list)}` as MessageKey)}</FieldLabel>
      <Textarea
        value={value}
        readOnly={inert}
        aria-describedby={describedBy}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        // A box that cannot be typed in reads as a value, not a field.
        className="font-mono read-only:bg-muted read-only:text-muted-foreground read-only:hover:border-input"
        rows={3}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        {t("engine.list.count", { count, max })}
      </FieldDescription>
      {locked ? (
        <FieldDescription>{t("engine.multiline")}</FieldDescription>
      ) : null}
    </Field>
  );
}
