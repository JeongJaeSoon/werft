import {
  type HostExtractor,
  plainTextHostExtractor,
  plainTextHosts,
} from "@werft-ai/platform";
import {
  micromark,
  parse as parseMarkdown,
  postprocess,
  preprocess,
} from "micromark";
import { parse, parseFragment } from "parse5";

/** Markdown or HTML larger than this many bytes is not rendered: its hosts cannot be judged. */
export const RENDER_LIMIT = 256 * 1024;
const MARKDOWN = /\.(?:md|markdown|mdx)$/i;
const HTML = /\.html?$/i;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** The parse5 tree as far as the hosts are read from it. */
interface HtmlNode {
  readonly nodeName: string;
  readonly value?: string;
  readonly data?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly content?: HtmlNode;
}

/**
 * The Markdown with a reference to every link definition put first, so a
 * definition nothing uses still renders as the link a reader of the source
 * sees. First, not last: an unclosed code fence would swallow a tail.
 */
function withDefinitionsUsed(text: string): string {
  const events = postprocess(
    parseMarkdown()
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const labels = events
    .filter(
      ([kind, token]) =>
        kind === "enter" && token.type === "definitionLabelString",
    )
    .map(([, token, context]) => `[${context.sliceSerialize(token)}]`);
  return labels.length === 0 ? text : `${labels.join("\n\n")}\n\n${text}`;
}

/** The host of a link target as a browser follows it, or null. */
function targetHost(target: string): string | null {
  const value = target
    .replace(/[\t\n\r]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser strips C0 and space around a URL
    .replace(/^[\u{0}-\u{20}]+|[\u{0}-\u{20}]+$/gu, "");
  const url = value.startsWith("//") ? `https:${value}` : value;
  if (!/^https?:/i.test(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * The skill checks' host reader. Markdown is read as CommonMark renders it
 * and HTML as a browser parses it: every attribute value that is a URL, and
 * the text and comments by the plain-text rule. Any other file is plain
 * text. URLs a script assembles, other encodings and plain text broken
 * across lines are not read. Past RENDER_LIMIT, or when the renderer fails,
 * the file cannot be judged.
 */
export const renderedHostExtractor: HostExtractor = (path, bytes) => {
  const markdown = MARKDOWN.test(path);
  if (!markdown && !HTML.test(path)) {
    return plainTextHostExtractor(path, bytes);
  }
  if (bytes.length > RENDER_LIMIT) return null;
  const text = decoder.decode(bytes);
  let root: HtmlNode;
  try {
    root = (markdown
      ? parseFragment(
          micromark(withDefinitionsUsed(text), {
            allowDangerousHtml: true,
            allowDangerousProtocol: true,
          }),
        )
      : parse(text)) as unknown as HtmlNode;
  } catch {
    return null;
  }
  const hosts = new Set<string>();
  const pending: HtmlNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const attr of node.attrs ?? []) {
      const host = targetHost(attr.value);
      if (host !== null) hosts.add(host);
    }
    const shown =
      node.nodeName === "#text"
        ? node.value
        : node.nodeName === "#comment"
          ? node.data
          : undefined;
    if (shown !== undefined) {
      for (const host of plainTextHosts(shown)) hosts.add(host);
    }
    for (const child of node.childNodes ?? []) pending.push(child);
    if (node.content !== undefined) pending.push(node.content);
  }
  return hosts;
};
