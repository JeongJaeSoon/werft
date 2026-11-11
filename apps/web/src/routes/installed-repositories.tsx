import { type components, isApiError } from "@werft-ai/client";
import {
  Button,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { useId } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

type AgentPage = components["schemas"]["ListAgentGitHubRepositoriesResponse"];
export type InstalledRepository = AgentPage["repositories"][number];

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

export function installedUnavailableKey(
  unavailable: string | null,
): MessageKey | null {
  return unavailable === null
    ? null
    : (UNAVAILABLE[unavailable] ?? "github.repo.pickNoInstallation");
}

export function InstallationSelect({
  page,
  onInstallation,
}: {
  readonly page: Pick<AgentPage, "installations" | "installation_id">;
  readonly onInstallation: (installationId: number) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
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

export function InstalledPageNav({
  page,
  shown,
  onPage,
}: {
  readonly page: Pick<AgentPage, "page" | "per_page" | "total_count">;
  readonly shown: number;
  readonly onPage: (page: number) => void;
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
        disabled={page.page <= 1}
        onClick={() => onPage(page.page - 1)}
      >
        {t("github.repo.previousPage")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page.page * page.per_page >= page.total_count}
        onClick={() => onPage(page.page + 1)}
      >
        {t("github.repo.nextPage")}
      </Button>
    </nav>
  );
}
