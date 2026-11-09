import { type components, isApiError } from "@werft-ai/client";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  RowList,
  SettingRow,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

type AgentPage = components["schemas"]["ListAgentGitHubRepositoriesResponse"];
export type InstalledRepository = AgentPage["repositories"][number];
type Page<R> = Pick<
  AgentPage,
  "installations" | "installation_id" | "page" | "per_page" | "total_count"
> & {
  repositories: readonly R[];
  unavailable: string | null;
};

/** The page size the console asks for; GitHub allows up to 100. */
export const INSTALLED_PER_PAGE = 30;

const UNAVAILABLE: Record<string, MessageKey> = {
  no_author_app: "github.repo.pickNoApp",
  no_installation: "github.repo.pickNoInstallation",
  github_unavailable: "error.GITHUB_UNAVAILABLE",
  github_app_auth_failed: "error.GITHUB_UNAVAILABLE",
  installation_suspended: "error.INSTALLATION_SUSPENDED",
};

/** A picked installation GitHub no longer has, or has suspended. */
export const installationUnusable = (error: unknown) =>
  isApiError(error) &&
  (error.code === "INSTALLATION_SUSPENDED" ||
    (error.code === "NOT_FOUND" &&
      (error.details as { reason_code?: unknown } | null)?.reason_code ===
        "installation_not_found"));

/** react-query's default three retries, none for an unusable installation. */
export const retryUnlessUnusable = (failures: number, error: unknown) =>
  !installationUnusable(error) && failures < 3;

/** The text for a page GitHub could not list, or null when it listed. */
export function installedUnavailableKey(
  unavailable: string | null,
): MessageKey | null {
  return unavailable === null
    ? null
    : (UNAVAILABLE[unavailable] ?? "github.repo.pickNoInstallation");
}

/** The installation picker; nothing while there is only one to read. */
export function InstallationSelect({
  page,
  onInstallation,
  disabled = false,
}: {
  readonly page: Pick<Page<never>, "installations" | "installation_id">;
  readonly onInstallation: (installationId: number) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  const selectId = useId();
  // An empty default page may still list installations another can be read from.
  if (page.installations.length <= (page.installation_id === null ? 0 : 1)) {
    return null;
  }
  return (
    <Field>
      <FieldLabel htmlFor={selectId}>
        {t("github.repo.installation")}
      </FieldLabel>
      <NativeSelect
        id={selectId}
        size="sm"
        disabled={disabled}
        value={String(page.installation_id ?? "")}
        onChange={(event) => onInstallation(Number(event.target.value))}
      >
        {page.installation_id === null ? (
          <NativeSelectOption value="" disabled>
            {t("github.repo.installationChoose")}
          </NativeSelectOption>
        ) : null}
        {page.installations.map((installation) => (
          <NativeSelectOption
            key={installation.id}
            value={String(installation.id)}
          >
            {installation.role === "reviewer"
              ? t("github.repo.installationReviewer", {
                  account: installation.account,
                })
              : installation.account}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** Previous/next under a page; nothing while one page holds everything. */
export function InstalledPageNav({
  page,
  shown,
  onPage,
  disabled = false,
}: {
  readonly page: Pick<Page<never>, "page" | "per_page" | "total_count">;
  /** How many rows this page lists. */
  readonly shown: number;
  readonly onPage: (page: number) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  if (page.total_count <= page.per_page && page.page <= 1) return null;
  const from = (page.page - 1) * page.per_page + 1;
  const to = from + shown - 1;
  return (
    <nav
      aria-label={t("github.repo.pickTitle")}
      className="flex items-center justify-end gap-2"
    >
      <span className="text-caption text-subtle-foreground">
        {t("github.repo.pageOf", {
          from: Math.min(from, page.total_count),
          to: Math.max(to, 0),
          total: page.total_count,
        })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || page.page <= 1}
        onClick={() => onPage(page.page - 1)}
      >
        {t("github.repo.previousPage")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || page.page * page.per_page >= page.total_count}
        onClick={() => onPage(page.page + 1)}
      >
        {t("github.repo.nextPage")}
      </Button>
    </nav>
  );
}

/**
 * One page of the repositories an installation of the author App reaches,
 * as GitHub pages them: an installation picker when there are several, the
 * rows, and previous/next.
 */
export function InstalledRepositoryPage<R extends InstalledRepository>({
  page,
  onInstallation,
  onPage,
  meta,
  action,
}: {
  readonly page: Page<R>;
  readonly onInstallation: (installationId: number) => void;
  readonly onPage: (page: number) => void;
  readonly meta?: (repository: R) => ReactNode;
  readonly action?: (repository: R) => ReactNode;
}) {
  const { t } = useI18n();
  const picker = (
    <InstallationSelect page={page} onInstallation={onInstallation} />
  );
  if (page.unavailable !== null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-caption">
          {t(UNAVAILABLE[page.unavailable] ?? "github.repo.pickNoInstallation")}
        </p>
        {picker}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {picker}
      {page.repositories.length === 0 ? (
        <p className="m-0 text-caption">{t("github.repo.pickEmpty")}</p>
      ) : (
        <RowList variant="joined">
          {page.repositories.map((repository) => (
            <SettingRow
              key={repository.github_repository_id}
              title={repository.full_name}
              badge={
                repository.private ? (
                  <Badge>{t("github.repo.private")}</Badge>
                ) : null
              }
              description={`${t("github.repo.branch")} ${repository.default_branch}`}
              meta={meta?.(repository)}
              actions={action?.(repository)}
            />
          ))}
        </RowList>
      )}
      <InstalledPageNav
        page={page}
        shown={page.repositories.length}
        onPage={onPage}
      />
    </div>
  );
}
