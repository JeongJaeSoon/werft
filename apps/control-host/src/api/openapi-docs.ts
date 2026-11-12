import {
  type ApiErrorCode,
  CSRF_HEADER_VALUE,
  type SessionScope,
} from "@werft-ai/contracts";

// Prose the OpenAPI generator (openapi.ts) assembles into the document. Every
// statement here describes behavior enforced elsewhere; change it with the code.

/** What the generator knows about an operation when it writes error text. */
export type ErrorContext = {
  scope: SessionScope | undefined;
  // "public": no credential; "session": a cookie session only.
  auth: "public" | "session" | "any";
  // "always": every caller sends the CSRF header (login). "cookie": only a
  // cookie-authenticated caller does (every cookie mutation).
  csrf: "always" | "cookie" | "none";
  idempotencyKey: boolean;
  lastEventId: boolean;
  body: boolean;
  // The body has a `message` field, which carries its own size limit.
  message: boolean;
  query: boolean;
};

export const API_INFO_DESCRIPTION = `Session control plane for Werft agents. This document is generated from the route declarations in apps/control-host/src/api/openapi.ts and the Zod schemas in packages/contracts; do not edit it by hand.

## Authentication

There are two ways to call the API, and they are not interchangeable:

- **Servers and scripts** send an API key as an HTTP bearer token, \`Bearer <key>\` (\`bearerApiKey\`). The key is limited to the scopes it was issued with, and it never needs the CSRF header.
- **The web console** uses the browser session cookie that \`POST /v1/auth/login\` sets (\`cookieSession\`). What it may do follows the user's workspace role, and every request other than GET must send \`X-Requested-With: ${CSRF_HEADER_VALUE}\` and must not be cross-site (\`Sec-Fetch-Site\`, \`Origin\`); otherwise it answers \`403 FORBIDDEN\`.

An API key cannot manage agents, members, teams or API keys, list agents other than an agent key's own, list or stop sessions through the administration operations, read a session outside its share or take a session over: those operations answer it \`403 FORBIDDEN\`, whatever its scopes. A missing, malformed, unknown or revoked credential answers \`401 UNAUTHORIZED\`. \`/healthz\`, \`/readyz\`, \`/v1/openapi.json\`, \`/v1/auth/bootstrap\` and \`/v1/auth/login\` take no credential.

## Scopes

Each operation names the one scope it requires, in its description and in its \`security\` requirement:

- \`sessions:read\`: read sessions, turns, events, pending requests, usage, limits and receipts.
- \`sessions:write\`: create sessions and send messages.
- \`sessions:approve\`: answer pending permission and question requests.
- \`sessions:control\`: interrupt, pause, resume and terminate.
- \`sessions:recover\`: record recovery decisions.

What a credential holds:

- An API key holds exactly the scopes it was issued with (\`scopes\` in \`POST /v1/api-keys\`, or \`--scopes\` in the key CLI). A key issued before scopes existed holds none and must be reissued.
- A cookie session holds the scopes of the user's workspace role: \`owner\` holds all five, \`admin\` and \`member\` all but \`sessions:recover\`.
- A credential without the required scope answers \`403 FORBIDDEN\` before the body or the resource is read.

## Starting a session with an API key

1. Issue an agent key for the agent with \`sessions:write\` and \`sessions:read\`: in the console's API keys screen, or \`POST /v1/api-keys\` with \`kind: "agent"\` and its \`agent_id\`. An owner, an admin or that agent's admin may.
2. \`GET /v1/agents\` with that key answers its agent alone. Its \`active_release_id\` is the release to start on; null until the agent is activated.
3. \`POST /v1/sessions\` with an \`Idempotency-Key\` and \`{"agent_release_id": "<active_release_id>", "message": "..."}\`. The release supplies the connection, the model and the repository.
4. \`GET /v1/sessions/{id}\` follows it.

A personal key with \`sessions:write\` may start sessions on any agent's release too, but lists no agents: read \`active_release_id\` from \`GET /v1/agents\` signed in to the console as an owner or an admin.

## Idempotency

Each command (any method but GET) says in its description whether \`Idempotency-Key\` is required or ignored. Where it is required, send 1–255 characters; a missing or invalid key answers \`400 BAD_REQUEST\`. The key is scoped to the caller, the operation and the target resource. Retrying with the same key and the same body returns the original status and body without running the command again; the same key with a different body answers \`409 IDEMPOTENCY_CONFLICT\`. After a timeout or a lost response, retry with the same key rather than a new one. Where it is ignored, nothing is replayed: a retry runs the command again, so reread the resource before retrying.

## Errors

Every error answers \`application/json\` with \`{"error": {"code", "message", "retryable", "request_id", "details"}}\` (\`ApiErrorResponse\`). Branch on \`code\`, not on \`message\`. \`retryable: true\` means the same request may succeed later unchanged (\`REQUEST_TIMEOUT\`, \`RATE_LIMITED\`, \`BACKEND_UNAVAILABLE\`, \`NOT_READY\`). Each response below lists its codes and when each one happens.

## Response headers

- \`X-Request-Id\`: on every response, a fresh id for this request; an error's \`request_id\` is the same value. Quote it when reporting a problem.
- \`Retry-After\`: seconds to wait, on \`429 RATE_LIMITED\` and on \`503 BACKEND_UNAVAILABLE\`.`;

