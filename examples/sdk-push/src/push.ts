import {
  isApiError,
  type PendingRequestHandlers,
  type PushRequest,
  Werft,
  waitForPushRequest,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

// The agent key works the session and asks for the push; another key with
// sessions:approve decides it, since no workspace key approves a session it
// started.
const client = new Werft();
const approver = process.env.WERFT_APPROVER_API_KEY
  ? client.withOptions({ apiKey: process.env.WERFT_APPROVER_API_KEY })
  : client;
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID;
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}
const target = { agent_release_id };

const FILE = "sdk-sample.txt";
const COMMANDS = [
  `echo "written by the SDK push sample" > ${FILE}`,
  `git add ${FILE} && git commit -m "Add ${FILE}"`,
];
const approvals: PendingRequestHandlers = {
  permission(request) {
    const command = (request.input as { command?: unknown } | null)?.command;
    if (request.tool === "Bash" && COMMANDS.includes(command as string)) {
      console.log(`permission ${request.request_id}: allow "${command}"`);
      return { action: "allow" };
    }
    return {
      action: "deny",
      reason: "This script only writes and commits one file",
    };
  },
};

const show = (push: PushRequest) =>
  `push ${push.id}: ${push.state}, ${push.git_commit.slice(0, 12)} -> ${push.target_branch} (checkpoint ${push.checkpoint_revision})`;

async function run(): Promise<void> {
  const created = await client.sessions.create(
    {
      ...target,
      message: `GATE-SPEC ${JSON.stringify({
        id: "push1",
        steps: COMMANDS.map((command) => ({
          tool: "Bash",
          input: { command, description: "commit the sample file" },
        })),
        final: `committed ${FILE}`,
      })}`,
    },
    { signal },
  );
  const sessionId = created.session_id;
  console.log(`session ${sessionId}: created`);
  const turn = await waitForTurn(approver, sessionId, created.turn_id, {
    signal,
    onRequest: approvals,
  });
  console.log(`turn ${turn.turn_id}: ${turn.status}`);
  if (turn.status !== "completed")
    throw new Error("the commit turn did not complete");

  // The request pins the session's latest checkpoint and its commit.
  const first = await client.sessions.pushRequests.create(sessionId, {
    signal,
  });
  console.log(show(first));
  const rejected = await approver.sessions.pushRequests.reject(
    sessionId,
    first.id,
    {
      git_commit: first.git_commit,
      reason: "review the diff first",
    },
    { signal },
  );
  console.log(`${show(rejected)}, reason "${rejected.resolution_reason}"`);
  const late = await approver.sessions.pushRequests
    .approve(sessionId, first.id, { git_commit: first.git_commit }, { signal })
    .catch((error: unknown) => error);
  if (!isApiError(late, "PUSH_REQUEST_RESOLVED")) throw late;
  console.log(`approve after the reject: ${late.status} ${late.code}`);

  // A new request for the same commit; approve only the commit reviewed.
  const second = await client.sessions.pushRequests.create(sessionId, {
    signal,
  });
  const approved = await approver.sessions.pushRequests.approve(
    sessionId,
    second.id,
    { git_commit: second.git_commit },
    { signal },
  );
  console.log(show(approved));
  // The platform, not the worker, pushes within seconds of the approval.
  const done = await waitForPushRequest(client, sessionId, second.id, {
    signal,
  });
  console.log(show(done));
  if (!done.push_receipt_id)
    throw new Error(`push ${done.state} without a receipt`);
  const receipt = await waitForReceipt(client, done.push_receipt_id, {
    signal,
  });
  const { remote_ref, refusal } = receipt.result as {
    remote_ref?: string;
    refusal?: string;
  };
  console.log(`push receipt: ${receipt.status}, ${refusal ?? remote_ref}`);
  const pushed = done.state === "pushed";
  // A catalog repository without `auth` (the local fake-git one) cannot be
  // pushed to; anything else that fails is an error here.
  if (!pushed && refusal !== "no_push_credential")
    throw new Error(`push ${done.state}: ${refusal}`);

  const all = await client.sessions.pushRequests.list(sessionId, { signal });
  console.log(`push requests: ${all.map((push) => push.state).join(", ")}`);
  const again = await client.sessions.pushRequests.get(sessionId, second.id, {
    signal,
  });
  console.log(`get ${again.id}: ${again.state}`);

  // A pull request needs a pushed branch on GitHub (an App or a github.com
  // PAT). The calls carry no Idempotency-Key, so the SDK never resends one
  // whose response was lost.
  const refused = (error: unknown, ...codes: string[]) => {
    if (!isApiError(error) || !codes.includes(error.code)) throw error;
    const reason = (error.details as { refusal?: string } | null)?.refusal;
    return `${error.status} ${error.code}${reason ? ` ${reason}` : ""}`;
  };
  const early = await approver.sessions.pushRequests
    .commentPullRequest(sessionId, second.id, { body: "early" }, { signal })
    .then(() => "posted")
    .catch((error: unknown) =>
      refused(error, "PULL_REQUEST_MISSING", "PUSH_NOT_PUSHED", "FORBIDDEN"),
    );
  console.log(`comment before a pull request: ${early}`);
  try {
    const pr = await approver.sessions.pushRequests.openPullRequest(
      sessionId,
      second.id,
      { title: `Add ${FILE}`, body: "Opened by the SDK push sample." },
      { signal },
    );
    console.log("pull request:", pr);
    const comment = await approver.sessions.pushRequests.commentPullRequest(
      sessionId,
      second.id,
      { body: "The sample pushed this branch.", marker: "sdk-sample" },
      { signal },
    );
    console.log("comment:", comment);
  } catch (error) {
    // FORBIDDEN no_forge: a pushed branch on a repository without GitHub.
    console.log(
      `pull request: ${refused(error, pushed ? "FORBIDDEN" : "PUSH_NOT_PUSHED")}`,
    );
  }

  const { revision } = await client.sessions.get(sessionId, { signal });
  const close = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "push sample finished" },
    { signal },
  );
  const closed = await waitForReceipt(client, close.receipt_id, { signal });
  console.log(`close: receipt ${closed.status}`);
  if (closed.status !== "succeeded") throw new Error("close did not succeed");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
