import { flowEn, formsEn, sessionsEn } from "@werft-ai/react";
import { achievementRulesEn } from "./achievement-rules.ts";
import { achievementsEn } from "./achievements.ts";
import { agentAccessEn } from "./agent-access.ts";
import { agentConversationsEn } from "./agent-conversations.ts";
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
  "slack.reauthorize.needed": "Slack reapproval needed",
  "slack.reauthorize.body":
    "This app now asks for new permissions ({scopes}) that its install has not approved yet. Until it is approved again, only what needs them is off; everything else keeps working. Reapprove sends the app's settings to Slack, then opens Slack's approval screen.",
  "slack.reauthorize.action": "Reapprove",
  "slack.manifestSync.needed": "Update needed",
  "slack.manifestSync.config_token_inactive":
    "The App Configuration Token is not active, so Werft could not check or update this app's Slack settings. It may not receive newly added events. Enter the token again, then press Recheck.",
  "slack.manifestSync.events_url_unset":
    "No events address is known, so this app's Slack settings could not be updated. Check the address in the Slack integration settings, then press Recheck.",
  "slack.manifestSync.slack_refused":
    "Slack refused to update this app's settings. It may not receive newly added events. Press Recheck; otherwise the server tries again when it next starts.",
  "slack.manifestSync.no_answer":
    "Slack did not answer the update of this app's settings. It may not receive newly added events. Press Recheck; otherwise the server tries again when it next starts.",
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
  "slack.rolloutSection": "Conversation switch",
  "slack.rollout": "Quiet listening (shadow)",
  "slack.rolloutHint":
    "When on, this agent collects the messages of channels set to listen to all messages, judges whether to join in, and only records that judgment. It posts nothing to Slack because of it. Turning it off deletes the collected messages and stops new judgments; the judgment records and channel summaries stay.",
  "slack.rollout.adminOnly": "Only a workspace owner or admin can change this.",
  "slack.rollout.savedOn": "Quiet listening turned on.",
  "slack.rollout.savedOff": "Quiet listening turned off.",
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
  "slack.reportColumn": "Reports",
  "slack.report.notify_only": "Notifications only",
  "slack.report.progress": "One progress message",
  "slack.report.per_step": "A new post per step",
  "slack.report.default": "Default (now: {mode})",
  "slack.report.defaultPlain": "Default",
  "slack.reportOf": "Reports in {channel}",
  "slack.reportSaved":
    "Reports saved. Work under way that has no setting of its own uses it at once.",
  "slack.reportFailed": "Could not save reports for {channel}. {reason}",
  "slack.capColumn": "Judgments per hour",
  "slack.capOf": "Judgments per hour in {channel}",
  "slack.capRange": "Enter a whole number from 1 to {max}.",
  "slack.capSaved": "Judgments per hour saved. It applies from the next batch.",
  "slack.capFailed":
    "Judgments per hour for {channel} were not saved. {reason}",
  "slack.judgments": "Judgments",
  "slack.judgments.hint":
    "What this agent decided about joining channel conversations in the last {days} days (shadow: nothing is posted to Slack). Open a link to read the message in Slack. A private channel's records and counts are shown too.",
  "slack.judgments.knobs":
    "If judgments come too often or too rarely, adjust the channel's listening, its judgments per hour, or the agent instructions in the repository (AGENTS.md).",
  "slack.judgments.forbidden":
    "Only workspace owners and admins and this agent's admins see its judgments.",
  "slack.judgments.loading": "Loading judgments",
  "slack.judgments.empty": "No judgments to show",
  "slack.judgments.emptyHint":
    "Turn on quiet listening; judgments appear once messages arrive in channels that listen to all messages.",
  "slack.judgments.byChannel": "Judgments by channel",
  "slack.judgments.count": "Judgments",
  "slack.judgments.speakRate": "Speak rate",
  "slack.judgments.speakOf": "{percent}% ({speak})",
  "slack.judgments.reasons": "Reason codes",
  "slack.judgments.reasonCount": "{reason} {count}",
  "slack.judgments.recent": "Recent judgments",
  "slack.judgments.when": "Judged",
  "slack.judgments.decision": "Decision",
  "slack.judgments.reason": "Reason",
  "slack.judgments.reasonFilter": "Filter by reason",
  "slack.judgments.reasonAll": "All reasons",
  "slack.judgments.recentNone": "No recent judgment matches the chosen filters",
  "slack.judgments.answerFilter": "Filter by outcome",
  "slack.judgments.answerAll": "All outcomes",
  "slack.judgments.answer": "Outcome",
  "slack.judgments.answerNone": "None",
  "slack.judgments.answer.replied": "Decided to reply",
  "slack.judgments.answer.no_reply": "Decided not to reply",
  "slack.judgments.answer.no_decision": "Ended with no decision",
  "slack.judgments.answer.budget_refused": "Budget refused",
  "slack.judgments.answer.source_deleted": "Source message deleted",
  "slack.judgments.answer.channel_stopped": "Channel stopped",
  "slack.judgments.answer.not_started": "Not started",
  "slack.judgments.message": "Slack message",
  "slack.judgments.speak": "Speak",
  "slack.judgments.quiet": "Stay quiet",
  "slack.judgments.open": "View in Slack",
  "slack.judgments.openOf": "View the message in {channel} in Slack",
  "slack.judgments.noRelease":
    "There is no active release, so judgments have no agent instructions.",
  "slack.judgments.noSnapshot":
    "The active release was made before instructions were kept, so judgments use the fixed criteria only. A new release picks up the repository's instructions.",
  "slack.judgments.noRepository":
    "Judgment instructions come from the repository's AGENTS.md. Connect a repository to use them.",
  "slack.judgments.instructions":
    "M1 instructions: release {release}, commit {commit}",
  "slack.judgments.instructionsAbsent":
    "M1 instructions: release {release}, commit {commit} has no instruction file, so judgments use the fixed criteria only.",
  "slack.judgments.instructionsNewer":
    "The repository has newer instructions. A new release picks them up.",
  "slack.judgments.reason.not_for_agent": "Not for the agent",
  "slack.judgments.reason.human_conversation": "People talking",
  "slack.judgments.reason.already_handled": "Already handled",
  "slack.judgments.reason.out_of_scope": "Out of scope",
  "slack.judgments.reason.needs_agent": "Needs the agent",
  "slack.judgments.reason.unclear": "Unclear",
  "slack.judgments.reason.invalid_target": "No message to answer",
  "slack.judgments.reason.budget_refused": "Budget refused",
  "slack.judgments.reason.concurrency_limited": "Concurrency limit",
  "slack.judgments.reason.rate_limited": "Over the hourly cap",
  "slack.judgments.reason.input_too_large": "Input too large",
  "slack.judgments.reason.no_active_release": "No active release",
  "slack.judgments.reason.model_unavailable": "Model unavailable",
  "slack.judgments.reason.timed_out": "Timed out",
  "slack.judgments.reason.unreachable": "Model unreachable",
  "slack.judgments.reason.provider_error": "Provider error",
  "slack.judgments.reason.malformed": "Unreadable answer",
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
  "slack.emergencyStop.action": "Emergency stop",
  "slack.emergencyStop.actionOf": "Emergency stop in {channel}",
  "slack.emergencyStop.badge": "Emergency-stopped",
  "slack.emergencyStop.by": "Stopped by {who} at {at}. Reason: {reason}",
  "slack.emergencyStop.byUnknown": "Stopped at {at}. Reason: {reason}",
  "slack.emergencyStop.title": "Emergency stop in {channel}",
  "slack.emergencyStop.description":
    "Stops what the agent is doing in this channel at once and turns the channel off. Work under way is cut off, and posts not sent yet are cancelled. The channel is told that an admin stopped the agent.",
  "slack.emergencyStop.reason": "Reason",
  "slack.emergencyStop.reasonHint": "Kept in the audit log.",
  "slack.emergencyStop.reasonRequired": "Enter a reason.",
  "slack.emergencyStop.reasonTooLong":
    "Keep the reason to {max} characters or fewer.",
  "slack.emergencyStop.cancel": "Cancel",
  "slack.emergencyStop.submit": "Emergency stop",
  "slack.emergencyStop.submitting": "Stopping",
  "slack.emergencyStop.done":
    "{channel}: stopped {sessions} sessions and {turns} tasks, and cancelled {posts} unsent posts.",
  "slack.emergencyStop.resumeTitle": "Turn {channel} on again",
  "slack.emergencyStop.resumeDescription":
    "Once it is on, the agent answers in this channel again. Stopped sessions do not go on by themselves: someone who can write to a session resumes it.",
  "slack.emergencyStop.resumeSubmit": "Turn on",
  "slack.emergencyStop.resumeSubmitting": "Turning on",
  "slack.emergencyStop.resumed": "{channel} is on again.",
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
  ...agentConversationsEn,
  ...usageEn,
  ...achievementsEn,
  ...achievementRulesEn,
  ...preferencesEn,
  ...errorsEn,
  ...formsEn,
};
