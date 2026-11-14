import { createFakeSlackWebApi } from "./fake-slack-api.ts";
import { startMockSlackOidc } from "./mock-slack-oidc.ts";

// The local stack's Sign in with Slack, for infra/compose.mock-slack.yml:
// linking a Slack account end to end without a Slack app. The client id and
// secret are fixed test values, not credentials. The same port answers
// Slack's Web API (`/api/<method>`) for MOCK_SLACK_API_URL, and
// `POST /fake/config-tokens` hands out a config token it will take.
const port = Number(process.env.MOCK_SLACK_PORT ?? "4020");
const idp = await startMockSlackOidc({
  hostname: "0.0.0.0",
  port,
  publicUrl: process.env.MOCK_SLACK_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  clientId: process.env.MOCK_SLACK_CLIENT_ID ?? "mock-client-id",
  clientSecret: process.env.MOCK_SLACK_CLIENT_SECRET ?? "mock-client-secret",
  account: {
    teamId: process.env.MOCK_SLACK_TEAM_ID ?? "T0MOCK",
    userId: process.env.MOCK_SLACK_USER_ID ?? "U0MOCK",
    teamName: process.env.MOCK_SLACK_TEAM_NAME || undefined,
    userName: process.env.MOCK_SLACK_USER_NAME || undefined,
  },
  webApi: createFakeSlackWebApi({
    teamId: process.env.MOCK_SLACK_TEAM_ID ?? "T0MOCK",
    userId: process.env.MOCK_SLACK_USER_ID ?? "U0MOCK",
  }),
  bot: {
    token: process.env.MOCK_SLACK_BOT_TOKEN ?? "mock-bot-token",
    appId: process.env.MOCK_SLACK_APP_ID ?? "A0MOCK",
  },
});
console.log(`mock Slack OIDC listening on ${port}, issuer ${idp.url}`);
