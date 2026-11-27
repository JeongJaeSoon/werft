-- Agents whose conversation switch is raised (shadow or on) although the
-- retired Slack notice approval would have held them closed: some Slack team
-- of a live install has no live approval, or no live install is left. Before
-- deploying the release that retires the approval, run this read-only query;
-- lower each listed agent the operator wants to keep closed with
-- `slack-notice.ts set-rollout --agent <id> --rollout off`.
-- The retiring release counts approvals of notice version 1 only (its
-- published window, oldest counted to current); a row of another version
-- held the agent closed too.
SELECT a.workspace_id, a.id AS agent_id, a.conversation_rollout
FROM agents a
WHERE a.conversation_rollout <> 'off'
  AND a.deleted_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1
      FROM agent_identities ai
      JOIN slack_installations si
        ON si.id = ai.installation_id AND si.workspace_id = ai.workspace_id
      WHERE ai.workspace_id = a.workspace_id
        AND ai.agent_id = a.id
        AND ai.status = 'active'
        AND si.status <> 'revoked'
    )
    OR EXISTS (
      SELECT 1
      FROM agent_identities ai
      JOIN slack_installations si
        ON si.id = ai.installation_id AND si.workspace_id = ai.workspace_id
      WHERE ai.workspace_id = a.workspace_id
        AND ai.agent_id = a.id
        AND ai.status = 'active'
        AND si.status <> 'revoked'
        AND NOT EXISTS (
          SELECT 1
          FROM slack_notice_approvals n
          WHERE n.workspace_id = a.workspace_id
            AND n.agent_id = a.id
            AND n.slack_team_id = si.team_id
            AND n.revoked_at IS NULL
            AND n.notice_version = 1
        )
    )
  )
ORDER BY a.workspace_id, a.id;
