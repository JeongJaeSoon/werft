// The words that, alone in an open work's thread, ask the agent to stop
// (handling table row 12). Only the whole message counts: a word inside a
// longer one ("멈춰 주세요, 그런데 …") is that message, for the work to read.
export const STOP_REQUEST_WORDS = {
  ko: ["그만", "그만해", "멈춰", "멈춰줘", "중지"],
  ja: ["止めて", "やめて", "ストップ", "停止"],
  en: ["stop"],
} as const;

const WORDS: ReadonlySet<string> = new Set(
  Object.values(STOP_REQUEST_WORDS).flat(),
);

/**
 * Whether the text, the agent's mention already taken out, is one stop
 * word: spaces around it, any case, and closing punctuation are allowed.
 */
export function isStopRequest(text: string): boolean {
  const word = text
    .normalize("NFKC")
    .trim()
    .replace(/[.!。]+$/u, "")
    .trim()
    .toLowerCase();
  return WORDS.has(word);
}