export const SECURITY_SCHEME_DESCRIPTIONS = {
  bearerApiKey:
    "For servers and scripts: an API key sent as an HTTP bearer token, `Bearer <key>`. It holds exactly the scopes it was issued with; a key issued before scopes existed holds none. It never needs the CSRF header, and it cannot manage agents, members, teams or API keys. Issue one in the web console under Settings → API keys; each operation names the scope it needs.",
  cookieSession:
    "For the web console: the browser session cookie set by `POST /v1/auth/login`. It holds the scopes of the user's workspace role (`owner`: all; `admin` and `member`: all but `sessions:recover`). Requests other than GET must also send `X-Requested-With: werft-web`.",
} as const;

export const IDEMPOTENCY_KEY_DESCRIPTION =
  "Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read.";

export const LAST_EVENT_ID_DESCRIPTION =
  "The `id` of the last complete event received. Replay resumes strictly after it; omit it (or send it empty) to replay from the start. A malformed value answers `400 BAD_REQUEST`.";

export const RESPONSE_HEADERS = {
  RequestId: {
    description:
      "A fresh id for this request, on every response; an error body's `request_id` carries the same value.",
    schema: { type: "string", format: "uuid" },
  },
  RetryAfter: {
    description: "Seconds to wait before sending the same request again.",
    schema: { type: "integer", minimum: 1 },
  },
} as const;

type When = string | ((context: ErrorContext) => string);

function badRequest(context: ErrorContext): string {
  const causes = [
    context.body && "the body is not JSON or does not match the request schema",
    context.query && "a query parameter or the page cursor is invalid",
    context.idempotencyKey &&
      "the `Idempotency-Key` header is missing, empty or longer than 255 characters",
    context.lastEventId && "`Last-Event-ID` is malformed",
  ].filter(Boolean);
  return `The request is malformed: ${causes.join("; ")}. Fix the request before retrying.`;
}

function forbidden(context: ErrorContext): string {
  const causes: string[] = [];
  if (context.csrf === "always") {
    causes.push(
      `The request lacks \`X-Requested-With: ${CSRF_HEADER_VALUE}\` or is cross-site (\`Sec-Fetch-Site\`, \`Origin\`); every caller must send the header`,
    );
  } else if (context.csrf === "cookie") {
    causes.push(
      `CSRF: a cookie-authenticated request lacks \`X-Requested-With: ${CSRF_HEADER_VALUE}\` or is cross-site (\`Sec-Fetch-Site\`, \`Origin\`); API-key requests never need the header`,
    );
  }
  if (context.auth === "session") {
    causes.push(
      "Credential: an API key was sent; this operation takes a cookie session only",
      "Permission: where the description names who may call it, the signed-in member is not one of them",
    );
  }
  if (context.scope) {
    causes.push(
      `Scope: the credential does not hold \`${context.scope}\`, checked before the body or the resource is read`,
    );
  }
  return `${causes.join(". ")}.`;
}

