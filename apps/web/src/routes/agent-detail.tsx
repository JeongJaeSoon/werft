import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type { AgentDetail } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
  buttonVariants,
  Page,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { agentQuery } from "../api/queries.ts";
import {
  ManagesAgentProvider,
  useAgentAccess,
} from "../components/agent-access.tsx";
import { AgentAvatar } from "../components/agent-avatar.tsx";
import { OwnerlessAlert } from "../components/agent-ownerless.tsx";
import {
  PreviewDialog,
  PublishDialog,
  previewRelease,
} from "../components/agent-preview.tsx";
import { AgentStateBadge } from "../components/agent-state.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { AccessTab } from "./agent-detail/access-tab.tsx";
import { AdminsTab } from "./agent-detail/admins-tab.tsx";
import { AgentNotFound } from "./agent-detail/agent-not-found.tsx";
import { CardTab } from "./agent-detail/card-tab.tsx";
import { CodexSandboxAlert } from "./agent-detail/codex-sandbox.tsx";
import { ConversationsTab } from "./agent-detail/conversations.tsx";
import { saveFailureText } from "./agent-detail/effective-behavior.tsx";
import { GitHubPanel, SlackPanel } from "./agent-detail/lazy-tabs.tsx";
import {
  AGENT_TABS,
  type AgentTab,
  agentSearch,
  useAgentTabs,
} from "./agent-detail/navigation.ts";
import {
  NewSessionButton,
  NewSessionReason,
  useNewSessionStart,
} from "./agent-detail/new-session.tsx";
import { OverviewTab } from "./agent-detail/overview-tab.tsx";
import {
  type Place,
  type Placed,
  PlacedOutcome,
} from "./agent-detail/placement.tsx";
import {
  ReleaseTab,
  useReleaseActivation,
} from "./agent-detail/release-tab.tsx";
import { shownVersion } from "./agent-detail/versions.tsx";

// Console v4: 24px under the tabs, sections 32px apart.
const PANEL = "@container flex flex-col gap-8 pt-2";

export function AgentDetailScreen() {
  const { id } = useParams({ from: "/authed/agents/$id" });
  // The route component is reused between agents; a fresh page per id keeps
  // one agent's unsaved edits from being saved onto another.
  return <AgentDetailPage key={id} id={id} />;
}

function AgentDetailPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const search = useSearch({ from: "/authed/agents/$id" });
  const { client } = useWerft();
  const detail = useQuery(agentQuery(client, id));
  const [placed, setPlaced] = useState<Placed | null>(() =>
    search.notice === "created"
      ? { at: "page", outcome: { kind: "notice", text: t("agent.created") } }
      : null,
  );

  if (detail.isPending) return <StatusScreen kind="loading" />;
  if (detail.error) {
    if (
      isApiError(detail.error, "NOT_FOUND") ||
      isApiError(detail.error, "FORBIDDEN")
    )
      return <AgentNotFound />;
    // A rollback whose outcome could not be read leaves its notice here too.
    return (
      <>
        <PlacedOutcome placed={placed} at={placed?.at ?? "page"} />
        <LoadFailure
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </>
    );
  }
  return (
    <AgentView
      detail={detail.data}
      placed={placed}
      onPlaced={setPlaced}
      onReload={() => detail.refetch()}
    />
  );
}

