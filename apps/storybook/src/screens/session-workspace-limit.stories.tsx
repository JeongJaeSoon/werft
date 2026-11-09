import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkspaceLimitMode } from "@werft-ai/contracts";
import { I18nProvider } from "../../../web/src/i18n/i18n.tsx";
import { SessionWorkspaceLimit } from "../../../web/src/routes/session-workspace-limit.tsx";

import { MOBILE } from "./screen-kit.tsx";

const meta = {
  title: "Screens/Session workspace limits",
  component: SessionWorkspaceLimit,
  parameters: { layout: "padded" },
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
} satisfies Meta<typeof SessionWorkspaceLimit>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unverified: Story = { args: { mode: undefined } };
export const StorageDeclaration: Story = {
  args: {
    mode: {
      bytes: "hard",
      inodes: "unknown",
      reason: "storage_declaration_and_capacity",
    } satisfies WorkspaceLimitMode,
  },
};
export const LocalQuota: Story = {
  args: {
    mode: {
      bytes: "hard",
      inodes: "hard",
      reason: "local_quota_preflight",
    } satisfies WorkspaceLimitMode,
  },
};
export const Soft: Story = {
  args: {
    mode: {
      bytes: "soft",
      inodes: "soft",
      reason: "shared_or_unaccounted_filesystem",
    } satisfies WorkspaceLimitMode,
  },
};
export const SoftMobile: Story = { ...Soft, globals: MOBILE };
export const SoftDark: Story = { ...Soft, globals: { theme: "dark" } };
export const UnverifiedMobile: Story = { ...Unverified, globals: MOBILE };
