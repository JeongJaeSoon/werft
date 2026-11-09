import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionList } from "@werft-ai/react/blocks";

import { apiError, type FakeRoutes } from "../../.storybook/fake-client.ts";
import { MOBILE } from "../screens/screen-kit.tsx";
import {
  type Globals,
  hostFor,
  page,
  pending,
  SESSIONS,
  shared,
} from "./block-fixtures.tsx";

const meta = {
  title: "Blocks/SessionList",
  render: (_args: unknown, context: Globals) => (
    <SessionList {...shared(hostFor(context))} />
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    api: {
      "GET /v1/sessions": () => page(SESSIONS, "next"),
    } satisfies FakeRoutes,
  },
};

export const Loading: Story = {
  parameters: { api: { "GET /v1/sessions": pending } },
};

export const Empty: Story = {
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
};

export const Failed: Story = {
  name: "Error",
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "backend unavailable"),
    },
  },
};

// The stories above follow the toolbar's Language (한국어 by default); these
// pin English and Japanese so every catalog is in the sidebar and in the a11y
// run.
export const DefaultEnglish: Story = {
  ...Default,
  name: "Default (English)",
  globals: { locale: "en" },
};

export const DefaultJapanese: Story = {
  ...Default,
  name: "Default (日本語)",
  globals: { locale: "ja" },
};

// The row at 390px and in the dark theme.
export const DefaultMobile: Story = { ...Default, globals: MOBILE };

export const DefaultDark: Story = { ...Default, globals: { theme: "dark" } };
