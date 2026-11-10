import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ListPushRequestsResponse,
  ListSessionAchievementsResponse,
  ListSessionOutcomesResponse,
  ListSessionOutputsResponse,
  SessionDetail,
} from "@werft-ai/contracts";
import { I18nProvider } from "../../../web/src/i18n/i18n.tsx";
import { SessionOutputsTab } from "../../../web/src/routes/session-outputs.tsx";
import { me } from "../../../web/src/test-support/fake-api.ts";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { pending } from "../blocks/block-fixtures.tsx";
import { MOBILE } from "./screen-kit.tsx";

/*
 * The session detail's 성과물 tab as apps/web mounts it: achievements with
 * the judgment under the section head, the evidence, the out/ files, the
 * GitHub work grouped by branch, then one meta line. Beside the filled
 * tab: nothing left yet, the reads still on their way, and a failed read.
 */

const ID = "4acf4597-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const AT = "2026-11-09T01:02:00.000Z";
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const BRANCH = `agent/${ID}`;
const base = `GET /v1/sessions/${ID}`;

const SESSION = {
  id: ID,
  revision: 3,
  admission_state: "active",
  status: "idle",
  runtime: null,
  repository: { id: "sandbox", full_name: "acme/sandbox", branch: "main" },
  repository_id: "sandbox",
  current_turn_id: "1",
  queued_turn_count: 0,
  model: null,
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
  execution: null,
  checkpoint_revision: 2,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: 2,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as unknown as SessionDetail;

const pushRequest = (n: number) => ({
  id: `019a0000-0000-7000-8000-00000000009${n}`,
  session_id: ID,
  repository_id: "sandbox",
  checkpoint_revision: 2,
  git_commit: "a".repeat(40),
  target_branch: BRANCH,
  state: "pushed",
  requested_by: {
    principal: { kind: "api_key", id: "key-1" },
    actor_user_id: null,
    agent_id: null,
  },
  requested_at: `2026-11-09T01:0${n}:00.000Z`,
  resolved_by: null,
  resolved_at: null,
  resolution_reason: null,
  request_receipt_id: "019a0000-0000-7000-8000-0000000000b1",
  resolution_receipt_id: null,
  finished_at: AT,
  push_receipt_id: null,
  origin: "intent",
  flow: "actions",
  pr_state: n === 3 ? "opened" : null,
  pr_error: null,
  pr_number: n === 3 ? 135 : null,
  pr_url: n === 3 ? "https://github.com/acme/sandbox/pull/135" : null,
});

const FILLED: FakeRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/administered-agents": () => json(200, { items: [] }),
  [`${base}/outputs`]: () =>
    json(200, {
      session_id: ID,
      checkpoint_revision: 2,
      items: [
        { path: "out/report.md", bytes: 2048, sha256: SHA, omitted: null },
        {
          path: "out/video.mp4",
          bytes: 734_003_200,
          sha256: null,
          omitted: "too_large",
        },
      ],
    }),
  [`${base}/outcomes`]: () =>
    json(200, {
      items: [
        {
          id: "019a0000-0000-7000-8000-000000000001",
          type: "github_pull_request",
          url: "https://github.com/acme/sandbox/pull/135",
          repository_id: "sandbox",
          external_id: "135",
          state: "open",
          state_changed_at: AT,
          merged_at: null,
          closed_at: null,
          state_checked_at: AT,
          check_error: null,
          metadata: {
            title: "Retry failed payments",
            head: BRANCH,
            base: "main",
            adopted: false,
            merge_commit_sha: null,
            additions: 1,
            deletions: 0,
            changed_files: 1,
            commits: 1,
          },
          created_at: AT,
        },
      ],
    }),
  [`${base}/achievements`]: () =>
    json(200, {
      items: [],
      judgment: {
        id: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
        trigger: "evidence",
        status: "succeeded",
        error_code: null,
        evidence_change: "evidence",
        created_at: AT,
        finished_at: AT,
      },
      judgment_count: 1,
      judge_cost_usd: 0,
    }),
  [`${base}/push-requests`]: () =>
    json(200, {
      items: [1, 2, 3, 4].map(pushRequest),
      intents: [],
    }),
  [`${base}/github/attribution`]: () =>
    json(200, { attribution: "co_author", login: "JeongJaeSoon" }),
  [`${base}/github/refusals`]: () => json(200, { items: [] }),
  [`${base}/usage`]: () =>
    json(200, {
      session_id: ID,
      period: "session_lifetime",
      refreshed_at: AT,
      cost: {
        amount_usd: "0.230000",
        kind: "estimated",
        source: "provider_usage",
        completeness_scope: "turn_reports",
        complete: true,
        reported_turn_count: 1,
        unreported_turn_count: 0,
        open_turn_count: 0,
      },
      cost_limit_usd: "25",
      token_count: 529522,
      token_limit: null,
      budget_exceeded: false,
      queued_input_count: 0,
      queued_input_limit: 10,
    }),
};

