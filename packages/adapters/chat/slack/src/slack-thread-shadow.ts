export type SlackThreadShadow = {
  /** What a silence rule would do with the message; nothing acts on it yet. */
  decision: "reply" | "skip";
  reason: "addressed_to_other_user" | "default_reply";
};

/**
 * Stage 1 of mention-less replies: judge whether an unmentioned reply in a
 * thread the agent is in would have been answered. Another person's mention
 * is only a signal, since "explain this to <@U2>" is a real request, so a
 * question mark keeps the reply. Korean questions often carry no mark, which
 * is why the record is reviewed by a person before any rule is acted on.
 */
export function judgeThreadReply(
  text: string,
  botUserId: string,
): SlackThreadShadow {
  const mentionsOther = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].some(
    (match) => match[1] !== botUserId,
  );
  const question = /[?？]/.test(text);
  return mentionsOther && !question
    ? { decision: "skip", reason: "addressed_to_other_user" }
    : { decision: "reply", reason: "default_reply" };
}
