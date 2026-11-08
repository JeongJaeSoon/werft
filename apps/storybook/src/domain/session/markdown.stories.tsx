import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "@werft-ai/react/components";

const REPLY = [
  "Two repositories are connected now.",
  "",
  "**werft-sandbox:** the sample pull request is open at https://example.com/pull/7.",
  "",
  "- Branch `feature/sample` was pushed",
  "- Checks: 3 of 3 passed ([run log](https://example.com/runs/1))",
  "",
  "| Repository | Result |",
  "| --- | --- |",
  "| werft-sandbox | opened |",
  "| agent-guard | linked |",
  "",
  "```sh",
  "git push origin feature/sample",
  "```",
].join("\n");

const LONG_REPLY = Array.from(
  { length: 30 },
  (_, index) =>
    `Step ${index + 1}: ${"the worker checked this part of the change and found nothing to fix. ".repeat(2)}`,
).join("\n\n");

const meta = {
  title: "Domain/Session/Markdown",
  globals: { locale: "en" },
  component: Markdown,
  args: {
    text: REPLY,
    tableLabel: "Table",
    newTabLabel: "(opens in a new tab)",
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-card border bg-card p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Bold, list, link, inline and block code, and a table, as elements. */
export const Default: Story = {};

/** Over 3000 characters of source folds between blocks behind a button. */
export const Folded: Story = {
  args: { text: LONG_REPLY, fold: { more: "Show more", less: "Show less" } },
};

/** Without `fold` a reply is always whole, however long. */
export const WithoutFold: Story = { args: { text: LONG_REPLY } };

/** Markup and unsafe links stay on screen as text; nothing becomes an element. */
export const Hostile: Story = {
  args: {
    text: [
      "<script>window.__pwned = 1</script>",
      '<img src="x" onerror="window.__pwned = 2">',
      "[click](javascript:window.__pwned=3)",
      "![pixel](https://tracker.example/p.png)",
    ].join("\n\n"),
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile390: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
