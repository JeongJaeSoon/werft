import { createHash, randomBytes } from "node:crypto";
import {
  acceptedRuntimeVersions,
  type CatalogProfile,
  catalogProfile,
  type SessionCatalog,
  sessionProfile,
} from "./catalog.ts";
import type { SessionTitleStore } from "./ports/session-title-store.ts";
import { deriveSessionTitle } from "./session-title.ts";

export const TITLE_TOKEN_PREFIX = "wet_";
// Long enough for one short Messages call through the proxy, short enough
// that a request whose API died mid-call stops authorizing soon after.
const TITLE_TOKEN_TTL_MS = 2 * 60_000;
// Under the proxy's 30s regrant: the token is used up by the first grant,
// so an exchange still open then is cut.
const TITLE_CALL_TIMEOUT_MS = 25_000;
const TITLE_MAX_TOKENS = 64;
// What of the first turn the model is shown; a title needs the gist only.
const EXCERPT_CHARS = 2_000;

const TITLE_SYSTEM =
  "You name conversations. Write a title for the conversation the user shows you: at most eight words, in the language the user wrote in, plain text, no quotes and no ending punctuation. Reply with the title inside <title></title> tags and nothing else: no label, no explanation.";

/**
 * Names a session after its first turn, through the egress proxy's provider
 * route like any of the session's model calls: the proxy puts the profile's
 * credential on it and reports what it used, so the cost lands on the
 * session. Whatever goes wrong, the title cut from the first message stays.
 */
export function createSessionTitler(deps: {
  store: SessionTitleStore;
  catalog: SessionCatalog;
  // The proxy's credential listener, e.g. http://egress-proxy:3129.
  egressUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  onError?: (error: unknown, context: { sessionId: string }) => void;
}) {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const base = deps.egressUrl.replace(/\/+$/, "");

  async function call(token: string, model: string, prompt: string) {
    const response = await send(`${base}/provider/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": token,
      },
      body: JSON.stringify({
        model,
        max_tokens: TITLE_MAX_TOKENS,
        system: TITLE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(TITLE_CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`title call answered ${response.status}`);
    }
    return titleOf(await response.json());
  }

  return {
    /**
     * Never rejects: the caller has already answered the worker and has no
     * one to report to.
     */
    async afterFirstTurn(input: {
      sessionId: string;
      attemptId: string;
    }): Promise<"applied" | "kept" | "skipped"> {
      const token = `${TITLE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const tokenHash = hashTitleToken(token);
      let issued: Awaited<ReturnType<SessionTitleStore["issueAtomic"]>>;
      try {
        issued = await deps.store.issueAtomic({
          ...input,
          tokenHash,
          ttlMs: TITLE_TOKEN_TTL_MS,
        });
      } catch (error) {
        deps.onError?.(error, input);
        return "skipped";
      }
      if (issued.outcome === "skipped") return "skipped";
      let title: string | null = null;
      try {
        const profile = titleProfile(deps.catalog, issued);
        if (profile === null) throw new Error("the session's profile moved");
        title = await call(
          token,
          profile.title_model ?? profile.model,
          promptOf(issued.message, issued.result),
        );
      } catch (error) {
        deps.onError?.(error, input);
      }
      try {
        const settled = await deps.store.settleAtomic({
          tokenHash,
          title,
          now: now(),
        });
        return settled.outcome;
      } catch (error) {
        deps.onError?.(error, input);
        return "kept";
      }
    },
  };
}

export type SessionTitler = ReturnType<typeof createSessionTitler>;

export function hashTitleToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The profile the session runs, as long as the catalog still offers it. */
export function titleProfile(
  catalog: SessionCatalog,
  session: {
    profileId: string | null;
    profileFingerprint: string | null;
    model: string | null;
  },
): CatalogProfile | null {
  const listed = session.profileId
    ? catalogProfile(catalog, session.profileId)
    : undefined;
  if (!listed) return null;
  return sessionProfile(
    listed,
    { fingerprint: session.profileFingerprint, model: session.model },
    acceptedRuntimeVersions(catalog),
  );
}

function excerpt(text: string): string {
  return text.length <= EXCERPT_CHARS
    ? text
    : `${text.slice(0, EXCERPT_CHARS)}…`;
}

function promptOf(message: string, result: string | null): string {
  const parts = [`<user>\n${excerpt(message)}\n</user>`];
  if (result !== null && result.trim() !== "") {
    parts.push(`<assistant>\n${excerpt(result)}\n</assistant>`);
  }
  return parts.join("\n");
}

/**
 * The text inside the answer's <title> tag as a title, or null when there is
 * no tag or nothing usable is left. Untagged text is never a title: a model
 * that explains itself instead of answering would otherwise leak that
 * explanation into the session name.
 */
export function titleOf(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { content } = answer as { content?: unknown };
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  // Exactly one single-line tag: several tags or a multi-line body mean the
  // model was thinking aloud, and which part is the title cannot be told.
  const tags = [...text.matchAll(/<title>([^<]*)<\/title>/g)];
  const line = tags.length === 1 ? (tags[0]?.[1] ?? "").trim() : "";
  if (line === "" || line.includes("\n")) return null;
  const unquoted = line.replace(/^[\s"'`“”‘’「」]+|[\s"'`“”‘’「」.。]+$/g, "");
  return deriveSessionTitle(unquoted);
}
