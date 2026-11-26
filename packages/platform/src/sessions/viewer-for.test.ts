import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import { callerFor } from "../musterrolle/policy.ts";
import { pendingField, viewerFor } from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const CONVERSATION = "019a0000-0000-7000-8000-00000000c0a1";

const caller = callerFor(
  {
    kind: "user",
    id: USER,
    workspace_id: WORKSPACE,
    role: "member",
    scopes: [...scopesForRole("member")],
  },
  { kind: "web" },
  "r",
);

// 94S-2270: a read across sessions takes the channels the policy confirmed
// and says, in its answer, when some channel is still being confirmed.
describe("the viewer a read across sessions takes", () => {
  test("holds the confirmed channels and passes pending on", async () => {
    const seen = await viewerFor(
      {
        privateChannelsOf: async () => ({
          conversationIds: [CONVERSATION],
          pending: true,
        }),
      },
      caller,
    );
    expect(seen).toEqual({
      viewer: {
        userId: USER,
        apiKeyId: null,
        keyAgentId: null,
        privateChannels: [CONVERSATION],
      },
      pending: true,
    });
    expect(pendingField(seen.pending)).toEqual({
      private_channels_pending: true,
    });
  });

  test("a policy with no private channel reader holds none and is not pending", async () => {
    const seen = await viewerFor({}, caller);
    expect(seen.viewer.privateChannels).toEqual([]);
    expect(seen.pending).toBe(false);
    expect(pendingField(false)).toEqual({});
  });
});
