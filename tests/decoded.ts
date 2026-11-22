/** `text` with its percent-escapes decoded, or as it is when they are malformed. */
export function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
