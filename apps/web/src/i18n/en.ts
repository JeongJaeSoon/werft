import { flowEn, formsEn, sessionsEn } from "@werft-ai/react";
import { achievementRulesEn } from "./achievement-rules.ts";
import { achievementsEn } from "./achievements.ts";
import { agentAccessEn } from "./agent-access.ts";
import { agentGitHubEn } from "./agent-github.ts";
import { agentsEn } from "./agents.ts";
import { apiKeysEn } from "./api-keys.ts";
import { auditLogEn } from "./audit-log.ts";
import { authEn } from "./auth.ts";
import { commonEn } from "./common.ts";
import { errorsEn } from "./errors.ts";
import { executionLimitsEn } from "./execution-limits.ts";
import { githubEn } from "./github.ts";
import { githubUserLinkEn } from "./github-user-link.ts";
import { homeEn } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedEn } from "./linked.ts";
import { loginMethodsEn } from "./login-methods.ts";
import { loginProvidersEn } from "./login-providers.ts";
import { membersEn } from "./members.ts";
import { modelsEn } from "./models.ts";
import { outputsEn } from "./outputs.ts";
import { preferencesEn } from "./preferences.ts";
import { sessionListEn } from "./session-list.ts";
import { settingsEn } from "./settings.ts";
import { shellEn } from "./shell.ts";
import { skillsEn } from "./skills.ts";
import { teamsEn } from "./teams.ts";
import { usageEn } from "./usage.ts";
import { workspaceEn } from "./workspace.ts";
import { workspaceMcpEn } from "./workspace-mcp.ts";

