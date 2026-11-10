import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWerft } from "@werft-ai/react";
import { Section, Skeleton, Text } from "@werft-ai/ui";
import { useId } from "react";
import {
  agentEngineSettingsKey,
  agentEngineSettingsQuery,
  putAgentEngineSettings,
} from "../../api/engine-settings.ts";
import { permissionReason, useRole } from "../../auth/guard.tsx";
import { EngineSettingsEditor } from "../../components/engine-settings-editor.tsx";
import {
  draftOf,
  ENGINE_LISTS,
  type EngineRules,
  listId,
} from "../../components/engine-settings-lists.ts";
import { LoadFailure } from "../../components/load-failure.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { type MessageKey, useI18n } from "../../i18n/i18n.tsx";

/**
 * An agent's own run rules, with what also applies to it beside them: the
 * workspace's rules (read only here), the restrictions its profile left, and
 * which allow entries reach nothing.
 */
export function EngineSettings({
  agentId,
  manages,
}: {
  readonly agentId: string;
  readonly manages: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const query = useQuery(agentEngineSettingsQuery(client, agentId));
  return (
    <Section
      title={t("engine.agent.title")}
      description={t("engine.agent.description")}
    >
      <div className={SECTION_BODY}>
        {query.isPending ? (
          <Skeleton width="60%" />
        ) : query.isError ? (
          <LoadFailure
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <EngineSettingsEditor
            source="agent"
            settings={query.data.settings}
            revision={query.data.settings_revision}
            writesOpen={query.data.writes_open}
            withheld={
              manages ? undefined : permissionReason(t, "agent.manage", role)
            }
            save={(body) => putAgentEngineSettings(client, agentId, body)}
            refresh={() =>
              queryClient.invalidateQueries({
                queryKey: agentEngineSettingsKey(client, agentId),
              })
            }
          >
            <Beside
              workspace={query.data.workspace.settings}
              inherited={query.data.inherited}
              reach={query.data.reach}
            />
          </EngineSettingsEditor>
        )}
      </div>
    </Section>
  );
}

function Beside({
  workspace,
  inherited,
  reach,
}: {
  readonly workspace: EngineRules;
  readonly inherited: { readonly entries: number; readonly rules: number };
  readonly reach: {
    readonly agent_allow_without_effect: {
      readonly permissions: readonly string[];
      readonly auto_mode_allow: readonly string[];
      readonly auto_mode_environment: readonly string[];
    };
    readonly workspace_allow_inactive: boolean;
  };
}) {
  const { t } = useI18n();
  const headingId = useId();
  const shown = ENGINE_LISTS.filter(
    (list) => draftOf(workspace)[listId(list)] !== "",
  );
  const unused = [
    ...reach.agent_allow_without_effect.permissions,
    ...reach.agent_allow_without_effect.auto_mode_allow,
    ...reach.agent_allow_without_effect.auto_mode_environment,
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section
        aria-labelledby={headingId}
        className="flex min-w-0 flex-col gap-2"
      >
        <Text as="div" variant="body" id={headingId} className="font-medium">
          {t("engine.workspaceRules.title")}
        </Text>
        <Text as="p" variant="meta">
          {t("engine.workspaceRules.hint")}
        </Text>
        {shown.length === 0 ? (
          <Text as="p" variant="meta">
            {t("engine.workspaceRules.empty")}
          </Text>
        ) : (
          <dl className="m-0 flex flex-col gap-3">
            {shown.map((list) => (
              <div key={listId(list)} className="min-w-0">
                <dt className="font-medium text-sm">
                  {t(`engine.list.${listId(list)}` as MessageKey)}
                </dt>
                <dd className="m-0 break-words font-mono text-xs">
                  {draftOf(workspace)
                    [listId(list)]?.split("\n")
                    .map((rule) => (
                      <div key={rule}>{rule}</div>
                    ))}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      {inherited.entries > 0 ? (
        <Text as="p" variant="meta">
          {t("engine.inherited", {
            entries: inherited.entries,
            rules: inherited.rules,
          })}
        </Text>
      ) : null}
      {reach.workspace_allow_inactive ? (
        <Text as="p" variant="meta">
          {t("engine.reach.inactive")}
        </Text>
      ) : null}
      {unused.length > 0 ? (
        <Text as="p" variant="meta">
          {t("engine.reach.withoutEffect", { entries: unused.join(", ") })}
        </Text>
      ) : null}
    </div>
  );
}