function AgentView({
  detail,
  placed,
  onPlaced,
  onReload,
}: {
  readonly detail: AgentDetail;
  readonly placed: Placed | null;
  readonly onPlaced: (placed: Placed | null) => void;
  readonly onReload: () => void;
}) {
  const { t } = useI18n();
  // Validated again: the root route passes the raw query through, so an
  // unknown `tab` still reaches this route's search.
  const urlTab: AgentTab =
    agentSearch(useSearch({ from: "/authed/agents/$id" })).tab ?? "overview";
  const navigate = useNavigate({ from: "/agents/$id" });
  const { tab, open, openPlace, hasShown } = useAgentTabs(urlTab, (next) => {
    void navigate({
      search: ({ tab: _, ...rest }) =>
        next === "overview" ? rest : { ...rest, tab: next },
      replace: true,
    });
  });
  const outcomeAt = (at: Place) => (outcome: Outcome | null) => {
    onPlaced(outcome ? { at, outcome } : null);
    // A request can finish after the person moved to another tab.
    if (outcome) openPlace(at);
  };
  const { agent } = detail;
  const access = useAgentAccess(agent);
  const manages = access === "manage";
  const releaseTab = useRef<HTMLButtonElement>(null);
  const credentialsTitle = useRef<HTMLHeadingElement>(null);
  const activation = useReleaseActivation({
    detail,
    onOutcome: outcomeAt("releases"),
    openRelease: () => open("release"),
  });
  const newSession = useNewSessionStart(detail);

  // Every panel stays mounted, so leaving a tab never drops an unsaved card;
  // Radix leaves a force-mounted panel visible and in the tab order.
  const tabPanel = (name: AgentTab) => ({
    value: name,
    forceMount: true as const,
    hidden: name !== tab,
    tabIndex: name === tab ? 0 : -1,
    className: PANEL,
  });
  const tabRow = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the tab changes
  useEffect(() => {
    tabRow.current
      ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);
  // The tab it opens is where the keyboard goes next, not this button.
  const toRelease = (
    <Button
      type="button"
      variant="outline"
      className="self-start"
      onClick={() => open("release", releaseTab)}
    >
      {t("agent.tabs.toRelease")}
    </Button>
  );

  const body = (
    <Tabs
      value={tab}
      onValueChange={(next) => open(next as AgentTab)}
      className="min-w-0 gap-[var(--werft-space-block)]"
    >
      {/* overflow-y-hidden: the active underline overhangs the row by 1px, and
          overflow-x alone makes y `auto` (a vertical scrollbar where scrollbars
          take space). */}
      <div ref={tabRow} className="overflow-x-auto overflow-y-hidden border-b">
        <TabsList variant="line" aria-label={t("agent.tabs.label")}>
          {AGENT_TABS.map((name) => (
            <TabsTrigger
              key={name}
              value={name}
              ref={name === "release" ? releaseTab : undefined}
            >
              {t(`agent.tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent {...tabPanel("overview")}>
        <OverviewTab detail={detail} toRelease={toRelease} />
      </TabsContent>
      <TabsContent {...tabPanel("conversations")}>
        <ConversationsTab
          agentId={agent.id}
          manages={manages}
          mounted={hasShown("conversations")}
        />
      </TabsContent>
      <TabsContent {...tabPanel("card")}>
        <CardTab
          detail={detail}
          manages={manages}
          placed={placed}
          onOutcome={outcomeAt("card")}
          toRelease={toRelease}
        />
      </TabsContent>
      <TabsContent {...tabPanel("release")}>
        <ReleaseTab
          detail={detail}
          shown={tab === "release"}
          placed={placed}
          activation={activation}
          onReload={onReload}
          onGoCredentials={() => open("access", credentialsTitle)}
        />
      </TabsContent>
      <TabsContent {...tabPanel("access")}>
        <AccessTab
          detail={detail}
          placed={placed}
          outcomeAt={outcomeAt}
          unbound={activation.unbound}
          credentialsTitle={credentialsTitle}
        />
      </TabsContent>
      <TabsContent {...tabPanel("admins")}>
        <AdminsTab
          agent={agent}
          manages={manages}
          onOutcome={outcomeAt("admins")}
          result={<PlacedOutcome placed={placed} at="admins" />}
        />
      </TabsContent>
      <TabsContent {...tabPanel("slack")}>
        <SlackPanel
          agent={agent}
          activeRelease={detail.active_release}
          mounted={hasShown("slack")}
        />
      </TabsContent>
      <TabsContent {...tabPanel("github")}>
        <GitHubPanel detail={detail} mounted={hasShown("github")} />
      </TabsContent>
    </Tabs>
  );

  // A card's earlier role stands in until the agent has a description.
  const description = agent.description ?? shownVersion(detail)?.card.role;
  return (
    <Page
      // Below 1024 the two buttons leave the name too little room to keep
      // its tag beside it, so they go under the title, the way back at the
      // row's right end.
      stackBelow="lg"
      title={
        <span className="flex min-w-0 items-center gap-3">
          <AgentAvatar name={agent.name} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{agent.name}</span>
        </span>
      }
      titleAside={<AgentStateBadge agent={agent} />}
      description={
        description ? (
          <span className="[overflow-wrap:anywhere]">{description}</span>
        ) : undefined
      }
      actions={
        // The way back ends the row, the command before it.
        <div className="flex flex-1 flex-wrap items-start gap-2">
          <NewSessionButton
            agentId={detail.agent.id}
            releaseId={newSession.releaseId}
            reason={newSession.reason}
          />
          <Link
            to="/agents"
            className={buttonVariants({
              variant: "outline",
              className: "ms-auto",
            })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            {t("agent.back")}
          </Link>
        </div>
      }
    >
      <NewSessionReason
        reason={newSession.reason}
        action={
          newSession.fixedOnReleaseTab ? (
            <TextLink asChild underline="always">
              <Link
                to="/agents/$id"
                params={{ id: agent.id }}
                search={{ tab: "release" }}
                replace
                onClick={(event) => {
                  // A modified click opens the address elsewhere.
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  open("release", releaseTab);
                }}
              >
                {t("agent.tabs.toRelease")}
              </Link>
            </TextLink>
          ) : undefined
        }
      />
      <OutcomeLine outcome={placed?.at === "page" ? placed.outcome : null} />
      <OwnerlessAlert agent={agent} onAdmins={() => open("admins")} />
      {manages ? <CodexSandboxAlert detail={detail} /> : null}
      {manages &&
      agent.active_release_id === null &&
      agent.status !== "archived" ? (
        <UnpublishedAlert detail={detail} activation={activation} />
      ) : null}
      {access === "read" ? (
        <Alert>
          <AlertDescription>{t("agent.readOnly")}</AlertDescription>
        </Alert>
      ) : null}
      <ManagesAgentProvider value={manages}>{body}</ManagesAgentProvider>
    </Page>
  );
}

/**
 * An agent with no active release is seen only by its admins: the way to
 * try the release it saved, and to publish it to its team.
 */
function UnpublishedAlert({
  detail,
  activation,
}: {
  readonly detail: AgentDetail;
  readonly activation: ReturnType<typeof useReleaseActivation>;
}) {
  const { t } = useI18n();
  const release = previewRelease(detail);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = activation.activating !== undefined;
  // The confirmation stays until the server answers.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) setConfirming(false);
    wasBusy.current = busy;
  }, [busy]);
  return (
    <Alert variant="blue" data-status="unpublished">
      <AlertTitle>{t("agent.unpublished.title")}</AlertTitle>
      <AlertDescription>{t("agent.unpublished.body")}</AlertDescription>
      {!release && detail.draft?.failure ? (
        <AlertDescription>
          {t("agent.unpublished.failed", {
            reason: saveFailureText(t, detail.draft.failure),
          })}
        </AlertDescription>
      ) : null}
      {release ? (
        <AlertActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPreviewing(true)}
          >
            {t("agents.flow.preview")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("agents.publish.confirm")}
          </Button>
        </AlertActions>
      ) : null}
      <PreviewDialog
        release={previewing ? (release ?? null) : null}
        agentName={detail.agent.name}
        onClose={() => setPreviewing(false)}
      />
      <PublishDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
        team={detail.agent.managing_team_name}
        busy={busy}
        onConfirm={() => {
          if (release) activation.activate(release);
        }}
      />
    </Alert>
  );
}
