import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionSummary } from "@werft-ai/contracts";
import {
  SessionOverviewRow,
  SessionOverviewTable,
} from "@werft-ai/react/components";
import {
  formatElapsed,
  formatExactTime,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";

import { MOBILE } from "../../screens/screen-kit.tsx";
import { SESSION } from "./session-fixtures.ts";

const HEAD = {
  session: "Session",
  status: "Status",
  model: "Model",
  agent: "Agent · Model",
  repository: "Repository",
  startedBy: "Started by",
  recent: "Recent",
};

/** v4 `.t-sess-home`: the same table without the started-by column. */
const HOME_HEAD = {
  session: "Session",
  status: "Status",
  model: "Model",
  agent: "Agent · Model",
  repository: "Repository",
  recent: "Recent",
};

const MESSAGES = {
  status: (status: string) =>
    ({
      queued: "Queued",
      running: "Working",
      needs_input: "Waiting for an answer",
      idle: "Idle",
      failed: "Failed",
      stopped: "Stopped",
    })[status] ?? status,
  statusAxis: "Status",
  noRepository: "No repository",
  moreRepositories: (count: number) => `${count} more repositories`,
  unknown: "—",
  recent: "Recent",
  open: (name: string) => `Open session: ${name}`,
};

const AGENT = {
  id: "0192f0c4-7d3a-7b4e-9f00-0000000000a1",
  name: "Release helper",
  release_version_no: 3,
  release_label: "2026-10-30_14:30:28",
  release_is_active: true,
};
const STARTER = {
  user_id: "0192f0c4-7d3a-7b4e-9f00-0000000000b1",
  display_name: "Alex Rivera",
};

const meta = {
  title: "Domain/Session/SessionOverviewRow",
  globals: { locale: "en" },
  component: SessionOverviewRow,
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      <SessionOverviewRow {...args} />
    </SessionOverviewTable>
  ),
  args: {
    session: {
      ...SESSION,
      title: "Write hello.txt and commit",
      agent: AGENT,
      created_by: STARTER,
    },
    renderLink: (link) => <a href={`/sessions/${SESSION.id}`} {...link} />,
    messages: MESSAGES,
    locale: "en",
  },
} satisfies Meta<typeof SessionOverviewRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * Created before titles existed: the id's head, no repository, and neither
 * an agent nor a recorded starter.
 */
export const Untitled: Story = {
  args: {
    session: { ...SESSION, title: null, repository_id: null, repository: null },
  },
};

/** The home page's five columns, for a table that names no starter. */
export const HomeColumns: Story = {
  render: (args) => (
    <SessionOverviewTable label="Recent sessions" messages={HOME_HEAD}>
      <SessionOverviewRow {...args} />
    </SessionOverviewTable>
  ),
};

/** The wait comes from the oldest pending request's created_at. */
export const Waiting: Story = {
  args: {
    session: { ...SESSION, title: "Tidy the README", status: "needs_input" },
    statusDetail: "12 min",
  },
};

// A fixed moment, so the recent column reads minutes, yesterday and a date.
const NOW = Date.parse("2026-10-24T06:14:45.000Z");

const WAITING_SINCE = "2026-10-24T04:02:11.000Z";

/**
 * The home page's wait: a node in the status slot, raised above the row's
 * opener, so its exact time opens on its own hover and keyboard focus.
 */
export const WaitingWithTooltip: Story = {
  args: {
    session: { ...SESSION, title: "Tidy the README", status: "needs_input" },
    now: NOW,
    statusDetail: (
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <time
            dateTime={WAITING_SINCE}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the exact time only through focus
            tabIndex={0}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
          >
            {formatElapsed(WAITING_SINCE, "en", NOW)}
          </time>
        </TooltipTrigger>
        <TooltipContent>{formatExactTime(WAITING_SINCE, "en")}</TooltipContent>
      </Tooltip>
    ),
  },
};

