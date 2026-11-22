/** A tool's input as the reader sees it: indented JSON, else its string. */
export function inputText(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
