import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWerft } from "@werft-ai/react";
import {
  Code,
  KeyValueList,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
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
import { type MessageKey, useI18n } from "../../i18n/i18n.tsx";

// The lists where an allow needs both the workspace and the agent.
const GRANT_IDS = [
  "permissions.allow",
  "auto_mode.allow",
  "auto_mode.environment",
] as const;

/**
 * An agent's own run rules, with what also applies to it beside them: the
 * workspace's rules (read only here) and which allow entries reach
 * nothing.
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
  const title = t("engine.agent.title");
  const description = t("engine.agent.description");
  if (query.data === undefined) {
    return (
      <SettingsSection title={title} description={description} box>
        {query.isError ? (
          <LoadFailure
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <Skeleton width="60%" />
        )}
      </SettingsSection>
    );
  }
  return (
    <>
      <Beside
        workspace={query.data.workspace.settings}
        agent={query.data.settings}
        reach={query.data.reach}
      />
      {/* A failed refetch keeps the editor: its unsaved draft is the work. */}
      {query.isError ? (
        <LoadFailure error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <EngineSettingsEditor
        source="agent"
        title={title}
        description={description}
        settings={query.data.settings}
        revision={query.data.settings_revision}
        withheld={
          manages ? undefined : permissionReason(t, "agent.manage", role)
        }
        save={(body) => putAgentEngineSettings(client, agentId, body)}
        refresh={() =>
          queryClient.invalidateQueries({
            queryKey: agentEngineSettingsKey(client, agentId),
          })
        }
      />
    </>
  );
}

/** Rules with a key that stays unique when a list repeats one. */
function keyed(rules: readonly string[]) {
  const seen = new Map<string, number>();
  return rules.map((rule) => {
    const nth = (seen.get(rule) ?? 0) + 1;
    seen.set(rule, nth);
    return { rule, key: `${nth}:${rule}` };
  });
}

function RuleLines({ rules }: { readonly rules: readonly string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {keyed(rules).map(({ rule, key }) => (
        <Code key={key} size="inherit" className="wrap-anywhere">
          {rule}
        </Code>
      ))}
    </div>
  );
}

function Beside({
  workspace,
  agent,
  reach,
}: {
  readonly workspace: EngineRules;
  readonly agent: EngineRules;
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
  const workspaceDraft = draftOf(workspace);
  const agentDraft = draftOf(agent);
  const name = (id: string) => t(`engine.list.${id}` as MessageKey);
  const shown = ENGINE_LISTS.filter((list) => workspaceDraft[listId(list)]);
  // Each allow list is named, so the note says which one does not reach.
  const inactive = reach.workspace_allow_inactive
    ? GRANT_IDS.filter((id) => workspaceDraft[id] && !agentDraft[id])
    : [];
  const withoutEffect = [
    ["permissions.allow", reach.agent_allow_without_effect.permissions],
    ["auto_mode.allow", reach.agent_allow_without_effect.auto_mode_allow],
    [
      "auto_mode.environment",
      reach.agent_allow_without_effect.auto_mode_environment,
    ],
  ].flatMap(([id, entries]) =>
    typeof id === "string" && Array.isArray(entries) && entries.length > 0
      ? [{ id, label: name(id), value: <RuleLines rules={entries} /> }]
      : [],
  );
  return (
    <SettingsSection
      title={t("engine.workspaceRules.title")}
      description={t("engine.workspaceRules.hint")}
      box
    >
      {shown.length === 0 ? (
        <Text as="div" variant="meta">
          {t("engine.workspaceRules.empty")}
        </Text>
      ) : (
        <KeyValueList
          variant="grid"
          stack="sm"
          items={shown.map((list) => ({
            id: listId(list),
            label: name(listId(list)),
            value: (
              <RuleLines
                rules={(workspaceDraft[listId(list)] ?? "").split("\n")}
              />
            ),
          }))}
        />
      )}
      {inactive.length > 0 ? (
        <Text as="div" variant="meta">
          {t("engine.reach.inactive", {
            lists: inactive.map(name).join(", "),
          })}
        </Text>
      ) : null}
      {withoutEffect.length > 0 ? (
        <>
          <Text as="div" variant="meta">
            {t("engine.reach.withoutEffect")}
          </Text>
          <KeyValueList variant="grid" stack="sm" items={withoutEffect} />
        </>
      ) : null}
    </SettingsSection>
  );
}
