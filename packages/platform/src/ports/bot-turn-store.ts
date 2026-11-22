/** One chat thread, as every agent of the workspace sees it. */
export type ChatThreadKey = {
  workspaceId: string;
  /** The chat workspace the thread lives in. */
  teamId: string;
  channelId: string;
  /** The thread's root message id. */
  threadTs: string;
};

/** One agent's turn on one bot message. */
export type BotTurn = { messageTs: string; agentId: string };

/**
 * `counted`: the turn may run. `limit`: the thread ran `limit` bot-started
 * turns since a person last wrote there; `first` is true for the one turn
 * that says so, and `stop` names it.
 */
export type BotTurnClaim =
  | { outcome: "counted" }
  | { outcome: "limit"; first: boolean; stop: string };

/**
 * Bot-started turns in a row per chat thread, whichever agent ran them.
 * Only a person's message starts the count over; time does not.
 */
export interface BotTurnStore {
  claim(
    key: ChatThreadKey,
    turn: BotTurn,
    limit: number,
  ): Promise<BotTurnClaim>;
  /** A turn claimed but refused before it ran. */
  release(key: ChatThreadKey, turn: BotTurn): Promise<void>;
  /** A person wrote in the thread at `messageTs`. */
  reset(key: ChatThreadKey, messageTs: string): Promise<void>;
}

/** What a store keeps per thread; the rules below change it. */
export type BotTurnState = {
  /** Turns counted since the person's message at `humanTs`. */
  counted: readonly string[];
  humanTs: string | null;
  /** The turn the limit first stopped; it says the stop line. */
  stop: string | null;
};

/** Slack-style ids: seconds, a dot, then a fraction; they sort by time. */
function after(a: string, b: string): boolean {
  const [as = "", af = ""] = a.split(".");
  const [bs = "", bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  return (
    BigInt(as + af.padEnd(width, "0")) > BigInt(bs + bf.padEnd(width, "0"))
  );
}

const turnId = (turn: BotTurn) => `${turn.messageTs} ${turn.agentId}`;
const tsOf = (id: string) => id.split(" ")[0] ?? "";

/**
 * Counts `turn` unless it is counted already (one message delivered twice
 * to one agent) or older than the person's last message.
 */
export function claimBotTurn(
  state: BotTurnState,
  turn: BotTurn,
  limit: number,
): { next: BotTurnState; claim: BotTurnClaim } {
  const id = turnId(turn);
  if (
    (state.humanTs !== null && !after(turn.messageTs, state.humanTs)) ||
    state.counted.includes(id)
  ) {
    return { next: state, claim: { outcome: "counted" } };
  }
  if (state.counted.length < limit) {
    return {
      next: { ...state, counted: [...state.counted, id] },
      claim: { outcome: "counted" },
    };
  }
  const stop = state.stop ?? id;
  // The same turn tried again is still the first: its line may not have
  // been queued yet, and the queue takes it once.
  return {
    next: { ...state, stop },
    claim: { outcome: "limit", first: stop === id, stop },
  };
}

export function releaseBotTurn(
  state: BotTurnState,
  turn: BotTurn,
): BotTurnState {
  const id = turnId(turn);
  if (!state.counted.includes(id)) return state;
  return {
    ...state,
    counted: state.counted.filter((counted) => counted !== id),
  };
}

/**
 * A person's message keeps only the turns on later messages. One seen
 * before, or delivered late behind a newer one, changes nothing.
 */
export function resetBotTurns(
  state: BotTurnState,
  messageTs: string,
): BotTurnState {
  if (state.humanTs !== null && !after(messageTs, state.humanTs)) return state;
  // A stop on a later message was met before this person's message was
  // read; that message opens the new run, so the next stop speaks again.
  return {
    counted: state.counted.filter((id) => after(tsOf(id), messageTs)),
    humanTs: messageTs,
    stop: null,
  };
}
