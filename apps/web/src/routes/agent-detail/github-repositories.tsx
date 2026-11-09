import { useQuery } from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  FieldError,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  Switch,
  Text,
} from "@werft-ai/ui";
import { useEffect, useId, useState } from "react";
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
  readonly key: string;
  /**
   * The React key and the key of the row's switch state. The name, because it
   * survives the catalog taking an installed-only repository (`key` changes
   * then); the id is added only for two rows that share a name.
   */
  readonly anchor: string;
  readonly name: string;
  readonly href: string;
  readonly private: boolean;
  readonly on: boolean;
  readonly blocked: Option["reason"] | "no_target" | null;
  readonly appMissing: boolean;
  readonly target: RepositoryTarget | null;
};

const GITHUB = "https://github.com/";
// Repository (name, badges, why it is locked) | the switch.
const REPOSITORY_COLUMNS = "minmax(0,1fr) 64px";

function pageOf(url: string | undefined, name: string): string {
  if (url?.startsWith("https://")) return url.replace(/\.git$/, "");
  return `${GITHUB}${name}`;
}

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
      anchor: "",
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
      anchor: "",
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
      anchor: "",
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
  const sorted = [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const seen = new Map<string, number>();
  for (const row of sorted) {
    const name = row.name.toLowerCase();
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return sorted.map((row) => {
    const name = row.name.toLowerCase();
    return {
      ...row,
      anchor: (seen.get(name) ?? 0) > 1 ? `${name}#${row.key}` : name,
    };
  });
}

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
  readonly chosen: readonly string[];
  readonly manages: boolean;
  readonly editable: boolean;
  readonly toggles: ReturnType<typeof useRepositoryToggles>;
}) {
  const { t } = useI18n();
  const idBase = useId();
  const { client } = useWerft();
  const [installation, setInstallation] = useState<number | undefined>();
  const [page, setPage] = useState(1);
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
        <div className="rounded-card border bg-card p-4">
          <Text as="span" variant="sub">
            {t("agentGitHub.repositoriesNone")}
          </Text>
        </div>
      ) : (
        <GridTable
          aria-label={t("github.repos.title")}
          columns={REPOSITORY_COLUMNS}
          framed
        >
          <GridTableHeader>
            <GridTableColumnHeader>
              {t("agentGitHub.table.repository")}
            </GridTableColumnHeader>
            <GridTableColumnHeader align="end">
              {t("agentGitHub.table.use")}
            </GridTableColumnHeader>
          </GridTableHeader>
          {rows.map((row, index) => {
            const on = toggles.wanted[row.anchor] ?? row.on;
            const disabled =
              !editable || row.blocked !== null || row.target === null;
            const reason =
              row.blocked !== null && row.blocked !== "no_target"
                ? t(`agentGitHub.repositoryReason.${row.blocked}`)
                : undefined;
            const refusal = toggles.errors[row.anchor];
            // The row's text reaches its switch, not only the live region.
            const reasonId = `${idBase}-${index}-reason`;
            const errorId = `${idBase}-${index}-error`;
            const described = [
              reason === undefined ? null : reasonId,
              refusal ? errorId : null,
            ]
              .filter((id) => id !== null)
              .join(" ");
            return (
              <GridTableRow
                // Not the catalog id: a new key after adoption drops focus.
                key={row.anchor}
              >
                <GridTableCell>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Link
                        href={row.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t("agentGitHub.repositoryOpen", {
                          name: row.name,
                        })}
                        className="font-medium [overflow-wrap:anywhere]"
                      >
                        {row.name}
                      </Link>
                      {row.private ? (
                        <Badge variant="gray">{t("agentGitHub.private")}</Badge>
                      ) : null}
                      {row.appMissing ? (
                        <Badge variant="amber">
                          {t("agentGitHub.appNotInstalled")}
                        </Badge>
                      ) : null}
                    </div>
                    {reason === undefined ? null : (
                      <Text as="span" variant="meta" id={reasonId}>
                        {reason}
                      </Text>
                    )}
                    {refusal ? (
                      <FieldError id={errorId}>{refusal}</FieldError>
                    ) : null}
                  </div>
                </GridTableCell>
                <GridTableCell align="end">
                  {manages ? (
                    <Switch
                      aria-label={t("agentGitHub.repositoryToggle", {
                        name: row.name,
                      })}
                      aria-describedby={described || undefined}
                      aria-invalid={refusal ? true : undefined}
                      checked={on}
                      disabled={disabled}
                      onCheckedChange={(checked) => {
                        if (row.target) {
                          toggles.toggle(row.anchor, row.target, checked);
                        }
                      }}
                    />
                  ) : (
                    <Text as="span" variant="sub">
                      {t(on ? "agentGitHub.on" : "agentGitHub.off")}
                    </Text>
                  )}
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
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
