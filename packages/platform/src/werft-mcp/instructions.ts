/**
 * What the built-in `werft` server says of itself in its handshake: what it
 * is for, when an agent turns to it first, and that an unclear question
 * starts with a status check. No tool is named: the names belong to the
 * tools' own descriptions, and change without this text changing.
 */
export const WERFT_MCP_INSTRUCTIONS = [
  "This server is Werft's own: Werft is the platform this agent runs on. It answers for the installed version of Werft, from its documentation and from what this agent is connected to and allowed to do right now. It only reads, and it never returns a secret value such as a token or a key.",
  "Use this server first, before general knowledge and before a command-line tool's own setup steps, when a question is about any of these:\n- what this agent is connected to in Werft: GitHub, Slack, MCP servers, skills, tools;\n- what this agent may or may not do here, or why something was refused;\n- how to set something up or change a setting in Werft.",
  "For example, asked whether it can use GitHub, an agent here does not suggest `gh auth login`. It checks its own status on this server and answers from that, naming the Werft console menu where the setting is changed.",
  "When it is unclear whether a question is about Werft, check this agent's status on this server first: the check only reads and is cheap. Then look in the documentation here for how to do or change it.",
].join("\n\n");
