// Runs inside this verification project's API container. It reads no
// credential: the mock Slack signs the press with its own app secret, and
// this script only picks a card from the mock's records and asks for it.
const [mode, appId, agentId, pick = "1"] = process.argv.slice(1);

const MOCK = "http://mock-slack:4020";
const ACTIONS: Record<string, string> = {
  allow: "permission.allow",
  "allow-session": "permission.allow_session",
  "allow-note": "permission.allow_note",
  deny: "permission.deny",
  "push-approve": "push.approve",
  "push-reject": "push.reject",
  // On the notice of a turn its worker's lost lease ended.
  continue: "turn.continue",
};

type Message = {
  channelId: string;
  threadTs: string | null;
  userId: string | null;
  ts: string;
  text: string;
  options: { blocks?: string };
};
type Element = { action_id?: string; value?: string };
type Update = {
  channelId: string;
  ts: string;
  text: string;
  blocks?: { elements?: Element[] }[];
};

const get = async (path: string) => (await fetch(`${MOCK}${path}`)).json();
const elementsOf = (message: Message): Element[] =>
  (JSON.parse(message.options.blocks ?? "[]") as { elements?: Element[] }[])
    .flatMap((block) => block.elements ?? [])
    .filter((element) => element.action_id !== undefined);

// Ephemeral notices carry a user id; a card is a channel post with buttons.
const { messages } = (await get("/fake/messages")) as { messages: Message[] };
const cards = messages.filter(
  (message) => message.userId === null && elementsOf(message).length > 0,
);

if (mode === "cards") {
  const { updates } = (await get("/fake/updates")) as { updates: Update[] };
  for (const card of cards) {
    const last = updates.findLast((update) => update.ts === card.ts);
    console.log(
      JSON.stringify({
        ts: card.ts,
        thread_ts: card.threadTs,
        actions: elementsOf(card).map((element) => element.action_id),
        updates: updates.filter((update) => update.ts === card.ts).length,
        last_update: last?.text ?? null,
      }),
    );
  }
  console.log(`cards: ${cards.length}`);
} else if (mode === "click") {
  const actionId = ACTIONS[pick];
  if (actionId === undefined) throw new Error(`unknown action ${pick}`);
  // The newest card whose current blocks (the last update's, else the
  // posted ones) still offer the button; an answered card has none.
  const { updates } = (await get("/fake/updates")) as { updates: Update[] };
  const current = (message: Message): Element[] => {
    const last = updates.findLast((update) => update.ts === message.ts);
    return last === undefined
      ? elementsOf(message)
      : (last.blocks ?? []).flatMap((block) => block.elements ?? []);
  };
  const open = (message: Message) =>
    current(message).find((element) => element.action_id === actionId);
  const card = cards.findLast((message) => open(message) !== undefined);
  if (!card) throw new Error(`no open card offers ${actionId}`);
  const element = open(card);
  const response = await fetch(`${MOCK}/fake/interactions`, {
    method: "POST",
    body: JSON.stringify({
      // The mock makes this call, so the name is the API's on the compose network.
      url: `http://api:3000/v1/slack/interactions/${agentId}`,
      app_id: appId,
      payload: {
        type: "block_actions",
        team: { id: "T0MOCK" },
        user: { id: "U0MOCK" },
        channel: { id: card.channelId },
        message: { ts: card.ts, thread_ts: card.threadTs ?? card.ts },
        trigger_id: "verify-trigger",
        actions: [{ action_id: actionId, value: element?.value }],
      },
    }),
  });
  console.log(`card ${card.ts} ${actionId}`);
  console.log(await response.text());
} else if (mode === "submit-note") {
  // Submits the newest note modal the API filled, with `pick` as the text,
  // the way Slack posts a view_submission.
  const { viewUpdates } = (await get("/fake/updates")) as {
    viewUpdates: {
      viewId: string;
      view: { callback_id?: string; private_metadata?: string };
    }[];
  };
  const filled = viewUpdates.findLast(
    (update) => update.view.callback_id === "permission.allow_note",
  );
  if (!filled) throw new Error("no note modal was filled");
  const payload = {
    type: "view_submission",
    team: { id: "T0MOCK" },
    user: { id: "U0MOCK" },
    view: {
      id: filled.viewId,
      callback_id: filled.view.callback_id,
      private_metadata: filled.view.private_metadata,
      state: {
        values: { note: { v: { type: "plain_text_input", value: pick } } },
      },
    },
  };
  console.log(`view ${filled.viewId} submitted: ${JSON.stringify(payload)}`);
  const response = await fetch(`${MOCK}/fake/interactions`, {
    method: "POST",
    body: JSON.stringify({
      url: `http://api:3000/v1/slack/interactions/${agentId}`,
      app_id: appId,
      payload,
    }),
  });
  console.log(await response.text());
} else {
  throw new Error("mode must be cards, click or submit-note");
}
