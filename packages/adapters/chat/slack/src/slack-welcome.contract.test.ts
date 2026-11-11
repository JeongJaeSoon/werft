import { type AgentDetail, DEFAULT_SURFACE_CEILING } from "@werft-ai/contracts";
import type {
  SlackAppRecord,
  SlackOutboxEntry,
  SurfaceBindingRecord,
} from "@werft-ai/platform";
import {
  describeAgentWelcomableContract,
  type WelcomeScenario,
  type WelcomeSubject,
} from "@werft-ai/platform/testing/agent-welcomable";
import { createSlackWelcome } from "./slack-welcome.ts";

// `AgentWelcomable` against `createSlackWelcome` over in-memory stores. The
// outbox keeps one row per dedupe key, as `SlackOutboxStore.enqueue` says.
const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const RELEASE = "rel_2";

const home = (
  extra: Partial<SurfaceBindingRecord> = {},
): SurfaceBindingRecord => ({
  id: "binding-home",
  workspaceId: WORKSPACE,
  agentId: AGENT,
  installationId: "installation-1",
  channelId: "C0HOME",
  channelKind: "public_channel",
  mode: "on",
  ceiling: DEFAULT_SURFACE_CEILING as SurfaceBindingRecord["ceiling"],
  home: true,
  memoryWritePolicy: "deny",
  status: "ready",
  approvedAt: null,
  membership: { state: "joined", error: null },
  muted: false,
  revision: 1,
  createdAt: new Date(0),
  revokedAt: null,
  ...extra,
});

async function subject(): Promise<WelcomeSubject> {
  let rows: SurfaceBindingRecord[] = [home()];
  let release: string | null = RELEASE;
  let superseded = false;
  let installed = true;
  let failing = false;
  const outbox = new Map<string, SlackOutboxEntry>();
  const welcome = createSlackWelcome({
    agents: {
      get: async () => {
        if (failing) throw new Error("the database is down");
        return {
          agent: { name: "Analyst", active_release_id: release },
        } as AgentDetail;
      },
      releaseSuperseded: async () => superseded,
    },
    bindings: { list: async () => rows },
    apps: {
      findForAgent: async () =>
        installed ? ({ id: "slack-app-1" } as SlackAppRecord) : null,
    },
    outbox: {
      async enqueue(entry) {
        if (outbox.has(entry.dedupeKey)) return "duplicate";
        outbox.set(entry.dedupeKey, entry);
        return "enqueued";
      },
    },
    // Asking joins the channel: the stored membership changes, as it does
    // when the real joiner records what Slack said.
    join: async (binding) => {
      rows = rows.map((row) =>
        row.id === binding.id
          ? { ...row, membership: { state: "joined", error: null } }
          : row,
      );
      return { state: "joined", error: null };
    },
    logger: { info: () => {}, warn: () => {} } as never,
  });
  const arrange = (scenario: WelcomeScenario) => {
    rows =
      scenario === "no_home"
        ? []
        : [
            home({
              membership:
                scenario === "home_awaiting_invite"
                  ? { state: "awaiting_invite", error: null }
                  : scenario === "home_unasked"
                    ? null
                    : { state: "joined", error: null },
            }),
          ];
    release = scenario === "no_release" ? null : RELEASE;
    installed = scenario !== "not_installed";
    superseded = scenario === "rolled_back";
    failing = scenario === "reads_failing";
  };
  return {
    welcome,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    releaseId: RELEASE,
    arrange,
    welcomesQueued: () => outbox.size,
  };
}

describeAgentWelcomableContract(subject);
