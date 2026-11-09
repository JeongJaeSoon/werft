import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  RepositorySummary,
  type SessionRepositoryEntry,
} from "@werft-ai/react/components";

const MESSAGES = {
  none: "No repository",
  unknown: "—",
  more: (count: number) =>
    count === 1 ? "1 more repository" : `${count} more repositories`,
};

const API: SessionRepositoryEntry = {
  id: "api",
  name: "acme/api",
  branch: null,
};
const WEB: SessionRepositoryEntry = {
  id: "web",
  name: "acme/web",
  branch: "main",
};
const DOCS: SessionRepositoryEntry = {
  id: "docs",
  name: "acme/docs-with-a-very-long-repository-name-that-needs-to-truncate",
  branch: null,
};

const meta = {
  title: "Domain/Session/RepositorySummary",
  globals: { locale: "en" },
  component: RepositorySummary,
  args: { repositories: [WEB], messages: MESSAGES },
  decorators: [
    (Story) => (
      <div className="w-60">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RepositorySummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One repository: its name and, for the session's own, the cloned branch. */
export const One: Story = {};

/** None: a muted word instead of a name. */
export const None: Story = { args: { repositories: [] } };

/** More than one: the first in id order and a "+N" button with the rest. */
export const Several: Story = {
  args: { repositories: [API, DOCS, WEB] },
};

/** One that is not named: the key stands in, or the unknown mark. */
export const Unnamed: Story = {
  args: {
    repositories: [
      { id: "legacy-key", name: null, branch: null },
      { id: null, name: null, branch: null },
    ],
  },
};

/** A long name gives way first; the "+N" button keeps its room. */
export const LongName: Story = {
  args: { repositories: [DOCS, API] },
};