export const slackEn = {
  "slack.error.config":
    "Slack app creation needs workspace configuration. Ask an owner or admin to configure it.",
  "slack.error.refused":
    "Slack refused the request (code: {code}). Give the code to an administrator.",
  "slack.error.noAnswer":
    "Slack did not answer, so the install could not finish. Start the install again from the Slack tab.",
  "slack.error.unknown":
    "The request could not be processed, and trying again may not help (code: {code}). Give the code to an administrator.",
  "slack.error.consoleOrigin":
    "The console's public address (CONSOLE_ORIGIN) is not set, so no Slack app can be created. Ask an administrator to configure it.",
  "slack.error.eventsUrl":
    "No https address is known for Slack to send events to. Ask an administrator to set CONSOLE_ORIGIN, or, when events enter apart from the console, have an owner fill in the events entrance under Settings > Integrations > Slack.",
  "slack.error.creating":
    "App creation is still being checked. Ask an administrator to check Slack for the app, then refresh.",
  "slack.error.notInstalled":
    "Install the Slack app before connecting channels.",
  "slack.error.denied":
    "Slack installation was declined. You can install again from the Slack tab.",
  "slack.error.expired":
    "The installation link expired or was already used. Install again from the Slack tab.",
  "slack.error.gone":
    "Slack no longer has this app. Delete it under Danger zone, then install again to create a new one.",
  "slack.error.rejected":
    "The Slack app or workspace did not match. Start again from the Slack tab.",
  "slack.error.cursor":
    "The channel list changed. Refresh to search again from the beginning.",
  "slack.error.botUnknown":
    "Not an active bot of this Slack workspace: a deleted or deactivated bot, or a person's account.",
  "slack.error.botOwn": "This agent's own bot cannot be chosen.",
  "slack.error.botWerftAgent":
    "This bot belongs to another agent of this Werft. Agents cannot call each other over Slack.",
  "slack.error.botOtherTeam":
    "A bot of another Slack workspace. Bots that come in through Slack Connect cannot be chosen.",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "Connect channels",
  "slack.app": "Slack app",
  "slack.verifyNeeded":
    "The app is installed, but event registration needs verification. Contact your administrator.",
  "slack.joinHintAuto":
    "The bot automatically joins public channels when responses are enabled. Invite the bot to private channels with /invite.",
  "slack.appId": "App ID",
  "slack.state.none": "Not created",
  "slack.state.pending": "Awaiting installation",
  "slack.state.connected": "Connected",
  "slack.state.reinstall": "Reinstall required",
  "slack.channelsLocked.title":
    "Channels can't be picked until Slack checks the Request URL",
  "slack.channelsLocked.bodyRecheck":
    "No invite, mention, DM or channel events arrive until Slack has checked this app's Request URL. Recheck only sends the current URL to Slack again, and Slack may not check an unchanged URL again. If it stays unchecked, press Verify (or Retry) on the app's Event Subscriptions page. This notice goes away on its own once Slack checks.",
  "slack.channelsLocked.body":
    "No invite, mention, DM or channel events arrive until Slack has checked this app's Request URL. Press Verify (or Retry) on the app's Event Subscriptions page. This notice goes away on its own once Slack checks.",
  "slack.channelsLocked.open": "Open Event Subscriptions",
  "slack.eventsUrl.title": "Events Request URL",
  "slack.eventsUrl.hint":
    "Where Slack sends invites, mentions and DMs. Recheck sends the current URL to the app's settings again. When Slack sends its check, it is answered automatically.",
  "slack.eventsUrl.verified": "Checked by Slack",
  "slack.eventsUrl.pending": "Waiting for Slack",
  "slack.eventsUrl.failed": "Registration failed",
  "slack.eventsUrl.unsent": "Not sent yet",
  "slack.eventsUrl.recheck": "Recheck",
  "slack.eventsUrl.done": "Slack has checked the Request URL.",
  "slack.eventsUrl.reinstall":
    "The manifest was sent to Slack again. It adds permissions to the app, which apply once the app is installed again.",
  "slack.eventsUrl.sent":
    "The Request URL was sent to Slack again. Slack may not check an unchanged URL again. If it keeps waiting, press Retry on the app's Event Subscriptions page.",
  "slack.repositoryRequired.title": "Sessions can't start from Slack",
  "slack.repositoryRequired.body":
    "Slack sessions can't start from the active release ({release}). The release's repository left the catalog or is not allowed by the workspace ceiling, or the agent's GitHub settings can't be read. Slack mentions and DMs are refused and only a notice is left in the thread. You can still connect. Check the GitHub settings and save again in Settings, and a new release is made.",
  "slack.issuerChanged.title": "Made by another Slack user",
  "slack.issuerChanged.body":
    "Slack user {previous} made this app, but the App Configuration Token now belongs to {user}. That token may not be able to install or change the app. If installing fails, register {previous}'s token again or add {user} as a collaborator on the app. If the app was already deleted in Slack, delete it under Danger zone and install again.",
  "slack.releaseUnavailable.title": "Sessions can't start from Slack",
  "slack.releaseUnavailable.body":
    "The active release's model connection ({release}) was disabled, or its model left the connection's model list. Slack mentions and DMs are refused and only a notice is left in the thread. In Settings, choose a connection and model you can use and save, and a new release is made.",
  "slack.noActiveRelease.title": "No active release",
  "slack.noActiveRelease.body":
    "Until a release is on, Slack mentions and DMs are refused and only a notice is left in the thread. In Settings, choose a connection and model and save, and the first release is made.",
  "slack.state.error": "Error",
  "slack.createInstall": "Create and install Slack app",
  "slack.configToken.unset":
    "No App Configuration Token is registered for the workspace, so no app can be made.",
  "slack.configToken.needs_reentry":
    "The workspace's stored token can no longer be used, so no app can be made.",
  "slack.configToken.settings": "Register the token in Integrations > Slack",
  "slack.configToken.askAdmin": "Ask an owner or admin to register the token.",
  "slack.install": "Install Slack app",
  "slack.reinstall": "Reinstall",
  "slack.working": "Preparing…",
  "slack.refresh": "Refresh",
  "slack.delete": "Delete app",
  "slack.deleteTitle": "Delete the Slack app",
  "slack.deleteWarning":
    "Deletes the app in Slack along with its stored credentials. This can't be undone; connecting again makes a new app.",
  "slack.deleted": "Slack app deleted.",
  "slack.deletedCleanupFailed":
    "Slack app deleted in Werft, but Slack's side could not be cleaned up. Delete the app in Slack's app management page (api.slack.com/apps).",
  "slack.revoke": "Disconnect",
  "slack.revokeTitle": "Disconnect Slack",
  "slack.revokeWarning":
    "Revoke this agent's Slack identity and channel bindings. Subsequent events will not be received; the Slack app stays and can be installed again.",
  "slack.revoked": "Slack disconnected.",
  "slack.activateFirst": "Turn on the agent before creating its Slack app.",
  "slack.channels": "Channels",
  "slack.sectionNav": "Slack sections",
  "slack.manage": "Manage",
  "slack.saved": "Channel use saved.",
  "slack.homeSaved": "Home channel set.",
  "slack.channelConnected": "Channel connected.",
  "slack.dmSaved": "DM setting saved.",
  "slack.mentionOnlySavedOn": "Responds only when @mentioned.",
  "slack.mentionOnlySavedOff": "Responds without a mention too.",
  "slack.home": "Home channel",
  "slack.setHome": "Set home",
  "slack.homeStep": "Set a home channel",
  "slack.pickHome": "Choose home channel",
  "slack.homeStepHint":
    "First choose the home channel where the agent posts its introduction and notices. The channel you choose is in use right away. For a private channel, invite the bot there with /invite.",
  "slack.channelHome": "Set home: {channel}",
  "slack.channelConnect": "Connect {channel}",
  "slack.connectedChannels": "Connected channels",
  "slack.channelsAudience":
    "Everyone in a connected channel reads the replies, including people outside the responsible team.",
  "slack.noConnectedChannels": "No connected channels",
  "slack.addChannelHint":
    "Choose Add channel to select where this agent responds.",
  "slack.addChannel": "Add channel",
  "slack.cardHint": "The app, address and channels this agent uses in Slack.",
  "slack.tokenHint":
    "The workspace's {token} this agent's Slack app is made with. Register or replace it in Integrations > Slack.",
  "slack.tokenManage": "Manage in Integrations > Slack",
  "slack.addressesHint":
    "The Events Request URL this agent's app uses. The console puts it in the app it makes; Slack must check it before channel messages reach the agent.",
  "slack.appsHint":
    "The Slack app this console made for this agent. Install and reinstall it here; disconnect and delete it in the danger zone.",
  "slack.appsEmpty": "This agent has no Slack app yet.",
  "slack.appName": "{name} app",
  "slack.appMenu": "Slack app menu",
  "slack.basicHint": "How this agent answers direct messages and mentions.",
  "slack.notice": "Notice approval",
  "slack.noticeHint":
    "Before this agent listens to messages in Slack channels, a workspace owner or admin reads and approves the notice below.",
  "slack.notice.state.no_notice": "No notice yet",
  "slack.notice.state.not_installed": "Not installed",
  "slack.notice.state.not_approved": "Not approved",
  "slack.notice.state.reapproval_required": "Approval needed again",
  "slack.notice.state.approved": "Approved",
  "slack.notice.placeholder":
    "No notice has been published yet. Once one is, you can read and approve it here.",
  "slack.notice.notInstalled": "Install the Slack app to approve the notice.",
  "slack.notice.reapprovalHint":
    "The notice changed and needs a new approval. Until then this agent does not listen to channel messages.",
  "slack.notice.languageNote":
    "This notice is available in Japanese and Korean.",
  "slack.notice.language": "Notice language",
  "slack.notice.version": "Notice version {version}",
  "slack.notice.approvals": "Approvals",
  "slack.notice.team": "Slack team {team}",
  "slack.notice.older": "Earlier version",
  "slack.notice.approve": "Approve",
  "slack.notice.reapprove": "Approve again",
  "slack.notice.revoke": "Revoke approval",
  "slack.notice.revokeConsequence":
    "This agent stops listening to Slack channel messages until the notice is approved again.",
  "slack.notice.adminOnly": "Only a workspace owner or admin can approve.",
  "slack.notice.approvedNotice": "Notice approved.",
  "slack.notice.revokedNotice": "Notice approval revoked.",
  "slack.notice.stale":
    "The notice changed in the meantime. Read the new one and approve again.",
  "slack.channelColumn": "Channel",
  "slack.useColumn": "In use",
  "slack.listenColumn": "Listening",
  "slack.listen.free": "All messages",
  "slack.listen.mention": "Mentions only",
  "slack.listen.off": "Not listening",
  "slack.listenOf": "Listening in {channel}",
  "slack.listenHint":
    "Listening applies once the agent's conversation switch is turned on.",
  "slack.listenSaved": "Listening saved.",
  "slack.listenSavedDropped":
    "Listening saved. Messages this channel held for judgment were deleted.",
  "slack.listenRefused": "Not saved",
  "slack.listenFailed": "Could not save listening for {channel}. {reason}",
  "slack.listenExternalShared":
    "{channel} is shared with another organization, so it can listen to mentions only. Choose Mentions only or Not listening.",
  "slack.basic": "Basic",
  "slack.advanced": "Advanced",
  "slack.homeChannel": "Home channel",
  "slack.homeUnset": "Not selected",
  "slack.channelId": "Channel ID: {id}",
  "slack.channelsLoading": "Loading channels",
  "slack.botId": "Bot ID",
  "slack.mentionOnlyHint":
    "On: responds only when @mentioned. Off: responds to posts in the channel without a mention too. Either way, replies in a thread it is already talking in get an answer without a mention.",
  "slack.dm": "Direct messages",
  "slack.dmSetting": "Receive DMs",
  "slack.dmHint":
    "Receive one-to-one conversations in the Slack app's Messages tab. Only members who linked their Slack account can use it.",
  "slack.public": "Public",
  "slack.private": "Private",
  "slack.off": "Off",
  "slack.on": "On",
  "slack.inUseOf": "Use in {channel}",
  "slack.mentionOnly": "Respond only when mentioned",
  "slack.bots": "Bots to answer",
  "slack.botsHint":
    "Answers when a chosen bot @mentions this agent directly. In a thread, it stops after bots trade 5 turns with no person, and counts again once a person writes. Conversations a bot opens use no personal connections.",
  "slack.botsNone": "None",
  "slack.botsCount": "{count}",
  "slack.botsEdit": "Change",
  "slack.botsTitle": "Choose bots to answer",
  "slack.botsDialogHint":
    "Only bots in this Slack workspace can be chosen. Other agents' bots of this Werft cannot.",
  "slack.botsEmpty": "No bots to choose from.",
  "slack.botsSave": "Save",
  "slack.botsSaved": "Bots to answer saved.",
  "slack.botGone": "Gone from Slack",
  "slack.botsTruncated":
    "The workspace is too large to read Slack's whole list. Add a bot missing above by its Slack user ID; it is saved at once.",
  "slack.botAddById": "Add by Slack user ID",
  "slack.botAdd": "Add",
  "slack.botAdded": "Bot added.",
  "slack.botIdInvalid": "Enter a Slack user ID that starts with U or W.",
  "slack.search": "Find channels",
  "slack.privateInvite": "/invite required",
  "slack.pendingApproval": "Awaiting approval",
  "slack.pendingApprovalHint":
    "The bot does not answer in this channel until an owner or admin approves it.",
  "slack.approve": "Approve",
  "slack.approveChannel": "Approve channel: {channel}",
  "slack.approved": "Channel approved.",
  "slack.left": "Left",
  "slack.inactive": "Inactive",
  "slack.gone": "Deleted",
  "slack.goneHint":
    "The channel was deleted in Slack, so the agent neither receives nor sends messages there.",
  "slack.leftHint":
    "The bot left the channel, so it neither receives nor sends messages there. Invite it again and the channel returns to awaiting approval.",
  "slack.add": "Connect",
  "slack.noChannels":
    "No channels found. Invite the bot to private channels with /invite first.",
  "slack.partial":
    "Some channels may be missing or results may be out of date.",
  "slack.more": "Load more",
  "slack.reinstallTitle": "Reinstall the Slack app",
  "slack.reinstallHint":
    "Reinstall when permissions or event settings change. Opens Slack's consent screen.",
  "slack.installHint":
    "Opens Slack's consent screen to install the app in this workspace.",
  "slack.installed": "Installed the app in Slack.",
  "slack.copyInvite": "Copy /invite command",
  "slack.inviteCommand": "/invite command",
  "slack.copied": "Copied",
  "slack.copy": "Copy",
  "slack.inviteTitle": "Invite to a channel",
  "slack.inviteHint":
    "Paste this into a Slack channel's message box and send it to invite the bot to that channel.",
  "slack.openInSlack": "Open in Slack",
  "slack.newTab": "(opens in a new tab)",
  "slack.copyFailed":
    "Couldn't copy to the clipboard. Copy the selected command yourself.",
  "slack.copyInviteFailed":
    "Couldn't copy to the clipboard. Select the command line and copy it yourself.",
} as const;

export const en: Record<MessageKey, string> = {
  ...slackEn,
  ...commonEn,
  ...shellEn,
  ...authEn,
  ...homeEn,
  ...membersEn,
  ...teamsEn,
  ...agentsEn,
  ...modelsEn,
  ...settingsEn,
  ...sessionsEn,
  ...sessionListEn,
  ...flowEn,
  ...linkedEn,
  ...loginMethodsEn,
  ...loginProvidersEn,
  ...executionLimitsEn,
  ...auditLogEn,
  ...outputsEn,
  ...apiKeysEn,
  ...workspaceEn,
  ...workspaceMcpEn,
  ...skillsEn,
  ...githubEn,
  ...githubUserLinkEn,
  ...agentGitHubEn,
  ...agentAccessEn,
  ...usageEn,
  ...achievementsEn,
  ...achievementRulesEn,
  ...preferencesEn,
  ...errorsEn,
  ...formsEn,
};
