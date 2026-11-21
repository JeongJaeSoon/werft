import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  RegisterSkillResponse,
  Skill,
  SkillList,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Code,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  Skeleton,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { Plus, Upload } from "lucide-react";
import { useState } from "react";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { SkillSourceIcon } from "../components/skill-source.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { FormDialog } from "./settings-entries.tsx";
import {
  MODE_LABEL,
  skillRefusalKey,
  skillsKey,
  skillsQuery,
  versionLabel,
} from "./skills-data.ts";
import { useGitHubSettings } from "./workspace-github-access.tsx";

// The upload route's cap (SKILL_UPLOAD_BODY_MAX_BYTES); the server refuses
// past it anyway, this only says so before the files are sent.
const UPLOAD_MAX_BYTES = 128 * 1024;

type UploadFile = { path: string; content_base64: string };
type UploadBody = { name: string; files: UploadFile[] };
type GitHubBody = {
  connection_id?: string;
  name: string;
  repository: string;
  path: string;
  ref: string;
};

// name with its source, latest version, pending, workspace attachment; a
// phone keeps the name (with the latest version) and the pending count.
const COLUMNS = [
  "minmax(0,1.4fr) minmax(0,1fr) max-content minmax(0,1fr)",
  "minmax(0,1fr) max-content",
] as const;

