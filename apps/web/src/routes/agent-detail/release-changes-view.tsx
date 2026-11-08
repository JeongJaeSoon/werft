import type { AgentRelease } from "@werft-ai/contracts";
import {
  Badge,
  Button,
  Code,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Heading,
  KeyValueList,
  RelativeTime,
  Text,
} from "@werft-ai/ui";
import type { ReactNode } from "react";
import { useProfileDisplay } from "../../components/profile-options.tsx";
import { RevisionDiff } from "../../components/revision-diff.tsx";
import { withNodes } from "../../components/with-nodes.tsx";
import { type MessageKey, useI18n } from "../../i18n/i18n.tsx";
import {
  RELEASE_AREAS,
  type ReleaseArea,
  type ReleaseChange,
} from "./release-changes.ts";

const AREA: Record<ReleaseArea, MessageKey> = {
  repositories: "agent.releases.area.repositories",
  model: "agent.releases.area.model",
  tools: "agent.releases.area.tools",
  prompt: "agent.releases.area.prompt",
  settings: "agent.releases.area.settings",
  secrets: "agent.releases.area.secrets",
};

const FIELD: Record<string, MessageKey> = {
  repositories: "agent.releases.field.repositories",
  model: "agent.releases.field.model",
  tools: "agent.releases.field.tools",
  toolPolicy: "agent.releases.field.toolPolicy",
  instructions: "agent.releases.field.instructions",
  profile: "agent.releases.field.profile",
  profileDigest: "agent.releases.field.profileDigest",
  pushApproval: "agent.releases.field.pushApproval",
  actionsAllow: "agent.releases.field.actionsAllow",
  rules: "agent.releases.field.rules",
  language: "agent.releases.field.language",
  card: "agent.releases.field.card",
};

// What a missing value means differs by field: no pin is the profile's range.
const ABSENT: Record<string, MessageKey> = {
  repositories: "agent.releases.absent.profileRepositories",
};

// A badge keeps to one line by default; a long repository name must wrap.
const WRAP = "h-auto min-h-5 max-w-full shrink whitespace-normal wrap-anywhere";

const fieldKey = (change: ReleaseChange) =>
  "key" in change.field ? change.field.key : "";

/** The changed areas on one line, the dialog's trigger in the table. */
export function ReleaseChangesSummary({
  release,
  previous,
  changes,
  by,
}: {
  readonly release: AgentRelease;
  /** Undefined for the agent's first release. */
  readonly previous: AgentRelease | undefined;
  readonly changes: readonly ReleaseChange[];
  readonly by: string;
}) {
  const { t, locale } = useI18n();
  if (previous === undefined)
    return (
      <Text as="span" variant="meta">
        {t("agent.releases.changesFirst")}
      </Text>
    );
  if (changes.length === 0)
    return (
      <Text as="span" variant="meta">
        {t("agent.releases.changesNone")}
      </Text>
    );
  const areas = RELEASE_AREAS.filter((area) =>
    changes.some((change) => change.area === area),
  )
    .map((area) => t(AREA[area]))
    .join(" · ");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto min-w-0 justify-start whitespace-normal px-0 text-left text-caption"
        >
          {t("agent.releases.changesSummary", { areas })}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[40rem]">
        <DialogHeader>
          <DialogTitle>
            {t("agent.releases.changesTitle", { release: release.label })}
          </DialogTitle>
          <DialogDescription>
            {withNodes((vars) => t("agent.releases.changesAgainst", vars), {
              previous: <Code>{previous.label}</Code>,
              by,
              at: <RelativeTime value={release.created_at} locale={locale} />,
            })}
          </DialogDescription>
        </DialogHeader>
        <ReleaseChangeList
          changes={changes}
          beforeLabel={previous.label}
          afterLabel={release.label}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("agent.releases.changesClose")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReleaseChangeList({
  changes,
  beforeLabel,
  afterLabel,
}: {
  readonly changes: readonly ReleaseChange[];
  readonly beforeLabel: string;
  readonly afterLabel: string;
}) {
  const { t } = useI18n();
  const profile = useProfileDisplay();
  const absent = (change: ReleaseChange) =>
    t(ABSENT[fieldKey(change)] ?? "agent.releases.absent.none");
  const shownValue = (change: ReleaseChange): ReactNode => {
    switch (change.kind) {
      case "list":
        return (
          <div className="flex min-w-0 flex-wrap gap-1">
            {change.added.map((item) => (
              <Badge key={`+${item}`} variant="green" className={WRAP}>
                {t("agent.releases.added", { item })}
              </Badge>
            ))}
            {change.removed.map((item) => (
              <Badge key={`-${item}`} variant="red" className={WRAP}>
                {t("agent.releases.removed", { item })}
              </Badge>
            ))}
          </div>
        );
      case "value": {
        // The change itself compares ids; only what is shown is the name.
        const shown = (value: string | null) =>
          value === null
            ? absent(change)
            : fieldKey(change) === "profile"
              ? profile.show(value)
              : value;
        return (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1">
            {withNodes((vars) => t("agent.releases.valueChange", vars), {
              before: (
                <Code className="wrap-anywhere">{shown(change.before)}</Code>
              ),
              after: (
                <Code className="wrap-anywhere">{shown(change.after)}</Code>
              ),
            })}
          </div>
        );
      }
      case "text":
        return (
          <RevisionDiff
            before={change.before}
            after={change.after}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        );
      case "changed":
        return <Badge variant="amber">{t("agent.releases.changed")}</Badge>;
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {RELEASE_AREAS.map((area) => {
        const mine = changes.filter((change) => change.area === area);
        if (mine.length === 0) return null;
        return (
          <section
            key={area}
            aria-label={t(AREA[area])}
            className="flex min-w-0 flex-col gap-2"
          >
            <Heading level={3} size="section">
              {t(AREA[area])}
            </Heading>
            {area === "secrets" ? (
              <Text as="div" variant="meta">
                {t("agent.releases.secretsHidden")}
              </Text>
            ) : null}
            <KeyValueList
              variant="grid"
              stack="sm"
              items={mine.map((change, index) => ({
                id: `${area}-${index}`,
                label:
                  "path" in change.field ? (
                    <Code className="wrap-anywhere">{change.field.path}</Code>
                  ) : (
                    t(FIELD[change.field.key] ?? "agent.releases.field.card")
                  ),
                value: shownValue(change),
              }))}
            />
          </section>
        );
      })}
    </div>
  );
}
