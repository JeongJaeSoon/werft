import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ApprovalCard,
  type PermissionRequest,
} from "@werft-ai/react/components";

// A fixed clock, as in the other stories.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");

const REQUEST: PermissionRequest = {
  request_id: "req_01",
  turn_id: "1",
  attempt_id: "att_01",
  kind: "permission",
  tool: "Bash",
  input: {
    command: "echo alpha > hello.txt",
    description: "write hello.txt",
  },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
};

const meta = {
  title: "Domain/Session/ApprovalCard",
  // The example copy is English; the page language should say so.
  globals: { locale: "en" },
  component: ApprovalCard,
  args: {
    request: REQUEST,
    messages: {
      title: (tool: string) => `${tool} wants to run`,
      input: "Show input",
      expires: (at: string) => `Answer by ${at}`,
      expired: "This request expired.",
      allow: "Allow",
      deny: "Deny",
      denyReason: "Why deny?",
      denySubmit: "Deny",
      cancel: "Cancel",
    },
    onAllow: () => {},
    onDeny: () => {},
    now: NOW,
    locale: "en",
  },
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Nothing to answer once it expired. */
export const Empty: Story = {
  args: { now: Date.parse(REQUEST.expires_at) },
};

/** The answer is on its way. */
export const Loading: Story = { args: { pending: true } };

export const Failed: Story = {
  name: "Error",
  args: { error: "The answer was refused: the request already expired." },
};

/** In a list of many sessions' requests, the title line names the session. */
export const WithSubject: Story = {
  args: {
    subject: (
      <a href="#session" className="font-mono text-link underline">
        <code>819f21a8…</code>
      </a>
    ),
  },
};

/** The input is open: it takes the card's full width above the buttons. */
export const InputOpen: Story = {
  name: "Input open",
  args: {
    request: {
      ...REQUEST,
      input: {
        command:
          "git remote -v | sed 's/\\(https\\?:\\/\\/\\)[^ ]*/<url>/' ; git branch -a",
        description: "List remotes and branches",
      },
    },
  },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector("summary")?.click();
  },
};

export const InputOpenMobile: Story = {
  ...InputOpen,
  name: "Input open (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const InputOpenDark: Story = {
  ...InputOpen,
  name: "Input open (dark)",
  globals: { theme: "dark" },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {Object.entries({ Default, Empty, Loading, Failed, WithSubject }).map(
        ([name, story]) => (
          <ApprovalCard key={name} {...args} {...story.args} />
        ),
      )}
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  ...States,
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
