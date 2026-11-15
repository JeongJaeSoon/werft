/** The query an MCP server's authorization server sends the console back with. */
export function workspaceMcpCallbackSearch(search: Record<string, unknown>) {
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    code: text(search.code),
    state: text(search.state),
    iss: text(search.iss),
    error: text(search.error),
  };
}
