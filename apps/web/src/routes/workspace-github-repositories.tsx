import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  GitHubAppRole,
  GitHubSettingsConnection,
  ListGitHubRepositoriesResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { FormError } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { focusBack, RowMenu, RowMenuItem } from "../components/row-menu.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  installationUnusable,
  installedUnavailableKey,
  retryUnlessUnusable,
} from "./installed-repositories.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

export const repositoriesKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-repositories");

const PER_PAGE = 20;
const COLUMNS = "minmax(0,1fr) 112px 64px 32px";
const NARROW_COLUMNS = "minmax(0,1fr) 48px 32px";
const NARROW_ONLY = "[@container(width>=480px)]:hidden";

type CatalogRow = ListGitHubRepositoriesResponse["catalog"][number];

/** One page of one installation, and the whole catalog beside it. */
export function useRepositoryPage(
  installation: number | undefined,
  page: number,
  enabled = true,
) {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: [
      ...repositoriesKey(client, workspaceId),
      installation ?? null,
      page,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-repositories", {
          params: {
            path: { id: workspaceId },
            query: {
              ...(installation === undefined
                ? {}
                : { installation_id: installation }),
              page,
              per_page: PER_PAGE,
            },
          },
        }),
      ),
    enabled: enabled && workspaceId !== "",
    placeholderData: (previous) => previous,
    retry: retryUnlessUnusable,
  });
}

/**
 * The installation a page is read from before one is chosen: the first one
 * GitHub answers for, by account, of an author App, else of a reviewer App. Named,
 * since with several Apps of a role the server refuses to pick one, and the
 * catalog comes only with a page.
 */
export function defaultInstallation(
  connections: readonly GitHubSettingsConnection[],
): number | undefined {
  const usable = (role: GitHubSettingsConnection["role"]) =>
    connections
      .filter((held) => held.role === role)
      .flatMap((held) => held.installations)
      // Unknown: GitHub did not answer for its App, and a page of it fails.
      .filter(
        (installation) =>
          installation.status !== "suspended" &&
          installation.status !== "unknown",
      )
      .sort((a, b) => a.account.localeCompare(b.account) || a.id - b.id)[0]?.id;
  return usable("author") ?? usable("reviewer");
}

const installationRequired = (error: unknown) =>
  isApiError(error, "BAD_REQUEST") &&
  (error.details as { reason_code?: unknown } | null)?.reason_code ===
    "installation_required";

/** Catalog rows agents picked that no installation reaches now. */
export const outsideInstallations = (catalog: readonly CatalogRow[]) =>
  catalog.filter((row) => row.installed === false);

/**
 * The repositories sheet: an installation's repositories a page at a time,
 * and the ones agents picked that no installation reaches. It opens from
 * its own line, so it stays reachable once an installation is gone.
 */
