import { useMutation } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import type { PutEngineSettingsResponse } from "@werft-ai/contracts";
import {
  buttonVariants,
  Field,
  FieldLabel,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";
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
  readonly settings: EngineRules;
  /** The row's revision; null while nothing was saved. */
  readonly revision: number | null;
  /** Whether the installation accepts a save now. */
  readonly writesOpen: boolean;
  /** Why this person may not save, or undefined when they may. */
  readonly withheld: string | undefined;
  readonly save: (body: {
    expected_revision: number | null;
    settings: EngineRules;
  }) => Promise<PutEngineSettingsResponse>;
  /** Called after a save or a reload so the caller refetches the settings. */
  readonly refresh: () => Promise<unknown>;
  readonly children?: ReactNode;
}

/**
 * One rule per line in a box per list. Untouched, a box follows the server's
 * value as it refreshes; a typed draft stays until it is saved or discarded.
 */
export function EngineSettingsEditor({
  source,
  settings,
  revision,
  writesOpen,
  withheld,
  save,
  refresh,
  children,
}: EngineSettingsEditorProps) {
  const { t } = useI18n();
  const [typed, setTyped] = useState<EngineDraft | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [conflict, setConflict] = useState(false);
  const draft = typed ?? draftOf(settings);
  const dirty = isDirty(draft, settings);
  const readOnly = withheld !== undefined || !writesOpen;

  const mutation = useMutation<
    PutEngineSettingsResponse,
    ApiError,
    EngineRules
  >({
    mutationFn: (next) => save({ expected_revision: revision, settings: next }),
    onMutate: () => {
      setOutcome(null);
      setConflict(false);
    },
    onSuccess: async (_saved, sent) => {
      await refresh();
      // Keep anything typed while the save was in flight.
      setTyped((now) => (now !== null && isDirty(now, sent) ? now : null));
      setOutcome({ kind: "notice", text: t("engine.saved") });
    },
    onError: (error) => {
      if (error.code === "REVISION_CONFLICT") {
        setConflict(true);
        setOutcome({ kind: "error", text: t("engine.conflict") });
        return;
      }
      const { code, rule } = refusalOf(error);
      if (code === "engine_settings_writes_closed") {
        setOutcome({ kind: "error", text: t("engine.writesClosed") });
        // The page learns the gate shut now, not at the next visit.
        void refresh();
        return;
      }
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
    mutation.mutate(settingsOf(draft));
  };

  const reload = async () => {
    setTyped(null);
    setConflict(false);
    setOutcome(null);
    await refresh();
  };

  const group = (name: "permissions" | "auto_mode") => {
    const lists = ENGINE_LISTS.filter((list) => list.group === name);
    const count = lists.reduce((sum, list) => sum + countOf(draft, list), 0);
    const max = ENGINE_RULE_LIMITS[source][name];
    return (
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 flex w-full items-baseline justify-between gap-2 p-0 font-medium text-sm">
          <span>{t(`engine.group.${name}`)}</span>
          <Text as="span" variant="meta">
            {t("engine.group.count", { count, max })}
          </Text>
        </legend>
        <Text as="div" variant="meta">
          {t(`engine.list.${name}.hint` as MessageKey)}
        </Text>
        {lists.map((list) => (
          <ListBox
            key={listId(list)}
            list={list}
            value={draft[listId(list)] ?? ""}
            readOnly={readOnly}
            onChange={(text) => setTyped({ ...draft, [listId(list)]: text })}
          />
        ))}
      </fieldset>
    );
  };

  return (
    <form className="flex min-w-0 flex-col gap-6" onSubmit={submit}>
      <OutcomeLine outcome={outcome} />
      {writesOpen ? null : (
        <Text as="div" variant="meta">
          {t("engine.writesClosed")}
        </Text>
      )}
      {children}
      {group("permissions")}
      {group("auto_mode")}
      <div className="flex flex-wrap items-center gap-2">
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={withheld}
          // aria-disabled, not disabled: a disabled button drops its focus.
          aria-disabled={
            mutation.isPending || !dirty || !writesOpen || undefined
          }
        >
          {t(mutation.isPending ? "engine.saving" : "engine.save")}
        </ReasonButton>
        {conflict ? (
          <button
            type="button"
            className={buttonVariants({ size: "sm", variant: "outline" })}
            onClick={() => void reload()}
          >
            {t("engine.reload")}
          </button>
        ) : null}
        {readOnly ? (
          <Text as="span" variant="meta">
            {t("workspace.readOnlyMark")}
          </Text>
        ) : null}
        {!dirty && withheld === undefined && writesOpen ? (
          <Text as="span" variant="meta">
            {t("engine.unchanged")}
          </Text>
        ) : null}
      </div>
    </form>
  );
}

function ListBox({
  list,
  value,
  readOnly,
  onChange,
}: {
  readonly list: EngineList;
  readonly value: string;
  readonly readOnly: boolean;
  readonly onChange: (text: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {t(`engine.list.${listId(list)}` as MessageKey)}
      </FieldLabel>
      <Textarea
        id={id}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="font-mono"
        rows={3}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