/** When each code happens, as the API produces it on any operation. */
export const ERROR_CODE_WHEN: Partial<Record<ApiErrorCode, When>> = {
  BAD_REQUEST: badRequest,
  UNAUTHORIZED: (context) =>
    context.auth === "public"
      ? "The submitted credentials were rejected."
      : "No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie.",
  FORBIDDEN: forbidden,
  NOT_FOUND:
    "The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists.",
  REQUEST_TIMEOUT:
    "The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`).",
  PAYLOAD_TOO_LARGE: (context) =>
    context.message
      ? "The body is larger than 64 KiB, or `message` is longer than 32 KiB of UTF-8."
      : "The body is larger than 64 KiB.",
  STORAGE_LIMIT_EXCEEDED:
    "Accepting this message would exceed the installation's storage limit (`GET /v1/limits`). Retrying does not free space.",
  UNSUPPORTED_CAPABILITY:
    "This installation or the session's runtime cannot serve the request.",
  RATE_LIMITED: "Too many requests; wait for `Retry-After` and retry.",
  BACKEND_UNAVAILABLE:
    "Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`.",
  NOT_READY:
    "A readiness check failed; `error.details.check` names it (`database`, `schema` or `config`), or is `shutdown` while the process is shutting down.",
  CURSOR_EXPIRED:
    "The cursor fell outside retained history; reread the resource state and start a new stream. Reserved: alpha does not trim events.",
  IDEMPOTENCY_CONFLICT:
    "This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.",
  BOOTSTRAP_DONE: "An owner already exists; bootstrap runs once.",
  REVISION_CONFLICT:
    "`expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.",
  SESSION_PAUSED: "The session is pausing or paused; resume it first.",
  SESSION_RESUMING: "The session is resuming; wait for the resume receipt.",
  SESSION_STOPPED: "The session is stopping or stopped; resume it first.",
  SESSION_CLOSED: "The session is closed and accepts no further commands.",
  SESSION_CLOSING:
    "The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.",
  RECOVERY_REQUIRED:
    "The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).",
  CHECKPOINT_UNAVAILABLE:
    "The session has no committed checkpoint that can serve this request.",
  REQUEST_EXPIRED:
    "The pending request was already answered, expired or closed.",
  REQUEST_STALE: "The request was made against state that has since moved on.",
  TURN_NOT_STARTED:
    "The target turn is still queued; there is nothing to interrupt yet.",
  PAUSE_COMMITTING:
    "The pause has already committed its stop and can no longer be cancelled; wait for it, then resume.",
  TAKEOVER_REQUIRED:
    "The person who asked for the session was offboarded; it takes no input until an owner takes it over.",
  ALREADY_EXISTS:
    "A resource with the same identity already exists; the operation names which field must be unique.",
  INVITE_USED: "The invite was already accepted and cannot be used again.",
  INVITE_EXPIRED:
    "The invite was revoked, replaced by a newer one, or has expired. Ask for a new invite.",
  LAST_OWNER: "The change would leave the workspace with no live owner.",
  SELF_PROTECTED:
    "A manager cannot change their own role or disable or enable themselves; another manager does it.",
  MEMBER_DISABLED:
    "The membership is disabled. Enable it before changing the role.",
  ACCOUNT_DISABLED:
    "The account is suspended. Lift the suspension before changing the role or enabling the membership.",
  OWNER_PROTECTED:
    "Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).",
  SCOPE_NOT_GRANTABLE: "The key asks for a scope its issuer does not hold now.",
  SLACK_NOT_INSTALLED:
    "The workspace has no verified Slack install for this team.",
  LINK_TEAM_MISMATCH:
    "The Slack account belongs to another Slack team than the workspace's install.",
  LINK_TAKEN: "The Slack account is already linked to another person.",
  LINK_EXISTS:
    "The caller already linked a different Slack account in this team; unlink it first.",
  AGENT_IDENTITY_TAKEN:
    "The Slack app and team are already pinned to another agent; revoke that identity first.",
  CREDENTIAL_REF_IN_USE:
    "The credential name is already held by an agent identity, or bound to an agent an identity would take it from.",
  VARIABLE_NAME_INVALID:
    "The variable name is not upper case: a letter, then letters, digits or `_`, 64 characters at most.",
  VARIABLE_NAME_RESERVED:
    "The platform sets that name itself (credentials, proxies, git, loader and shell variables); pick another.",
  VARIABLE_VALUE_INVALID:
    "The value holds a NUL byte or is not valid UTF-8 text.",
  VARIABLE_VALUE_TOO_LARGE: "The value is more than 48 KB (UTF-8 bytes).",
  VARIABLE_QUOTA_EXCEEDED:
    "The workspace already holds 100 variables, or the agent 50; delete one first.",
  SECRET_ACK_REQUIRED:
    "A secret asked for engine delivery without `acknowledge_engine_exposure: true`.",
  SECRET_GRANT_ALL_FORBIDDEN:
    "A secret is granted to named agents only, never to every agent.",
  SECRET_ENV_UNSUPPORTED:
    "Only `kind: plain` is accepted: no runtime can carry a secret variable yet.",
  VERSION_MISMATCH:
    "`If-Match` names another version than the current one, the variable does not exist, or `If-None-Match: *` met one that does. Read it again and retry.",
  PRECONDITION_REQUIRED:
    "The write sent neither `If-Match` nor `If-None-Match: *`.",
  CREDENTIAL_UNBOUND:
    "The release names a credential its agent has no live binding for; an agent admin must bind it first.",
  AGENT_NOT_RUNNABLE:
    "A new session cannot start: `error.details.reason_code` is `agent_inactive` (the agent is paused or archived) or `release_unapproved` (the release named was never approved by an activation). A session pinned to an older release that was approved still starts while the agent is active.",
  RELEASE_SPEC_UNAVAILABLE:
    "The release's connection is disabled or gone, or its model left the connection's list; release the agent again. `error.details.reason_code` is `connection_missing` or `model_removed`.",
  LOGIN_LINK_REQUIRED:
    "The verified address already has an account. It is never joined by email: sign in with the existing account and link the external login there.",
  PUSH_SOURCE_MISSING:
    "The session has no repository, or no committed checkpoint, to push.",
  PUSH_REQUEST_OPEN:
    "The session already has an open push request (`requested`, `approved` or `pushing`) to the same repository and branch; the refusal receipt's `result.push_request_id` names it.",
  PUSH_REQUEST_DECIDED: "The push request was already approved or rejected.",
  PUSH_REQUEST_RESOLVED: "The push request was already approved or rejected.",
  CHECKPOINT_MOVED:
    "The commit or checkpoint named no longer matches what the push request pinned.",
  CATALOG_MISMATCH:
    "The catalog no longer allows what the request depends on: the session's connection, model or repository, or the repository entry a push request pinned.",
  PUSH_NOT_PUSHED:
    "The push request has not been pushed (`state` is not `pushed`); a pull request opens only from a pushed branch.",
  PULL_REQUEST_MISSING:
    "No pull request was opened from this push request yet; open it first.",
  PULL_REQUEST_MERGED:
    "The pull request was merged; a merged pull request is neither closed nor reopened.",
  PULL_REQUEST_MERGE_BLOCKED:
    "GitHub will not merge the pull request now: a required check is pending or failed, a review or conversation is open, it is a draft or it conflicts. Try again once that changes.",
  PULL_REQUEST_CLOSED:
    "The pull request was closed without being merged; reopen it before merging.",
  GITHUB_REFUSED:
    "The platform refused the GitHub work before asking GitHub, or GitHub refused the token it asked for. `error.details.reason_code` says why and `error.details.receipt_id` names the receipt of the refusal. A refusal the workspace or the agent's release decided (`github_disabled`, `repository_not_allowed`, `feature_off`, `workflow_not_allowed`, `agent_ref_refused`, `run_ref_unprovable`) is 403; one an owner fixes outside the release (`over_workspace_ceiling`, `app_required`, `app_permission_missing`, `github_host_unsupported`, `no_reviewer_app`, `github_settings_unsupported`) is 409. `merge_off` (the workspace has not allowed agents to merge) is 409 too, and is answered before GitHub is called.",
  GITHUB_APP_CONFLICT:
    "The App would clash with the workspace's other GitHub App. `error.details.reason_code` says how: `same_app` (the other role already holds this App; GitHub refuses an approval from the App that opened the pull request) or `no_author_app` (a reviewer App needs the author App first).",
  GITHUB_UNAVAILABLE:
    "GitHub did not give the App's installations or repositories. `error.details.reason_code` is `github_unavailable` (GitHub did not answer, answered 5xx, or rate-limited the App; try again later) or `github_app_auth_failed` (GitHub refused the App's JWT: the key was revoked or the App deleted; a retry does not help).",
  INSTALLATION_SUSPENDED:
    "GitHub has suspended the App installation the request named; an owner of that account resumes it on GitHub.",
  PENDING_REQUESTS_OPEN:
    "A request the parked turn waits on is neither answered nor expired yet.",
  PERMISSION_WAIT_ABOVE_LIMIT:
    "A requested wait is longer than the installation allows.",
  TEAM_MANAGES_AGENTS:
    "The team is still the managing team of live agents, named in `error.details.agent_ids`; give each another managing team first.",
  CONFIG_TOKEN_INVALID:
    "The workspace's Slack App Configuration Token cannot be used. `error.details.reason_code` is `not_set` (none stored), `rejected` (Slack refused it; paste another) or `needs_reentry` (Slack no longer takes the stored token, or a rotation's answer was lost; an owner or admin pastes a new one).",
  SLACK_APP_CREATING:
    "The Slack app (the agent's, or the workspace's link app) is still being created. `error.details.uncertain: true` means Slack's answer was lost: check api.slack.com/apps for an app made at that time, delete it, then retry with `replace_uncertain: true`.",
  SLACK_APP_GONE:
    "Slack no longer has the agent's app: asked with the App Configuration Token of the Slack user who made the app, `apps.manifest.export` answered that it does not exist (e.g. it was deleted in Slack). `error.details` names the `slack_app_id` and Slack's `app_id`. Delete the app with `DELETE /v1/workspaces/{id}/slack/apps/{app_id}` and create it again.",
  AGENT_NOT_ACTIVE: "The agent has no active release; activate one first.",
  SLACK_INSTALL_STATE_INVALID:
    "The install link's state cannot be used: `error.details.reason_code` is `not_found` (unknown or already spent), `expired`, or `workspace`, `actor`, `agent` or `app` (issued to another workspace, person or agent, or for an app the agent no longer has). Start the install again.",
  SLACK_INSTALL_DENIED:
    "Slack sent the admin back without approving (`error.details.slack_error`, e.g. `access_denied`). Start the install again to retry.",
  SLACK_INSTALL_REJECTED:
    "Slack's answer was not stored: `error.details.reason_code` is `app` or `team` (another app or Slack team than expected), `enterprise` (an org-wide install), `scope` (`error.details.missing_scopes` lists the bot scopes not granted) or `slack_error` (Slack refused; `error.details.slack_error`).",
  SLACK_INSTALL_CONFLICT:
    "This Slack app is already installed in that Slack team for another workspace.",
  SLACK_LINK_NOT_CONFIGURED:
    "Slack account linking cannot start: the workspace has no link app, nothing to make one with (no usable App Configuration Token) and no fallback OIDC app. `error.details.reason_code` is `config_token` or `no_console` (`store_off` does not occur: the API does not start without its master key, PLATFORM_SECRET_KEY). Ask an owner or admin to set up Slack in Integrations.",
  GITHUB_LINK_NOT_CONFIGURED:
    "GitHub account linking is not set up: `error.details.reason_code` is `no_author_app` (the workspace has no author GitHub App) or `github_oauth_unset` (the App's client id or client secret, or the console's origin, is missing). Ask an owner or admin to finish user linking in Integrations > GitHub.",
};

