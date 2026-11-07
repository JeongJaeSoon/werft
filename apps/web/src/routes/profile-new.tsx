import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ProfileSummary } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  EmptyState,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  Skeleton,
} from "@werft-ai/ui";
import { profilesQuery } from "../api/queries.ts";
import { permissionReason, useHasPermission, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { CeilingForm } from "./profile-ceiling-form.tsx";
import {
  allowsAuto,
  type EditorStart,
  ProfileEditor,
} from "./profile-editor.tsx";
import { installationOptionsQuery } from "./profile-tools.tsx";
import { latestVersion } from "./profile-tools-model.ts";
import { profileName } from "./profiles.tsx";

export interface ProfileNewSearch {
  /** The profile a new one starts from: its base, or the version it follows. */
  readonly from?: string;
  /** With `from`: the next version of it, or one made again on its changed base. */
  readonly mode?: "version";
}

export function profileNewSearch(
  search: Record<string, unknown>,
): ProfileNewSearch {
  const { from, mode } = search;
  return {
    ...(typeof from === "string" && from.length > 0 ? { from } : {}),
    ...(mode === "version" ? { mode } : {}),
  };
}

export function ProfileNewScreen() {
  const { t } = useI18n();
  const search = profileNewSearch(useSearch({ from: "/authed/profiles/new" }));
  const navigate = useNavigate();
  const { client } = useWerft();
  const role = useRole();
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  const profiles = useQuery(profilesQuery(client));
  const items = profiles.data?.items ?? [];
  const operators = items.filter((item) => item.source === "operator");
  const from =
    search.from === undefined
      ? undefined
      : items.find((item) => item.id === search.from);
  // An owner writes the whole profile; an admin clones one and narrows it.
  const kind = operates ? "installation" : "workspace";
  const options = useQuery({
    ...installationOptionsQuery(client),
    enabled: kind === "installation",
  });

  const versioned = search.mode !== undefined && from !== undefined;
  const title =
    kind === "installation"
      ? versioned
        ? t("profiles.new.ceilingVersionTitle", { name: profileName(from) })
        : t("profiles.new.ceilingTitle")
      : versioned
        ? t("profiles.editor.versionTitle", { name: profileName(from) })
        : t("profiles.create");

  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to="/profiles" activeOptions={{ exact: true }}>
          {t("profiles.title")}
        </Link>
      </PageBreadcrumbLink>
      {from ? (
        <PageBreadcrumbLink asChild>
          <Link to="/profiles/$profileId" params={{ profileId: from.id }}>
            {from.id}
          </Link>
        </PageBreadcrumbLink>
      ) : null}
      <PageBreadcrumbCurrent>{title}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );

  const opened = (id: string) =>
    void navigate({ to: "/profiles/$profileId", params: { profileId: id } });

  const body = () => {
    if (profiles.isPending) return <Skeleton width="60%" />;
    if (profiles.isError)
      return (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      );
    if (!manages && !operates)
      return (
        <Alert variant="amber" className="border-0">
          <AlertDescription>
            {permissionReason(t, "workspace.manage", role)}
          </AlertDescription>
        </Alert>
      );
    const missing =
      search.from !== undefined && from === undefined ? (
        <Alert variant="amber" className="border-0">
          <AlertDescription>
            {t("profiles.new.fromMissing", { id: search.from })}
          </AlertDescription>
        </Alert>
      ) : null;

    if (kind === "installation") {
      if (options.isPending) return <Skeleton width="60%" />;
      if (options.isError)
        return (
          <LoadFailure
            error={options.error}
            onRetry={() => void options.refetch()}
          />
        );
      if (
        options.data.connections.length === 0 ||
        options.data.runtimes.length === 0
      )
        return (
          <EmptyState
            title={t("profiles.new.cannotMake")}
            description={t(
              options.data.connections.length === 0
                ? "profiles.new.noConnections"
                : "profiles.new.noRuntimes",
            )}
          />
        );
      const template = from;
      return (
        <>
          {missing}
          <CeilingForm
            key={`${search.from}:${search.mode}`}
            options={options.data}
            operators={operators}
            template={template}
            previous={search.mode === "version" ? template : undefined}
            cancelTo={from?.id}
            onSaved={opened}
          />
        </>
      );
    }

    if (!manages)
      return (
        <Alert variant="amber" className="border-0">
          <AlertDescription>
            {permissionReason(t, "workspace.manage", role)}
          </AlertDescription>
        </Alert>
      );
    const bases = operators.filter(pickable);
    const firstBase = bases.find(allowsAuto) ?? bases[0];
    const start = workspaceStart(search, from, operators, firstBase);
    if (start === null)
      return (
        <EmptyState
          title={t("profiles.new.cannotMake")}
          description={t(
            search.mode === "version"
              ? "profiles.error.baseUnusable"
              : "profiles.new.noBase",
          )}
        />
      );
    return (
      <>
        {missing}
        <ProfileEditor
          key={`${search.from}:${search.mode}`}
          start={start}
          operators={operators}
          latest={(name) => latestVersion(items, name)}
          onCancel={() =>
            void navigate(
              from
                ? { to: "/profiles/$profileId", params: { profileId: from.id } }
                : { to: "/profiles" },
            )
          }
          onSaved={opened}
        />
      </>
    );
  };

  return (
    <Page
      breadcrumb={breadcrumb}
      title={title}
      description={t(
        kind === "installation"
          ? "profiles.new.ceilingDescription"
          : "profiles.editor.description",
      )}
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        {body()}
      </div>
    </Page>
  );
}

/** Where an admin's profile starts, or null when nothing usable is there to narrow. */
function workspaceStart(
  search: ProfileNewSearch,
  from: ProfileSummary | undefined,
  operators: readonly ProfileSummary[],
  firstBase: ProfileSummary | undefined,
): EditorStart | null {
  if (from !== undefined && search.mode === "version") {
    const base = operators.find(
      (item) => item.id === from.installation?.derived_from && pickable(item),
    );
    return base === undefined ? null : { mode: "version", from, base };
  }
  if (from !== undefined && pickable(from)) return { mode: "new", base: from };
  return firstBase === undefined ? null : { mode: "new", base: firstBase };
}
