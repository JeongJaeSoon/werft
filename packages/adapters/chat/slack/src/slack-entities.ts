/**
 * Slack escapes only `&`, `<` and `>` in a message's text. Read in one
 * pass, so `&amp;amp;` is the text `&amp;` and no other HTML entity is touched.
 * Run it last: Slack notation (`<@U1>`, `<url|text>`) is read on the raw text,
 * so an escaped `&lt;@U1&gt;` never becomes a mention.
 */
export function unescapeSlackText(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : ">",
  );
}