export function SkillsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("workspace.manage");
  const skills = useQuery(skillsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState<"upload" | "github" | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  return (
    <Page
      title={t("skills.title")}
      description={t("skills.description")}
      actions={
        manages ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={(event) => {
                setOutcome(null);
                setOpener(event.currentTarget);
                setAdding("upload");
              }}
            >
              <Upload aria-hidden="true" />
              {t("skills.upload")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={(event) => {
                setOutcome(null);
                setOpener(event.currentTarget);
                setAdding("github");
              }}
            >
              <Plus aria-hidden="true" />
              {t("skills.addGitHub")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <OutcomeLine outcome={outcome} live />
        {manages ? null : <Text variant="sub">{t("skills.readOnly")}</Text>}
        <SkillTable skills={skills} />
      </div>
      <UploadSkill
        open={adding === "upload"}
        opener={opener}
        onOpenChange={(open) => setAdding(open ? "upload" : null)}
        onOutcome={setOutcome}
      />
      <AddGitHubSkill
        open={adding === "github"}
        opener={opener}
        onOpenChange={(open) => setAdding(open ? "github" : null)}
        onOutcome={setOutcome}
      />
    </Page>
  );
}

function SkillTable({
  skills,
}: {
  readonly skills: UseQueryResult<SkillList>;
}) {
  const { t } = useI18n();
  if (skills.isPending)
    return <Skeleton width="60%" label={t("status.loading.title")} />;
  if (skills.isError)
    return (
      <LoadFailure error={skills.error} onRetry={() => void skills.refetch()} />
    );
  if (skills.data.items.length === 0)
    return <EmptyState framed title={t("skills.empty")} />;
  return (
    <GridTable
      // The settings layout zeroes the row inset; a framed table needs it.
      className="[--werft-row-padding-x:var(--werft-space-4)]"
      aria-label={t("skills.title")}
      columns={COLUMNS[0]}
      align={["start", "start", "end", "start"]}
      narrowAt={640}
      narrowColumns={COLUMNS[1]}
      framed
    >
      <GridTableHeader>
        <GridTableColumnHeader>{t("skills.column.name")}</GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("skills.column.latest")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("skills.column.pending")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("skills.column.workspace")}
        </GridTableColumnHeader>
      </GridTableHeader>
      {skills.data.items.map((skill) => (
        <SkillRow key={skill.name} skill={skill} />
      ))}
    </GridTable>
  );
}

function SkillRow({ skill }: { readonly skill: Skill }) {
  const { t } = useI18n();
  const latest = skill.versions.at(-1);
  const latestText = latest ? versionLabel(t, latest) : null;
  return (
    <GridTableRow>
      <GridTableCell>
        <div className="flex min-w-0 items-center gap-2">
          <SkillSourceIcon source={skill.source} />
          <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
            <TextLink asChild>
              <Link
                to="/settings/workspace/skills/$name"
                params={{ name: skill.name }}
                className="wrap-anywhere"
              >
                {skill.name}
              </Link>
            </TextLink>
            {skill.git ? (
              <Text as="span" variant="meta" className="wrap-anywhere">
                {skill.git.repository}
              </Text>
            ) : null}
            {latestText ? (
              <Text
                as="span"
                variant="meta"
                className="[@container(min-width:641px)]:hidden"
              >
                {latestText}
              </Text>
            ) : null}
          </div>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        {latestText ? (
          <Code className="wrap-anywhere">{latestText}</Code>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        {skill.pending_count > 0 ? (
          <Badge variant="amber">
            {t("skills.pendingCount", { count: skill.pending_count })}
          </Badge>
        ) : (
          <Text as="span" variant="meta">
            {t("skills.noPending")}
          </Text>
        )}
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta">
          {skill.workspace_attachment
            ? t(MODE_LABEL[skill.workspace_attachment.mode])
            : t("skills.notAttached")}
        </Text>
      </GridTableCell>
    </GridTableRow>
  );
}

/** A write on the skill list: refusals in the screen's words, the list re-read. */
export function useSkillWrite<V, A>(
  write: (variables: V) => Promise<A>,
  handlers: {
    readonly onDone: (answer: A, variables: V) => void;
    readonly onRefused: (text: string) => void;
  },
) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const role = useRole();
  return useMutation<A, ApiError, V>({
    mutationFn: write,
    onSuccess: (answer, variables) => handlers.onDone(answer, variables),
    onError: (error) => handlers.onRefused(skillRefusalText(t, error, role)),
    onSettled: () => cache.invalidateQueries({ queryKey: skillsKey(client) }),
  });
}

export function skillRefusalText(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  const known = skillRefusalKey(error);
  return known ? t(known) : refusalText(t, error, "workspace.manage", role);
}

function registeredText(t: Translate, answer: RegisterSkillResponse): string {
  const vars = {
    name: answer.version.name,
    version: answer.version.version ?? "",
  };
  if (answer.outcome === "already_registered")
    return t("skills.alreadyRegistered", vars);
  return answer.version.source === "github"
    ? t("skills.githubAdded", vars)
    : t("skills.uploaded", vars);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  // In slices: one call with every byte can pass the engine's argument limit.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** The picked directory's files, their paths without the directory's own name. */
async function uploadFilesOf(files: readonly File[]): Promise<UploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const relative = file.webkitRelativePath || file.name;
      const path = relative.includes("/")
        ? relative.slice(relative.indexOf("/") + 1)
        : relative;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { path, content_base64: base64Of(bytes) };
    }),
  );
}

