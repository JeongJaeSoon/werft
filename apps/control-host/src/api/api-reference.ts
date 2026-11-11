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
