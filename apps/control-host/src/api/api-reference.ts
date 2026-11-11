import { join } from "node:path";
import type { Env, Hono } from "hono";

// Scalar configuration for the API reference. The committed copy
// (docs/api/index.html, also published to GitHub Pages) has no API behind
// it, so it stays read-only; GET /docs swaps in the interactive one, whose
// requests go to the same origin with the key the reader types.
const BASE_CONFIGURATION = {
  agent: { disabled: true },
  hideClientButton: true,
  isEditable: false,
  // Scalar offers its MCP generator on localhost unless told not to.
  mcp: { disabled: true },
  showDeveloperTools: "never",
  showToolbar: "never",
  telemetry: false,
  withDefaultFonts: false,
};

const READ_ONLY_CONFIGURATION = {
  ...BASE_CONFIGURATION,
  hideTestRequestButton: true,
};

const INTERACTIVE_CONFIGURATION = {
  ...BASE_CONFIGURATION,
  hideTestRequestButton: false,
  authentication: { preferredSecurityScheme: "bearerApiKey" },
  persistAuth: false,
};

// The interactive page allows only styles carrying its nonce. Scalar gives
// its own stylesheet the nonce from <meta property="csp-nonce">, but the
// CodeMirror response viewer and a few components add <style> elements
// without one, so their rules are refused and the viewer renders unstyled.
// Loaded before scalar.js, this hands every new <style> that same nonce.
export const STYLE_NONCE_SCRIPT = `(() => {
  const nonce = document.querySelector('meta[property="csp-nonce"]')?.content;
  if (!nonce) return;
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() === "style") element.setAttribute("nonce", nonce);
    return element;
  };
})();
`;

function htmlAttribute(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export const READ_ONLY_CONFIGURATION_ATTRIBUTE = `data-configuration="${htmlAttribute(READ_ONLY_CONFIGURATION)}"`;
export const INTERACTIVE_CONFIGURATION_ATTRIBUTE = `data-configuration="${htmlAttribute(INTERACTIVE_CONFIGURATION)}"`;

const API_REFERENCE_DIRECTORY = join(import.meta.dir, "../../../../docs/api");
const API_REFERENCE_SECURITY_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
let apiReferenceHtml: Promise<string> | undefined;

function readApiReferenceHtml(): Promise<string> {
  apiReferenceHtml ??= Bun.file(join(API_REFERENCE_DIRECTORY, "index.html"))
    .text()
    .then((html) => {
      if (!html.includes(READ_ONLY_CONFIGURATION_ATTRIBUTE))
        throw new Error(
          "docs/api/index.html is stale; run apps/control-host/scripts/generate-openapi.ts",
        );
      return html
        .replace(
          '<script src="./scalar.js"></script>',
          '<script src="/docs/style-nonce.js"></script>\n    <script src="/docs/scalar.js"></script>',
        )
        .replace(
          READ_ONLY_CONFIGURATION_ATTRIBUTE,
          INTERACTIVE_CONFIGURATION_ATTRIBUTE,
        );
    });
  return apiReferenceHtml;
}

async function renderApiReferenceHtml(nonce: string): Promise<string> {
  return (await readApiReferenceHtml()).replace(
    '    <meta charset="utf-8">',
    `    <meta charset="utf-8">\n    <meta property="csp-nonce" content="${nonce}">`,
  );
}

function apiReferenceCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'nonce-${nonce}'`,
    "img-src data:",
    "connect-src 'self'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function registerApiReferenceRoutes<E extends Env>(app: Hono<E>): void {
  app.get("/docs", async () => {
    const nonce = crypto.randomUUID();
    return new Response(await renderApiReferenceHtml(nonce), {
      headers: {
        ...API_REFERENCE_SECURITY_HEADERS,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": apiReferenceCsp(nonce),
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  });
  app.get(
    "/docs/style-nonce.js",
    () =>
      new Response(STYLE_NONCE_SCRIPT, {
        headers: {
          ...API_REFERENCE_SECURITY_HEADERS,
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/javascript; charset=utf-8",
        },
      }),
  );
  app.get(
    "/docs/scalar.js",
    () =>
      new Response(Bun.file(join(API_REFERENCE_DIRECTORY, "scalar.js")), {
        headers: {
          ...API_REFERENCE_SECURITY_HEADERS,
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/javascript; charset=utf-8",
        },
      }),
  );
}