const meta = {
  title: "Screens/Session outputs tab",
  component: SessionOutputsTab,
  parameters: { layout: "padded", api: FILLED },
  args: { session: SESSION },
  decorators: [
    (Story, context) => (
      <I18nProvider
        locale={
          context.globals.locale === "en"
            ? "en"
            : context.globals.locale === "ja"
              ? "ja"
              : "ko"
        }
      >
        <Story />
      </I18nProvider>
    ),
  ],
} satisfies Meta<typeof SessionOutputsTab>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Filled: Story = {};
export const FilledMobile: Story = { globals: MOBILE };
export const FilledDark: Story = { globals: { theme: "dark" } };

// A session that has run but left nothing: no file under out/, no pull
// request, no achievement and no judgment yet.
const NO_OUTPUTS: ListSessionOutputsResponse = {
  session_id: ID,
  checkpoint_revision: 2,
  items: [],
};
const NO_OUTCOMES: ListSessionOutcomesResponse = { items: [] };
const NO_ACHIEVEMENTS: ListSessionAchievementsResponse = {
  items: [],
  judgment: null,
  judgment_count: 0,
  judge_cost_usd: 0,
};
const NO_PUSH_REQUESTS: ListPushRequestsResponse = { items: [], intents: [] };

const EMPTY: FakeRoutes = {
  ...FILLED,
  [`${base}/outputs`]: () => json(200, NO_OUTPUTS),
  [`${base}/outcomes`]: () => json(200, NO_OUTCOMES),
  [`${base}/achievements`]: () => json(200, NO_ACHIEVEMENTS),
  [`${base}/push-requests`]: () => json(200, NO_PUSH_REQUESTS),
};

// The files and pull requests are still being read.
const LOADING: FakeRoutes = {
  ...FILLED,
  [`${base}/outputs`]: pending,
  [`${base}/outcomes`]: pending,
  [`${base}/achievements`]: pending,
  [`${base}/push-requests`]: pending,
};

// Reading the files fails; the pull requests read empty, so the failure is
// the only thing the tab has to say about files.
const FAILED: FakeRoutes = {
  ...EMPTY,
  [`${base}/outputs`]: () =>
    apiError(500, "INTERNAL_ERROR", "Storybook: the outputs read failed"),
};

export const Empty: Story = { parameters: { api: EMPTY } };
export const EmptyMobile: Story = {
  parameters: { api: EMPTY },
  globals: MOBILE,
};
export const EmptyDark: Story = {
  parameters: { api: EMPTY },
  globals: { theme: "dark" },
};
export const Loading: Story = { parameters: { api: LOADING } };
export const LoadFailed: Story = { parameters: { api: FAILED } };
export const LoadFailedDark: Story = {
  parameters: { api: FAILED },
  globals: { theme: "dark" },
};
