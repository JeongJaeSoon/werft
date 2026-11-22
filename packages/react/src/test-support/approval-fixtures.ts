import type { PermissionRequest } from "../components/session/approval-card.tsx";
import type { ApprovalRowMessages } from "../components/session/approval-row.tsx";

export const REQUEST: PermissionRequest = {
  request_id: "req_1",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "permission",
  tool: "Bash",
  input: { command: "echo alpha > hello.txt" },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
};

export const MESSAGES: ApprovalRowMessages = {
  title: (tool) => `${tool} asks`,
  input: "input",
  expires: (at) => `expires ${at}`,
  expired: "expired",
  allow: "Allow",
  deny: "Deny",
  allowName: (tool) => `Allow: ${tool} · 0192f0c4`,
  denyName: (tool) => `Deny: ${tool} · 0192f0c4`,
  denyReason: "Reason",
  denySubmit: "Send denial",
  cancel: "Cancel",
  allowNote: "Allow with instruction",
  allowNoteName: (tool) => `Allow with instruction: ${tool} · 0192f0c4`,
  note: "Instruction",
  noteSubmit: "Send approval",
  noteRequired: "Type an instruction",
  noteTooLong: "Too long",
};
