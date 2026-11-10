import {
  isApiError,
  type Page,
  type SessionSummary,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID;
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}
const COUNT = 3;
// A word no other session's title has, so the search sees only this run.
const marker = `inventory-${Date.now().toString(36)}`;

function describe(page: Page<SessionSummary>): string {
  return `${page.items.length} item(s), ${page.next_cursor === null ? "last page" : "more after it"}`;
}

async function run(): Promise<void> {
  const created = await Promise.all(
    Array.from({ length: COUNT }, (_, i) =>
      client.sessions.create(
        {
          agent_release_id,
          title: `${marker} #${i + 1}`,
          message: `GATE-SPEC {"id":"${marker}-${i + 1}","steps":[],"final":"inventory item ${i + 1}"}`,
        },
        { signal },
      ),
    ),
  );
  const ids = created.map((session) => session.session_id);
  for (const session of created)
    console.log(`session ${session.session_id}: created`);
  const turns = await Promise.all(
    created.map((session) =>
      waitForTurn(client, session.session_id, session.turn_id, { signal }),
    ),
  );
  if (turns.some((turn) => turn.status !== "completed"))
    throw new Error("a first turn did not complete");
  console.log(`${COUNT} first turns: completed`);

  // `await` gives one page; nextPage() follows the cursor until null.
  const first = await client.sessions.list({ q: marker, limit: 2 }, { signal });
  console.log(`page 1 of q=${marker} limit=2: ${describe(first)}`);
  const second = await first.nextPage();
  if (!second) throw new Error("expected a second page");
  console.log(`page 2: ${describe(second)}`);
  if (await second.nextPage()) throw new Error("expected no third page");
  console.log("page 3: null");

  // `for await` walks every page.
  const seen: string[] = [];
  for await (const session of client.sessions.list(
    { q: marker, relation: "started", limit: 1 },
    { signal },
  ))
    seen.push(session.id);
  console.log(`for await, relation=started limit=1: ${seen.length} sessions`);
  if (seen.length !== COUNT || !ids.every((id) => seen.includes(id)))
    throw new Error("the listing did not return this run's sessions");

  const idle = await client.sessions.list(
    { q: marker, status: "idle" },
    { signal },
  );
  console.log(`status=idle: ${idle.items.length} sessions`);

  const id = ids[0] as string;
  const detail = await client.sessions.get(id, { signal });
  console.log(
    `session ${id}: "${detail.title}", status ${detail.status}, admission ${detail.admission_state}, revision ${detail.revision}, model ${detail.runtime?.model ?? "-"}, repository ${detail.repository?.full_name ?? "-"}`,
  );

  const usage = await client.sessions.usage(id, { signal });
  console.log(
    `usage: ${usage.cost.kind} $${usage.cost.amount_usd} (complete ${usage.cost.complete}), ${usage.token_count} tokens, ${usage.queued_input_count}/${usage.queued_input_limit} queued`,
  );

  const share = await client.sessions.share(id, { signal });
  console.log(`share: ${share.scope}, revision ${share.revision}`);

  // Idle sessions keep a worker; closing them frees it.
  await Promise.all(
    ids.map(async (sessionId) => {
      const { revision } = await client.sessions.get(sessionId, { signal });
      const accepted = await client.sessions.close(
        sessionId,
        { expected_revision: revision, reason: "inventory sample finished" },
        { signal },
      );
      const receipt = await waitForReceipt(client, accepted.receipt_id, {
        signal,
      });
      if (receipt.status !== "succeeded")
        throw new Error(`close of ${sessionId} did not succeed`);
    }),
  );
  console.log(`${COUNT} sessions: closed`);
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
