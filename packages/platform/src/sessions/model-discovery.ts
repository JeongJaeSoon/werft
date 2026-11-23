import { type CatalogProvider, providerUpstreamOf } from "../catalog/index.ts";
import {
  type OutboundHttp,
  OutboundRefusedError,
  type OutboundResponse,
} from "../ports/outbound-http.ts";

// Asks a connection's provider which models it serves, with the connection's
// own key. Only parsed ids and display names leave this module: never the
// key, a request header or a body the provider sent.

export type DiscoveredModel = { id: string; display_name: string | null };

export type ProviderModelList = {
  models: DiscoveredModel[];
  skipped: number;
  truncated: boolean;
};

export type ModelDiscoveryReason =
  | "address_not_allowed"
  | "provider_unauthorized"
  | "provider_answered"
  | "provider_unreachable"
  | "provider_failed"
  | "credential_reflected";

export class ModelDiscoveryError extends Error {
  constructor(
    readonly reason: ModelDiscoveryReason,
    message: string,
    /** The provider's HTTP status, when it answered. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_PAGES_MAX = 10;
// The save schema's limit on one model id.
const MODEL_ID_MAX = 128;
const DISPLAY_NAME_MAX = 200;
// Far past what a person picks from; the rest is said to be cut.
const MODELS_MAX = 1000;

// OpenAI lists every model the key reaches; these families take no Responses
// conversation, so an agent cannot run on them.
const OPENAI_NOT_CHAT =
  /embedding|tts|whisper|transcribe|dall-e|gpt-image|moderation|realtime|audio|davinci|babbage|sora/i;

type Page = { items: unknown[]; nextAfter: string | null };

async function get(
  http: OutboundHttp,
  url: string,
  headers: Record<string, string>,
  secret: string,
): Promise<unknown> {
  let response: OutboundResponse;
  try {
    response = await http({ url, method: "GET", headers });
  } catch (error) {
    if (error instanceof OutboundRefusedError) {
      throw error.reason === "address_not_allowed"
        ? new ModelDiscoveryError(
            "address_not_allowed",
            "The endpoint resolves to an address this server may not call",
          )
        : new ModelDiscoveryError(
            "provider_unreachable",
            "The provider could not be reached",
          );
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelDiscoveryError(
      "provider_unauthorized",
      "The provider refused the connection's key",
      response.status,
    );
  }
  if (response.status < 200 || response.status > 299) {
    throw new ModelDiscoveryError(
      "provider_answered",
      `The provider answered ${response.status}`,
      response.status,
    );
  }
  if (
    secret !== "" &&
    (response.text.includes(secret) ||
      [...response.headers.values()].some((value) => value.includes(secret)))
  ) {
    throw reflected();
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    throw malformed();
  }
  // A `\u` escape hides the key from the raw text, and trimming or cutting a
  // field later could leave all of it but one character: check what parsed.
  if (secret !== "" && carries(body, secret)) throw reflected();
  return body;
}

function carries(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => carries(item, secret));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => key.includes(secret) || carries(item, secret),
    );
  }
  return false;
}

const reflected = () =>
  new ModelDiscoveryError(
    "credential_reflected",
    "The provider sent the connection's key back",
  );
const malformed = () =>
  new ModelDiscoveryError(
    "provider_failed",
    "The provider's model list is not one this server reads",
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pageOf(body: unknown, paged: boolean): Page {
  if (!isRecord(body) || !Array.isArray(body.data)) throw malformed();
  const lastId = body.last_id;
  return {
    items: body.data,
    nextAfter:
      paged &&
      body.has_more === true &&
      typeof lastId === "string" &&
      lastId !== ""
        ? lastId
        : null,
  };
}

function headersOf(provider: CatalogProvider): Record<string, string> {
  const headers = Object.fromEntries(providerUpstreamOf(provider).headers);
  return provider.kind === "anthropic"
    ? {
        ...headers,
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "application/json",
      }
    : { ...headers, accept: "application/json" };
}

/**
 * The models a connection's provider lists: Anthropic's `GET /v1/models`
 * followed page by page, OpenAI's and LiteLLM's in one read. Provider order,
 * repeats dropped.
 */
export async function listProviderModels(
  provider: CatalogProvider,
  http: OutboundHttp,
): Promise<ProviderModelList> {
  const base = `${provider.endpoint.replace(/\/+$/, "")}/v1/models`;
  const headers = headersOf(provider);
  const secret = provider.auth.value;
  const items: unknown[] = [];
  let truncated = false;
  if (provider.kind === "anthropic") {
    let after: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page === ANTHROPIC_PAGES_MAX) {
        truncated = true;
        break;
      }
      const url: string =
        after === null
          ? `${base}?limit=1000`
          : `${base}?limit=1000&after_id=${encodeURIComponent(after)}`;
      const read = pageOf(await get(http, url, headers, secret), true);
      items.push(...read.items);
      if (read.nextAfter === null) break;
      after = read.nextAfter;
    }
  } else {
    items.push(...pageOf(await get(http, base, headers, secret), false).items);
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  let skipped = 0;
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    if (
      id.length > MODEL_ID_MAX ||
      (provider.kind === "openai_responses" && OPENAI_NOT_CHAT.test(id))
    ) {
      skipped += 1;
      continue;
    }
    if (models.length === MODELS_MAX) {
      truncated = true;
      break;
    }
    const name =
      provider.kind === "anthropic" && typeof item.display_name === "string"
        ? item.display_name.trim().slice(0, DISPLAY_NAME_MAX)
        : "";
    models.push({ id, display_name: name === "" ? null : name });
  }
  return { models, skipped, truncated };
}