function when(
  code: ApiErrorCode,
  context: ErrorContext,
  notes: Partial<Record<ApiErrorCode, string>> | undefined,
): string {
  const generic = ERROR_CODE_WHEN[code];
  if (!generic) throw new Error(`No ERROR_CODE_WHEN entry for ${code}`);
  const text = typeof generic === "string" ? generic : generic(context);
  const note = notes?.[code];
  return note ? `${text} ${note}` : text;
}

/**
 * One line per code: when that code is the answer. A note narrows the shared
 * sentence for one operation; it is appended, never a replacement.
 */
export function errorResponseDescription(
  codes: readonly ApiErrorCode[],
  context: ErrorContext,
  notes?: Partial<Record<ApiErrorCode, string>>,
): string {
  return codes
    .map((code) => `- \`${code}\`: ${when(code, context, notes)}`)
    .join("\n");
}

/** Who may call the operation and how it treats Idempotency-Key. */
export function accessNote(
  context: ErrorContext,
  method: "get" | "post" | "put" | "patch" | "delete",
): string {
  const who = context.scope
    ? `**Scope:** \`${context.scope}\` (API key or cookie session).`
    : context.auth === "session"
      ? "**Auth:** cookie session only; no scope."
      : "**Auth:** public; no credential.";
  if (method === "get") return who;
  return `${who} **Idempotency-Key:** ${context.idempotencyKey ? "required" : "ignored"}.`;
}