const MIXED = [
  {
    session: {
      ...SESSION,
      id: "c7331e51-0b6c-4a51-9d6e-1f3b2a0c9d01",
      title: "Write hello.txt and commit",
      status: "needs_input",
      agent: AGENT,
      created_by: STARTER,
      last_event_at: "2026-10-24T06:02:11.000Z",
    },
    statusDetail: "12 min",
  },
  {
    // An agent key's session: an agent, nobody recorded as its starter.
    session: {
      ...SESSION,
      id: "6e4d1a1f-2b3c-4d5e-8f6a-7b8c9d0e1f04",
      title: "Write api6.txt and push",
      status: "stopped",
      agent: AGENT,
      last_event_at: "2026-10-20T00:40:17.000Z",
    },
  },
  {
    session: {
      ...SESSION,
      id: "e6bfb003-1a2b-4c3d-9e4f-5a6b7c8d9e03",
      title: "Compare competitor docs",
      status: "idle",
      created_by: { ...STARTER, display_name: "佐藤 花子" },
      repository_id: null,
      repository: null,
      last_event_at: "2026-10-23T06:14:02.000Z",
    },
  },
  {
    // Failed before a runtime was chosen: no title, model or repository.
    session: {
      ...SESSION,
      id: "745ce025-4490-4e23-9c22-73671aa69ede",
      status: "failed",
      runtime: null,
      model: null,
      repository_id: null,
      repository: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: "2026-10-18T02:03:55.000Z",
    },
  },
] satisfies readonly {
  readonly session: SessionSummary;
  readonly statusDetail?: string;
}[];

/**
 * The list page's mix: a wait, an agent key's session, a starter without a
 * repository, a session that failed before it had a model.
 */
export const Mixed: Story = {
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      {MIXED.map((row) => (
        <SessionOverviewRow
          {...args}
          {...row}
          key={row.session.id}
          now={NOW}
          renderLink={(link) => (
            <a href={`/sessions/${row.session.id}`} {...link} />
          )}
        />
      ))}
    </SessionOverviewTable>
  ),
};

export const MixedDark: Story = {
  ...Mixed,
  name: "Mixed (dark)",
  globals: { locale: "en", theme: "dark" },
};

export const MixedMobile: Story = {
  ...Mixed,
  name: "Mixed (390px)",
  globals: { locale: "en", ...MOBILE },
};

const OWN = { id: "web", full_name: "acme/web", branch: "main" };

const REPOSITORY_ROWS = [
  {
    // Its own plus two attached: the first in id order, then "+2".
    ...SESSION,
    id: "a1000000-0b6c-4a51-9d6e-1f3b2a0c9d01",
    title: "Own and two attached",
    repository_id: OWN.id,
    repository: OWN,
    attached_repository_ids: ["api", "docs"],
    attached_repositories: [
      { id: "api", full_name: "acme/api" },
      { id: "docs", full_name: "acme/docs-with-a-very-long-repository-name" },
    ],
  },
  {
    // No repository of its own: attached ones alone make the list.
    ...SESSION,
    id: "a2000000-0b6c-4a51-9d6e-1f3b2a0c9d02",
    title: "Attached only",
    repository_id: null,
    repository: null,
    attached_repository_ids: ["api", "web"],
    attached_repositories: [
      { id: "api", full_name: "acme/api" },
      { id: "web", full_name: null },
    ],
  },
  {
    ...SESSION,
    id: "a3000000-0b6c-4a51-9d6e-1f3b2a0c9d03",
    title: "One repository",
    repository_id: OWN.id,
    repository: OWN,
    attached_repository_ids: [],
    attached_repositories: [],
  },
  {
    ...SESSION,
    id: "a4000000-0b6c-4a51-9d6e-1f3b2a0c9d04",
    title: "No repository",
    repository_id: null,
    repository: null,
    attached_repository_ids: [],
    attached_repositories: [],
  },
] satisfies readonly SessionSummary[];

/** 0, 1 and 3 repositories, and a session whose repositories are all attached. */
export const Repositories: Story = {
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      {REPOSITORY_ROWS.map((session) => (
        <SessionOverviewRow
          {...args}
          key={session.id}
          session={session}
          now={NOW}
          renderLink={(link) => (
            <a href={`/sessions/${session.id}`} {...link} />
          )}
        />
      ))}
    </SessionOverviewTable>
  ),
};

export const RepositoriesMobile: Story = {
  ...Repositories,
  name: "Repositories (390px)",
  globals: { locale: "en", ...MOBILE },
};

/** Every status, so dark and 390px cover the dot and the turning ring. */
export const States: Story = {
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      {(
        [
          "needs_input",
          "running",
          "idle",
          "stopped",
          "failed",
          "queued",
        ] as const
      ).map((status, index) => (
        <SessionOverviewRow
          {...args}
          key={status}
          session={{
            ...SESSION,
            id: `${SESSION.id.slice(0, -1)}${index}`,
            title: `Session ${index + 1}`,
            status,
          }}
        />
      ))}
    </SessionOverviewTable>
  ),
};
