import { useQuery } from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  FieldError,
  Link,
  RowList,
  SettingRow,
  Switch,
  Text,
} from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { LoadFailure } from "../../components/load-failure.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import {
  INSTALLED_PER_PAGE,
  InstallationSelect,
  InstalledPageNav,
  type InstalledRepository,
  installationUnusable,
  installedUnavailableKey,
  retryUnlessUnusable,
} from "../installed-repositories.tsx";
import type {
  RepositoryTarget,
  useRepositoryToggles,
} from "./github-repository-toggles.ts";

type GitHubTabData = components["schemas"]["AgentGitHubResponse"];
type Option = GitHubTabData["options"]["repositories"][number];

export type RepositoryRow = {
  /** Stable across a toggle: the catalog id once there is one. */
  readonly key: string;
  /** Keys the row's React element and its switch state; see `repositoryRows`. */
  readonly view: string;
  /** `owner/repo`. */
  readonly name: string;
  readonly href: string;
  readonly private: boolean;
  readonly on: boolean;
  /** Why it cannot be turned on, when it cannot. */
  readonly blocked: Option["reason"] | "no_target" | null;
  readonly appMissing: boolean;
  /** Null: the server has no handle for it yet and no installation lists it. */
  readonly target: RepositoryTarget | null;
};

const GITHUB = "https://github.com/";

/** The repository's page, from its clone URL when that is a web address. */
function pageOf(url: string | undefined, name: string): string {
  if (url?.startsWith("https://")) return url.replace(/\.git$/, "");
  return `${GITHUB}${name}`;
}

/**
 * One row per repository the agent may use: the catalog's, the selected ones
 * the catalog no longer lists, and the page of the App installation the
 * person is looking at. Sorted by name so a switch never moves its row.
 */
