import type { Meta, StoryObj } from "@storybook/react-vite";
import { WaitingSessions } from "@werft-ai/react/blocks";

import { apiError, type FakeRoutes } from "../../.storybook/fake-client.ts";
import { MOBILE } from "../screens/screen-kit.tsx";
import {
  type Globals,
  hostFor,
  page,
  pending,
  shared,
  WAITING,
} from "./block-fixtures.tsx";

const meta = {
  title: "Blocks/WaitingSessions",
  render: (_args: unknown, context: Globals) => {
    const host = hostFor(context);
    return <WaitingSessions label={host.waiting} {...shared(host)} />;
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    api: {
      "GET /v1/sessions": () => page(WAITING),
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