function UploadSkill({
  open,
  opener,
  onOpenChange,
  onOutcome,
}: {
  readonly open: boolean;
  readonly opener: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [error, setError] = useState<string | null>(null);
  // Reading the files comes before the request; the dialog stays busy
  // through both so it can be neither closed nor sent twice meanwhile.
  const [reading, setReading] = useState(false);
  const upload = useSkillWrite(
    (body: UploadBody) =>
      unwrap(
        client.POST("/v1/workspace/skills", { body }),
      ) as Promise<RegisterSkillResponse>,
    {
      onDone: (answer) => {
        onOpenChange(false);
        onOutcome({ kind: "notice", text: registeredText(t, answer) });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={open}
      opener={opener}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      pending={reading || upload.isPending}
      title={t("skills.uploadDialog.title")}
      description={t("skills.uploadDialog.description")}
      gated
      error={error}
      submitLabel={t("skills.uploadDialog.submit")}
      pendingLabel={t("skills.uploadDialog.pending")}
      onSubmit={(form) => {
        setError(null);
        const picked = form.getAll("files").filter(
          // An empty picker sends one nameless File; an empty file keeps
          // its name and belongs to the skill.
          (item): item is File => item instanceof File && item.name !== "",
        );
        if (picked.length === 0) {
          setError(t("skills.uploadDialog.noFiles"));
          return;
        }
        setReading(true);
        uploadFilesOf(picked)
          .then((files) => {
            const body = { name: String(form.get("name")).trim(), files };
            if (JSON.stringify(body).length > UPLOAD_MAX_BYTES) {
              setError(t("skills.uploadDialog.tooLarge"));
              return;
            }
            upload.mutate(body);
          })
          .catch(() => setError(t("skills.uploadDialog.readFailed")))
          .finally(() => setReading(false));
      }}
    >
      <Field>
        <FieldLabel>{t("skills.uploadDialog.name")}</FieldLabel>
        <Input
          name="name"
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]{0,63}"
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("skills.uploadDialog.nameHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t("skills.uploadDialog.files")}</FieldLabel>
        <Input
          name="files"
          type="file"
          required
          multiple
          // React does not type the directory picker's attribute.
          {...{ webkitdirectory: "" }}
        />
        <FieldDescription>
          {t("skills.uploadDialog.filesHint")}
        </FieldDescription>
      </Field>
    </FormDialog>
  );
}

function AddGitHubSkill({
  open,
  opener,
  onOpenChange,
  onOutcome,
}: {
  readonly open: boolean;
  readonly opener: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [error, setError] = useState<string | null>(null);
  // The server picks the author App only while there is one; with several,
  // the request has to name it.
  const authors = (useGitHubSettings().data?.connections ?? []).filter(
    (connection) => connection.role === "author",
  );
  const add = useSkillWrite(
    (body: GitHubBody) =>
      unwrap(
        client.POST("/v1/workspace/skills/github", { body }),
      ) as Promise<RegisterSkillResponse>,
    {
      onDone: (answer) => {
        onOpenChange(false);
        onOutcome({ kind: "notice", text: registeredText(t, answer) });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={open}
      opener={opener}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      pending={add.isPending}
      title={t("skills.githubDialog.title")}
      description={t("skills.githubDialog.description")}
      gated
      error={error}
      submitLabel={t("skills.githubDialog.submit")}
      pendingLabel={t("skills.githubDialog.pending")}
      onSubmit={(form) => {
        setError(null);
        const connection = String(form.get("connection_id") ?? "");
        add.mutate({
          ...(connection ? { connection_id: connection } : {}),
          name: String(form.get("name")).trim(),
          repository: String(form.get("repository")).trim(),
          path: String(form.get("path"))
            .trim()
            .replace(/^\/+|\/+$/g, ""),
          ref: String(form.get("ref")).trim(),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("skills.uploadDialog.name")}</FieldLabel>
        <Input
          name="name"
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]{0,63}"
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("skills.uploadDialog.nameHint")}</FieldDescription>
      </Field>
      {authors.length > 1 ? (
        <Field>
          <FieldLabel>{t("skills.githubDialog.connection")}</FieldLabel>
          <NativeSelect name="connection_id" required defaultValue="">
            <NativeSelectOption value="" disabled>
              {t("agentSkills.pick")}
            </NativeSelectOption>
            {authors.map((connection) => (
              <NativeSelectOption
                key={connection.connection_id}
                value={connection.connection_id}
              >
                {connection.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field>
        <FieldLabel>{t("skills.githubDialog.repository")}</FieldLabel>
        <Input
          name="repository"
          required
          placeholder={t("skills.githubDialog.repositoryHint")}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field>
        <FieldLabel>{t("skills.githubDialog.path")}</FieldLabel>
        <Input name="path" autoComplete="off" spellCheck={false} />
        <FieldDescription>{t("skills.githubDialog.pathHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t("skills.githubDialog.ref")}</FieldLabel>
        <Input
          name="ref"
          required
          defaultValue="main"
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("skills.githubDialog.refHint")}</FieldDescription>
      </Field>
    </FormDialog>
  );
}