export function repositoryRows(
  data: GitHubTabData,
  chosen: readonly string[],
  installed: readonly InstalledRepository[],
  installationId: number | null,
): RepositoryRow[] {
  const rows = new Map<string, RepositoryRow>();
  const refs = new Map<string, string>();
  for (const held of data.selected_repositories ?? [])
    refs.set(held.id, held.ref);
  for (const option of data.options.repositories) {
    const on = chosen.includes(option.id);
    const ref = option.ref ?? refs.get(option.id);
    const name = option.repository ?? option.full_name ?? option.url;
    rows.set(option.id, {
      key: option.id,
      view: name.toLowerCase(),
      name,
      href: pageOf(option.url, name),
      private: option.private === true,
      on,
      blocked: !option.available && !on ? (option.reason ?? "no_target") : null,
      appMissing: option.installed.author === false,
      target: ref === undefined ? null : { ref },
    });
  }
  for (const held of data.selected_repositories ?? []) {
    if (rows.has(held.id)) continue;
    const name = held.repository ?? held.id;
    rows.set(held.id, {
      key: held.id,
      // Its own id too: a repository registered again under this name gets
      // the plain name, and must keep it when this dropped row goes away.
      view: `${name.toLowerCase()}#${held.id}`,
      name,
      href: `${GITHUB}${name}`,
      private: held.private === true,
      on: chosen.includes(held.id),
      blocked: null,
      appMissing: false,
      target: { ref: held.ref },
    });
  }
  // A page read before the catalog took a repository still says
  // `catalog_id: null`; the name finds the row the catalog now holds.
  const byName = new Map<string, RepositoryRow>();
  for (const row of rows.values()) {
    const name = row.name.toLowerCase();
    // The catalog's row, which comes first, wins over a dropped one.
    if (!byName.has(name)) byName.set(name, row);
  }
  for (const listed of installed) {
    const known =
      (listed.catalog_id === null ? undefined : rows.get(listed.catalog_id)) ??
      byName.get(listed.full_name.toLowerCase());
    if (known) {
      rows.set(known.key, {
        ...known,
        private: known.private || listed.private,
        target:
          known.target ??
          (installationId === null
            ? null
            : {
                installation_id: installationId,
                github_repository_id: listed.github_repository_id,
              }),
        // Listed by the installation, so there is a handle after all.
        blocked:
          known.blocked === "no_target" && installationId !== null
            ? null
            : known.blocked,
      });
      continue;
    }
    const key = listed.catalog_id ?? `gh:${listed.github_repository_id}`;
    rows.set(key, {
      key,
      view: listed.full_name.toLowerCase(),
      name: listed.full_name,
      href: `${GITHUB}${listed.full_name}`,
      private: listed.private,
      on: listed.catalog_id !== null && chosen.includes(listed.catalog_id),
      blocked: installationId === null ? "no_target" : null,
      appMissing: false,
      target:
        installationId === null
          ? null
          : {
              installation_id: installationId,
              github_repository_id: listed.github_repository_id,
            },
    });
  }
  return [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * The agent's repositories in one list: a link to each on GitHub and one
 * switch, saved as soon as it is flipped.
 */
export function RepositoryList({
  agentId,
  data,
  chosen,
  manages,
  editable,
  toggles,
}: {
  readonly agentId: string;
  readonly data: GitHubTabData;
  /** Catalog ids the settings name. */
  readonly chosen: readonly string[];
  readonly manages: boolean;
  readonly editable: boolean;
  readonly toggles: ReturnType<typeof useRepositoryToggles>;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [installation, setInstallation] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  // Only someone who manages the agent may read the App's installations.
  const list = useQuery({
    queryKey: [
      ...queryKeysOf(client).agent(agentId),
      "github",
      "repositories",
      installation ?? null,
      page,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github/repositories", {
          params: {
            path: { id: agentId },
            query: {
              ...(installation === undefined
                ? {}
                : { installation_id: installation }),
              page,
              per_page: INSTALLED_PER_PAGE,
            },
          },
        }),
      ),
    placeholderData: (previous) => previous,
    retry: retryUnlessUnusable,
    enabled: manages,
  });
  const gone = installation !== undefined && installationUnusable(list.error);
  useEffect(() => {
    if (!gone) return;
    setInstallation(undefined);
    setPage(1);
  }, [gone]);

  // A listed ceiling offers the tab's own repositories only.
  const own =
    list.data?.unavailable === "ceiling_listed" ||
    list.data?.unavailable === "no_active_release";
  const shown = own || list.data === undefined ? [] : list.data.repositories;
  const rows = repositoryRows(
    data,
    chosen,
    shown,
    list.data?.installation_id ?? null,
  );
  const unavailable = own
    ? null
    : installedUnavailableKey(list.data?.unavailable ?? null);

  return (
    <div className="flex flex-col gap-3">
      {list.isError ? (
        <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {unavailable ? (
        <Text as="span" variant="sub">
          {t(unavailable)}
        </Text>
      ) : null}
      {manages && list.data ? (
        <InstallationSelect
          page={list.data}
          onInstallation={(next) => {
            setInstallation(next);
            setPage(1);
          }}
        />
      ) : null}
      {rows.length === 0 ? (
        <Text as="span" variant="sub">
          {t("agentGitHub.repositoriesNone")}
        </Text>
      ) : (
        <RowList
          variant="joined"
          framed={false}
          aria-label={t("agentGitHub.section.repositories")}
        >
          {rows.map((row) => {
            const on = toggles.wanted[row.view] ?? row.on;
            const disabled =
              !editable || row.blocked !== null || row.target === null;
            return (
              <SettingRow
                // The view key, not the catalog id: that changes once the
                // catalog takes the repository, and a new key would drop the
                // switch's focus and the row's pending state.
                key={row.view}
                title={
                  <Link
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t("agentGitHub.repositoryOpen", { name: row.name })}
                    className="[overflow-wrap:anywhere]"
                  >
                    {row.name}
                  </Link>
                }
                badge={
                  <>
                    {row.private ? (
                      <Badge variant="gray">{t("agentGitHub.private")}</Badge>
                    ) : null}
                    {row.appMissing ? (
                      <Badge variant="amber">
                        {t("agentGitHub.appNotInstalled")}
                      </Badge>
                    ) : null}
                  </>
                }
                description={
                  row.blocked !== null && row.blocked !== "no_target"
                    ? t(`agentGitHub.repositoryReason.${row.blocked}`)
                    : undefined
                }
                meta={
                  toggles.errors[row.view] ? (
                    <FieldError>{toggles.errors[row.view]}</FieldError>
                  ) : undefined
                }
                actions={
                  manages ? (
                    <Switch
                      aria-label={t("agentGitHub.repositoryToggle", {
                        name: row.name,
                      })}
                      checked={on}
                      disabled={disabled}
                      onCheckedChange={(checked) => {
                        if (row.target) {
                          toggles.toggle(row.view, row.target, checked);
                        }
                      }}
                    />
                  ) : (
                    <Text as="span" variant="sub">
                      {t(on ? "agentGitHub.on" : "agentGitHub.off")}
                    </Text>
                  )
                }
              />
            );
          })}
        </RowList>
      )}
      {list.data && !own ? (
        <InstalledPageNav
          page={list.data}
          shown={list.data.repositories.length}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}