export function RepositorySheet({
  open,
  onOpenChange,
  opener,
  connections,
  onOutcome,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly opener: HTMLElement | null;
  readonly connections: readonly GitHubSettingsConnection[];
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const [installation, setInstallation] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{
    readonly row: CatalogRow;
    readonly what: "branch" | "pins";
  } | null>(null);
  // Kept past the close: the dialog reads it as it closes.
  const [editOpener, setEditOpener] = useState<HTMLElement | null>(null);
  const edit = (
    row: CatalogRow,
    what: "branch" | "pins",
    from: HTMLElement | null,
  ) => {
    setEditOpener(from);
    setEditing({ row, what });
  };
  const selectId = useId();
  const outsideId = useId();
  const list = useRepositoryPage(
    installation ?? defaultInstallation(connections),
    page,
    open,
  );
  // The picked installation is gone or suspended: back to the first one.
  const gone =
    installation !== undefined &&
    (installationUnusable(list.error) ||
      (list.data !== undefined &&
        !list.data.installations.some((held) => held.id === installation)));
  useEffect(() => {
    if (!gone) return;
    setInstallation(undefined);
    setPage(1);
  }, [gone]);

  const appName = (connectionId: string) =>
    connections.find((held) => held.connection_id === connectionId)?.name ?? "";
  const data = list.data;
  const catalogOf = (catalogId: string | null) =>
    catalogId === null
      ? undefined
      : data?.catalog.find((row) => row.id === catalogId);
  const outside = data ? outsideInstallations(data.catalog) : [];
  const unavailable = data ? installedUnavailableKey(data.unavailable) : null;
  const from = data ? (data.page - 1) * data.per_page + 1 : 0;
  const to = data ? from + data.repositories.length - 1 : 0;
  const current = data?.installations.find(
    (held) => held.id === data.installation_id,
  );
  const tableName = current
    ? t("github.sheet.tableOf", {
        account: current.account,
        app: appName(current.connection_id),
      })
    : t("github.sheet.title");

  const menu = (row: CatalogRow | undefined, name: string) =>
    row ? (
      <RowMenu label={t("github.sheet.rowMenu", { name })}>
        {(close) => (
          <>
            <RowMenuItem onSelect={() => edit(row, "branch", close())}>
              {t("github.sheet.branch")}
            </RowMenuItem>
            {row.pins ? (
              <RowMenuItem onSelect={() => edit(row, "pins", close())}>
                {t("github.sheet.pins")}
              </RowMenuItem>
            ) : null}
          </>
        )}
      </RowMenu>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-none border-y-0 border-r-0 p-4 sm:max-w-[40rem]"
        onCloseAutoFocus={focusBack(opener)}
      >
        <div className="flex items-start gap-3">
          <DialogHeader className="min-w-0 flex-1">
            <DialogTitle>{t("github.sheet.title")}</DialogTitle>
            <DialogDescription>{t("github.sheet.hint")}</DialogDescription>
          </DialogHeader>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              {t("github.sheet.close")}
            </Button>
          </DialogClose>
        </div>
        {list.isPending ? (
          <Skeleton width="60%" />
        ) : installationRequired(list.error) ? (
          // Several Apps of a role and none installed: no page to name.
          <Text variant="sub">{t("github.repo.pickNoInstallation")}</Text>
        ) : list.isError && !gone ? (
          <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
        ) : data ? (
          <>
            {data.installations.length > 0 ? (
              <Field>
                <FieldLabel htmlFor={selectId}>
                  {t("github.repo.installation")}
                </FieldLabel>
                <NativeSelect
                  id={selectId}
                  size="sm"
                  value={String(data.installation_id ?? "")}
                  onChange={(event) => {
                    setInstallation(Number(event.target.value));
                    setPage(1);
                  }}
                >
                  {data.installation_id === null ? (
                    <NativeSelectOption value="" disabled>
                      {t("github.repo.installationChoose")}
                    </NativeSelectOption>
                  ) : null}
                  {data.installations.map((held) => (
                    <NativeSelectOption key={held.id} value={String(held.id)}>
                      {t("github.sheet.installation", {
                        account: held.account,
                        app: appName(held.connection_id),
                        count:
                          held.repository_count === null
                            ? "—"
                            : String(held.repository_count),
                      })}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {unavailable !== null ? (
              <Text variant="sub">{t(unavailable)}</Text>
            ) : data.repositories.length === 0 ? (
              <Text variant="sub">{t("github.repo.pickEmpty")}</Text>
            ) : (
              <>
                <GridTable
                  className="[--werft-row-padding-x:0px]"
                  aria-label={tableName}
                  columns={COLUMNS}
                  narrowAt={480}
                  narrowColumns={NARROW_COLUMNS}
                  framed={false}
                >
                  <GridTableHeader>
                    <GridTableColumnHeader>
                      {t("github.sheet.col.repository")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow>
                      {t("github.repo.branch")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader align="end">
                      {t("github.sheet.col.agents")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader>
                      <Text as="span" className="sr-only">
                        {t("github.sheet.col.menu")}
                      </Text>
                    </GridTableColumnHeader>
                  </GridTableHeader>
                  {data.repositories.map((repository) => {
                    const row = catalogOf(repository.catalog_id);
                    return (
                      <GridTableRow key={repository.github_repository_id}>
                        <GridTableCell {...{ role: "rowheader" }} lines>
                          <Text
                            as="span"
                            className="flex min-w-0 items-center gap-2"
                          >
                            <Text as="span" truncate>
                              {repository.full_name}
                            </Text>
                            {repository.private ? (
                              <Badge>{t("github.repo.private")}</Badge>
                            ) : null}
                          </Text>
                          <Text
                            as="span"
                            variant="meta"
                            truncate
                            className={NARROW_ONLY}
                          >
                            {row?.branch ?? repository.default_branch}
                          </Text>
                        </GridTableCell>
                        <GridTableCell hideNarrow>
                          <Text as="span" truncate>
                            {row?.branch ?? repository.default_branch}
                          </Text>
                        </GridTableCell>
                        <GridTableCell align="end">
                          {repository.agent_count}
                        </GridTableCell>
                        <GridTableCell align="end">
                          {menu(row, repository.full_name)}
                        </GridTableCell>
                      </GridTableRow>
                    );
                  })}
                </GridTable>
                {data.total_count > data.per_page || data.page > 1 ? (
                  <nav
                    aria-label={tableName}
                    className="flex items-center justify-end gap-2"
                  >
                    <Text as="span" variant="meta">
                      {t("github.repo.pageOf", {
                        from: Math.min(from, data.total_count),
                        to: Math.max(to, 0),
                        total: data.total_count,
                      })}
                    </Text>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={data.page <= 1}
                      onClick={() => setPage(data.page - 1)}
                    >
                      {t("github.repo.previousPage")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={data.page * data.per_page >= data.total_count}
                      onClick={() => setPage(data.page + 1)}
                    >
                      {t("github.repo.nextPage")}
                    </Button>
                  </nav>
                ) : null}
              </>
            )}
            {outside.length > 0 ? (
              <section
                aria-labelledby={outsideId}
                className="flex flex-col gap-2"
              >
                <Heading id={outsideId} level={3}>
                  {t("github.sheet.outside")}
                </Heading>
                <Text variant="meta">{t("github.sheet.outsideHint")}</Text>
                <GridTable
                  className="[--werft-row-padding-x:0px]"
                  aria-labelledby={outsideId}
                  columns={COLUMNS}
                  narrowAt={480}
                  narrowColumns={NARROW_COLUMNS}
                  framed={false}
                >
                  <GridTableHeader>
                    <GridTableColumnHeader>
                      {t("github.sheet.col.repository")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow>
                      {t("github.sheet.col.status")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader align="end">
                      {t("github.sheet.col.agents")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader>
                      <Text as="span" className="sr-only">
                        {t("github.sheet.col.menu")}
                      </Text>
                    </GridTableColumnHeader>
                  </GridTableHeader>
                  {outside.map((row) => {
                    const name = row.full_name ?? row.id;
                    return (
                      <GridTableRow key={row.id}>
                        <GridTableCell {...{ role: "rowheader" }} lines>
                          <Text as="span" truncate>
                            {name}
                          </Text>
                          <Text as="span" className={NARROW_ONLY}>
                            <Badge variant="amber">
                              {t("github.sheet.outsideBadge")}
                            </Badge>
                          </Text>
                        </GridTableCell>
                        <GridTableCell hideNarrow>
                          <Badge variant="amber">
                            {t("github.sheet.outsideBadge")}
                          </Badge>
                        </GridTableCell>
                        <GridTableCell align="end">
                          {row.agent_count}
                        </GridTableCell>
                        <GridTableCell align="end">
                          {menu(row, name)}
                        </GridTableCell>
                      </GridTableRow>
                    );
                  })}
                </GridTable>
              </section>
            ) : null}
          </>
        ) : null}
        <BranchDialog
          row={editing?.what === "branch" ? editing.row : null}
          opener={editOpener}
          onClose={() => setEditing(null)}
          onOutcome={onOutcome}
        />
        <PinsDialog
          row={editing?.what === "pins" ? editing.row : null}
          opener={editOpener}
          onClose={() => setEditing(null)}
          onOutcome={onOutcome}
        />
      </DialogContent>
    </Dialog>
  );
}

function useRefreshRepositories() {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return () =>
    queryClient.invalidateQueries({
      queryKey: repositoriesKey(client, workspaceId),
    });
}

function BranchDialog({
  row,
  opener,
  onClose,
  onOutcome,
}: {
  readonly row: CatalogRow | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const refresh = useRefreshRepositories();
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const name = row?.full_name ?? row?.id ?? "";
  const close = () => {
    setInvalid(false);
    setError(null);
    onClose();
  };
  const save = useMutation<unknown, ApiError, string>({
    mutationFn: (branch) =>
      unwrap(
        client.PATCH("/v1/workspaces/{id}/github-repositories/{repositoryId}", {
          params: { path: { id: workspaceId, repositoryId: row?.id ?? "" } },
          body: { branch, version: row?.version ?? 1 },
        }),
      ),
    onMutate: () => setError(null),
    onSuccess: async (_, branch) => {
      close();
      onOutcome({
        kind: "notice",
        text: t("github.repo.saved", { name, branch }),
      });
      await refresh();
    },
    onError: async (failure) => {
      if (
        isApiError(failure, "BAD_REQUEST") &&
        (failure.details as { reason_code?: unknown } | null)?.reason_code ===
          undefined
      ) {
        setInvalid(true);
        return;
      }
      setError(
        isApiError(failure, "REVISION_CONFLICT")
          ? t("github.repo.conflict")
          : refusalText(t, failure, "workspace.manage", role),
      );
      await refresh();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("branch");
    const branch = input instanceof HTMLInputElement ? input.value.trim() : "";
    // The server holds the full rule and answers 400 past it.
    if (branch === "" || /\s/.test(branch)) {
      setInvalid(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setInvalid(false);
    if (branch === row?.branch) close();
    else if (!save.isPending) save.mutate(branch);
  };
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent onCloseAutoFocus={focusBack(opener)}>
        <DialogHeader>
          <DialogTitle>{t("github.sheet.branchTitle", { name })}</DialogTitle>
        </DialogHeader>
        {error === null ? null : <FormError>{error}</FormError>}
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor={inputId}>{t("github.repo.branch")}</FieldLabel>
            <Input
              id={inputId}
              name="branch"
              autoComplete="off"
              spellCheck={false}
              defaultValue={row?.branch}
              aria-describedby={hintId}
              aria-invalid={invalid || undefined}
            />
            <FieldDescription id={hintId}>
              {t("github.repo.branchHint")}
            </FieldDescription>
            {invalid ? (
              <FieldError>{t("github.repo.branchInvalid")}</FieldError>
            ) : null}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" aria-disabled={save.isPending || undefined}>
              {t("github.repo.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Which connection of each role issues the repository's tokens. */
function PinsDialog({
  row,
  opener,
  onClose,
  onOutcome,
}: {
  readonly row: CatalogRow | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const refresh = useRefreshRepositories();
  const [error, setError] = useState<string | null>(null);
  const name = row?.full_name ?? row?.id ?? "";
  const candidates = useQuery({
    queryKey: [
      ...repositoriesKey(client, workspaceId),
      "pins",
      row?.id ?? null,
    ],
    queryFn: () =>
      unwrap(
        client.GET(
          "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins",
          {
            params: { path: { id: workspaceId, repositoryId: row?.id ?? "" } },
          },
        ),
      ),
    enabled: row !== null && workspaceId !== "",
  });
  const close = () => {
    setError(null);
    onClose();
  };
  const save = useMutation<
    unknown,
    ApiError,
    { role: GitHubAppRole; connectionId: string }
  >({
    mutationFn: ({ role: pinRole, connectionId }) =>
      unwrap(
        client.PUT(
          "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins/{role}",
          {
            params: {
              path: {
                id: workspaceId,
                repositoryId: row?.id ?? "",
                role: pinRole,
              },
            },
            body: { connection_id: connectionId },
          },
        ),
      ),
    onMutate: () => setError(null),
    onError: (failure) =>
      setError(refusalText(t, failure, "workspace.manage", role)),
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pins = candidates.data?.pins;
    if (!pins || save.isPending) return;
    const form = event.currentTarget.elements;
    const changed = (["author", "reviewer"] as const).flatMap((pinRole) => {
      const field = form.namedItem(pinRole);
      const value = field instanceof HTMLSelectElement ? field.value : "";
      return value && value !== pins[pinRole]
        ? [{ role: pinRole, connectionId: value }]
        : [];
    });
    try {
      for (const pin of changed) await save.mutateAsync(pin);
    } catch {
      await refresh();
      return;
    }
    close();
    if (changed.length > 0) {
      onOutcome({
        kind: "notice",
        text: t("github.sheet.pinsSaved", { name }),
      });
      await refresh();
    }
  };
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent onCloseAutoFocus={focusBack(opener)}>
        <DialogHeader>
          <DialogTitle>{t("github.sheet.pinsTitle", { name })}</DialogTitle>
          <DialogDescription>{t("github.sheet.pinsHint")}</DialogDescription>
        </DialogHeader>
        {error === null ? null : <FormError>{error}</FormError>}
        {candidates.isPending ? (
          <Skeleton width="60%" />
        ) : candidates.isError ? (
          <LoadFailure
            error={candidates.error}
            onRetry={() => void candidates.refetch()}
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            {(["author", "reviewer"] as const).map((pinRole) => (
              <PinField
                key={pinRole}
                pinRole={pinRole}
                pinned={candidates.data.pins[pinRole]}
                candidates={candidates.data.candidates.filter(
                  (candidate) => candidate.role === pinRole,
                )}
              />
            ))}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("github.repo.save")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PinField({
  pinRole,
  pinned,
  candidates,
}: {
  readonly pinRole: GitHubAppRole;
  readonly pinned: string | null;
  readonly candidates: readonly {
    readonly connection_id: string;
    readonly name: string;
    readonly installed: boolean | null;
  }[];
}) {
  const { t } = useI18n();
  const id = useId();
  if (candidates.length === 0) return null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(`github.role.${pinRole}`)}</FieldLabel>
      <NativeSelect id={id} name={pinRole} defaultValue={pinned ?? ""}>
        {pinned === null ? (
          <NativeSelectOption value="">
            {t("github.sheet.unpinned")}
          </NativeSelectOption>
        ) : null}
        {candidates.map((candidate) => (
          <NativeSelectOption
            key={candidate.connection_id}
            value={candidate.connection_id}
          >
            {candidate.installed === false
              ? t("github.sheet.notReaching", { name: candidate.name })
              : candidate.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}
