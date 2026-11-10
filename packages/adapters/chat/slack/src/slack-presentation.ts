// Ported from Kollegium packages/slack/src/presentation.ts (d387c73,
// :90-153 and its code-span walk). Model and user text reaching Slack must not
// notify anyone it was not meant to, so every control is escaped unless the
// caller vouches for it.

/** Controls the caller sourced from trusted Slack or runtime metadata. */
export type SlackMentionPolicy = {
  userIds?: readonly string[];
  channelIds?: readonly string[];
  userGroupIds?: readonly string[];
  /** Broad notifications need an explicit entry. */
  special?: readonly ("here" | "channel" | "everyone")[];
  /**
   * `expand` writes a safe `<url|label>` out as `label (url)`, so a label
   * cannot hide where a link goes. Default `keep`.
   */
  maskedLinks?: "keep" | "expand";
};

export function isSafeUrl(value: string): boolean {
  if (/[<>|\s]/.test(value)) return false;
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function trustedControl(
  control: string,
  policy: SlackMentionPolicy | undefined,
): boolean {
  // A nested control can smuggle a mention into a link label, and a Slack link
  // never needs another `<...>` inside it. A backtick is refused too: keeping
  // escaping from moving backticks keeps the code boundaries found in the input.
  if (control.includes("<") || control.includes("`")) return false;

  const user = /^@([UW][A-Z0-9]+)$/i.exec(control);
  if (user?.[1] !== undefined)
    return policy?.userIds?.includes(user[1]) === true;

  const channel = /^#([CGD][A-Z0-9]+)(?:\|[^>]+)?$/i.exec(control);
  if (channel?.[1] !== undefined)
    return policy?.channelIds?.includes(channel[1]) === true;

  const group = /^!subteam\^([A-Z0-9]+)(?:\|[^>]+)?$/i.exec(control);
  if (group?.[1] !== undefined)
    return policy?.userGroupIds?.includes(group[1]) === true;

  const special = /^!(here|channel|everyone)$/i.exec(control);
  if (special?.[1] !== undefined) {
    return (
      policy?.special?.includes(
        special[1].toLowerCase() as "here" | "channel" | "everyone",
      ) === true
    );
  }

  // A date notifies nobody, but its optional `^link` part would put the date
  // over a destination no policy sees, so only timestamp, format and fallback
  // pass.
  if (control.startsWith("!date^")) {
    return /^!date\^\d+\^[^^|]+\|[^^|]+$/.test(control);
  }

  const destination = control.split("|", 1)[0] ?? "";
  return isSafeUrl(destination);
}

function escapeAmpersands(value: string): string {
  return value.replace(/&(?!(?:amp|lt|gt);)/g, "&amp;");
}

function escapeControls(
  value: string,
  policy: SlackMentionPolicy | undefined,
): string {
  const escapedAmpersands = escapeAmpersands(value);
  // A lone `<` is escaped too: a backtick can split a control so this walk
  // sees no `>`, while Slack still reads `<!subteam^S1|`x`>` as one mention.
  return escapedAmpersands.replace(
    /<([^>\n]+)>|</g,
    (whole, control?: string) => {
      if (control === undefined) return "&lt;";
      if (!trustedControl(control, policy)) {
        return `&lt;${control.replace(/</g, "&lt;")}&gt;`;
      }
      const bar = control.indexOf("|");
      const url = control.slice(0, bar);
      return policy?.maskedLinks === "expand" && bar !== -1 && isSafeUrl(url)
        ? `${control.slice(bar + 1)} (${url})`
        : whole;
    },
  );
}

// Slack still parses controls inside backticks, so code shows every bracket as
// a character and no policy applies there.
function escapeCode(value: string): string {
  return escapeAmpersands(value).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mapCodeAndText(
  value: string,
  text: (part: string) => string,
  code: (part: string) => string,
): string {
  let output = "";
  let plainStart = 0;
  let index = 0;

  while (index < value.length) {
    // Slack renders an unclosed fence, an unclosed backtick or a backtick
    // pair split by a line break as plain text, so none of them may shield
    // what follows from escaping.
    if (value.startsWith("```", index)) {
      const end = value.indexOf("```", index + 3);
      if (end === -1) {
        index += 3;
        continue;
      }
      output += text(value.slice(plainStart, index));
      output += code(value.slice(index, end + 3));
      index = end + 3;
      plainStart = index;
      continue;
    }

    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      if (end === -1 || value.slice(index, end).includes("\n")) {
        index += 1;
        continue;
      }
      output += text(value.slice(plainStart, index));
      output += code(value.slice(index, end + 1));
      index = end + 1;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  return output + text(value.slice(plainStart));
}

/**
 * Escapes Slack mentions and control sequences. Outside code, without a
 * policy every user, channel, group and broad mention is escaped; safe links
 * and date controls are kept. Inside inline and fenced code every control is
 * escaped.
 */
export function escapeSlackControls(
  text: string,
  policy?: SlackMentionPolicy,
): string {
  return mapCodeAndText(
    text,
    (part) => escapeControls(part, policy),
    escapeCode,
  );
}
