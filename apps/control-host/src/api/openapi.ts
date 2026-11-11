import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import {
  type ApiErrorCode,
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  achievementCategoryChangeResponseSchema,
  achievementCategoryParamsSchema,
  achievementJudgeChangeResponseSchema,
  achievementJudgeRequestSchema,
  achievementJudgeResponseSchema,
  achievementParamsSchema,
  achievementRuleChangeResponseSchema,
  achievementRuleFamilyParamsSchema,
  achievementRuleRequestSchema,
  achievementTypeChangeResponseSchema,
  achievementTypeParamsSchema,
  activateAgentRequestSchema,
  activateAgentResponseSchema,
  activationCredentialUnboundDetailsSchema,
  addAgentAdminRequestSchema,
  addTeamMemberRequestSchema,
  adminTerminateSessionRequestSchema,
  agentAccessRequestSchema,
  agentAccessResponseSchema,
  agentAdminChangeResponseSchema,
  agentAdminParamsSchema,
  agentAdminsViewSchema,
  agentCallerLimitsSchema,
  agentDetailSchema,
  agentEngineSettingsResponseSchema,
  agentEnvVariablesSchema,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  agentIdentityParamsSchema,
  agentIdParamsSchema,
  agentMcpResponseSchema,
  agentPullRequestResponseSchema,
  agentUsageSchema,
  agentVariableParamsSchema,
  apiErrorResponseSchema,
  apiKeyIdParamsSchema,
  apiRootResponseSchema,
  auditReadRequestSchema,
  auditReadResponseSchema,
  auditRetentionRequestSchema,
  auditRetentionResponseSchema,
  authMeResponseSchema,
  BOT_SCOPES,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changeSessionProfileRequestSchema,
  closeSessionRequestSchema,
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  completeGitHubAppManifestRequestSchema,
  completeGitHubAppManifestResponseSchema,
  completeGitHubInstallationRequestSchema,
  completeGitHubInstallationResponseSchema,
  completeSlackInstallRequestSchema,
  completeSlackInstallResponseSchema,
  countAgentsResponseSchema,
  countSessionsQuerySchema,
  countSessionsResponseSchema,
  createAchievementCategoryRequestSchema,
  createAchievementTypeRequestSchema,
  createAgentReleaseRequestSchema,
  createAgentReleaseResponseSchema,
  createAgentRequestSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  createCredentialBindingRequestSchema,
  createCredentialBindingResponseSchema,
  createInstallationProfileRequestSchema,
  createInviteRequestSchema,
  createInviteResponseSchema,
  createPushRequestRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  createSettingsConnectionRequestSchema,
  createSettingsMcpServerRequestSchema,
  createSlackAppRequestSchema,
  createSlackAppResponseSchema,
  createTeamRequestSchema,
  createWorkspaceProfileRequestSchema,
  credentialBindingParamsSchema,
  deleteEnvVariableResponseSchema,
  deleteGitHubAppResponseSchema,
  deleteSlackAppResponseSchema,
  deleteSlackSecretResponseSchema,
  deleteTeamResponseSchema,
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  envVariableListSchema,
  exportSettingsResponseSchema,
  GITHUB_APP_MANIFEST_STATE_TTL_SECONDS,
  GITHUB_INSTALLATION_STATE_TTL_SECONDS,
  getGitHubAppResponseSchema,
  getGitHubRepositoryAppPinsResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getSlackAppManifestResponseSchema,
  getSlackAppResponseSchema,
  getTurnResponseSchema,
  githubAppRoleParamsSchema,
  githubConnectionParamsSchema,
  githubLinkCallbackRequestSchema,
  githubLinkCallbackResponseSchema,
  githubPackagesSettingsResponseSchema,
  githubPackagesWriteResponseSchema,
  githubRepositoryAppPinParamsSchema,
  githubRepositoryPageQuerySchema,
  githubRepositoryParamsSchema,
  githubRepositoryWriteResponseSchema,
  githubSettingsResponseSchema,
  githubWorkflowRunSchema,
  googleLoginCallbackRequestSchema,
  healthResponseSchema,
  importSettingsQuerySchema,
  importSettingsResponseSchema,
  installationLimitsResponseSchema,
  installationProfileIdParamsSchema,
  installationProfileOptionsResponseSchema,
  interruptSessionRequestSchema,
  inviteIdParamsSchema,
  issuePasswordResetRequestSchema,
  issuePasswordResetResponseSchema,
  limitsQuerySchema,
  limitsResponseSchema,
  linkAgentIdentityRequestSchema,
  linkAgentIdentityResponseSchema,
  linkedAccountParamsSchema,
  listAchievementCategoriesResponseSchema,
  listAchievementRulesResponseSchema,
  listAchievementTypesResponseSchema,
  listAdministeredAgentsResponseSchema,
  listAdminSessionsResponseSchema,
  listAgentGitHubRepositoriesResponseSchema,
  listAgentIdentitiesResponseSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  listApiKeysQuerySchema,
  listApiKeysResponseSchema,
  listCredentialBindingsResponseSchema,
  listGitHubAppsResponseSchema,
  listGitHubRepositoriesResponseSchema,
  listInvitesResponseSchema,
  listLinkedAccountsResponseSchema,
  listMembersQuerySchema,
  listMembersResponseSchema,
  listMyTeamsQuerySchema,
  listMyTeamsResponseSchema,
  listPendingRequestsResponseSchema,
  listProfilesResponseSchema,
  listPushRequestsResponseSchema,
  listSessionAchievementsResponseSchema,
  listSessionGitHubRefusalsResponseSchema,
  listSessionOutcomesResponseSchema,
  listSessionOutputsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listSettingsConnectionsResponseSchema,
  listSettingsMcpServersResponseSchema,
  listSlackBindingsResponseSchema,
  listTakeoversResponseSchema,
  listTeamsQuerySchema,
  listTeamsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  listUsableAgentsResponseSchema,
  listWorkspaceSlackAppsResponseSchema,
  loginMethodsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  lookupSlackChannelsQuerySchema,
  lookupSlackChannelsResponseSchema,
  memberLimitsResponseSchema,
  memberParamsSchema,
  memberUserParamsSchema,
  memberViewSchema,
  openPullRequestQuerySchema,
  openPullRequestRequestSchema,
  openPullRequestResponseSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  patchGitHubRepositoryRequestSchema,
  pauseSessionRequestSchema,
  pickAgentGitHubRepositoryRequestSchema,
  pickAgentGitHubRepositoryResponseSchema,
  postGitHubAppRequestSchema,
  postSessionAnswerInputSchema,
  postSessionAnswerResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  pullRequestReviewParamsSchema,
  pushRequestParamsSchema,
  pushRequestSchema,
  pushRequestViewSchema,
  putAgentCallerLimitsRequestSchema,
  putAgentCallerLimitsResponseSchema,
  putAgentGitHubEnabledRequestSchema,
  putAgentGitHubEnabledResponseSchema,
  putAgentGitHubRepositoryAccessRequestSchema,
  putAgentGitHubRepositoryAccessResponseSchema,
  putAgentGitHubSettingsRequestSchema,
  putAgentGitHubSettingsResponseSchema,
  putAgentMcpSettingsRequestSchema,
  putAgentMcpSettingsResponseSchema,
  putAgentPullRequestSettingsRequestSchema,
  putAgentPullRequestSettingsResponseSchema,
  putAgentUsageRequestSchema,
  putAgentUsageResponseSchema,
  putEngineSettingsRequestSchema,
  putEngineSettingsResponseSchema,
  putEnvVariableGrantsRequestSchema,
  putEnvVariableGrantsResponseSchema,
  putEnvVariableRequestSchema,
  putEnvVariableResponseSchema,
  putGitHubAppRequestSchema,
  putGitHubAppResponseSchema,
  putGitHubOAuthClientSecretRequestSchema,
  putGitHubOAuthClientSecretResponseSchema,
  putGitHubPackagesAllowlistRequestSchema,
  putGitHubPackagesTokenRequestSchema,
  putGitHubPullRequestSettingsRequestSchema,
  putGitHubPullRequestSettingsResponseSchema,
  putGitHubRepositoryAppPinRequestSchema,
  putGitHubRepositoryAppPinResponseSchema,
  putGitHubSettingsRequestSchema,
  putGitHubUserLinkAppRequestSchema,
  putGitHubUserLinkAppResponseSchema,
  putSlackBindingRequestSchema,
  putSlackBindingResponseSchema,
  putSlackConfigTokenResponseSchema,
  putSlackSecretRequestSchema,
  putSlackSecretResponseSchema,
  readyResponseSchema,
  receiptAcceptedResponseSchema,
  receiptIdParamsSchema,
  recoveryDecisionRequestSchema,
  rejudgeSessionResponseSchema,
  requestBodyInvalidDetailsSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  resolvePushRequestRequestSchema,
  resolveSlackBindingRequestSchema,
  resolveSlackBindingResponseSchema,
  resumeSessionRequestSchema,
  retryProfileRolloutRequestSchema,
  retryProfileRolloutResponseSchema,
  reviewAchievementRequestSchema,
  reviewAchievementResponseSchema,
  revokeAgentIdentityResponseSchema,
  revokeApiKeyResponseSchema,
  revokeCredentialBindingResponseSchema,
  type SessionScope,
  SLACK_INSTALL_STATE_TTL_SECONDS,
  saveAgentResponseSchema,
  scheduledPullRequestResponseSchema,
  searchSlackChannelsQuerySchema,
  searchSlackChannelsResponseSchema,
  sessionCredentialUnboundDetailsSchema,
  sessionDurabilitySchema,
  sessionGitHubAttributionSchema,
  sessionIdParamsSchema,
  sessionOutputParamsSchema,
  sessionRepositorySchema,
  sessionShareSchema,
  sessionSummarySchema,
  sessionUsageResponseSchema,
  setAccessRequestSchema,
  setAccessResponseSchema,
  setAgentManagingTeamRequestSchema,
  setAgentManagingTeamResponseSchema,
  setConnectionAutoModeRequestSchema,
  setSessionShareRequestSchema,
  setSessionShareResponseSchema,
  setSettingsCredentialRequestSchema,
  setSettingsMcpServerRequestSchema,
  setTeamMemberRoleRequestSchema,
  settingsChangeResponseSchema,
  settingsConnectionImpactResponseSchema,
  settingsDocumentSchema,
  settingsIdParamsSchema,
  slackAppParamsSchema,
  slackAppSecretParamsSchema,
  slackAppSettingsSchema,
  slackConfigTokenSummarySchema,
  slackEventEnvelopeSchema,
  slackEventsParamsSchema,
  slackEventsResponseSchema,
  slackGuestRequestSchema,
  slackGuestResponseSchema,
  slackInteractionFormSchema,
  slackInteractionResponseSchema,
  slackInteractionsParamsSchema,
  slackLinkCallbackRequestSchema,
  slackLinkCallbackResponseSchema,
  slackSecretSummarySchema,
  sseEventSchema,
  startGitHubAppManifestRequestSchema,
  startGitHubAppManifestResponseSchema,
  startGitHubInstallationResponseSchema,
  startGitHubLinkResponseSchema,
  startGoogleLoginResponseSchema,
  startSlackInstallResponseSchema,
  startSlackLinkResponseSchema,
  submitPullRequestReviewRequestSchema,
  submitPullRequestReviewResponseSchema,
  takeOverSessionRequestSchema,
  teamChangeResponseSchema,
  teamDetailSchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  turnSummarySchema,
  updateAchievementCategoryRequestSchema,
  updateAchievementTypeRequestSchema,
  updateAgentRequestSchema,
  updateAuthMeRequestSchema,
  updateMemberRequestSchema,
  updateSessionRequestSchema,
  updateTeamRequestSchema,
  usageAchievementsQuerySchema,
  usageAchievementsResponseSchema,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageOutcomesQuerySchema,
  usageOutcomesResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  usageToolCallsParamsSchema,
  usageToolCallsQuerySchema,
  usageToolCallsResponseSchema,
  usageToolsQuerySchema,
  usageToolsResponseSchema,
  WEB_SESSION_COOKIE_NAME,
  workflowRunParamsSchema,
  workspaceEngineSettingsResponseSchema,
  workspaceParamsSchema,
  workspaceProfileChangeResponseSchema,
  workspaceProfileIdParamsSchema,
  workspaceVariableParamsSchema,
} from "@werft-ai/contracts";
import { z } from "zod";
import {
  API_INFO_DESCRIPTION,
  accessNote,
  type ErrorContext,
  errorResponseDescription,
  IDEMPOTENCY_KEY_DESCRIPTION,
  LAST_EVENT_ID_DESCRIPTION,
  RESPONSE_HEADERS,
  SECURITY_SCHEME_DESCRIPTIONS,
} from "./openapi-docs.ts";

const OPENAPI_VERSION = "0.1.0-alpha";

const openApiDocumentResponseSchema = z.looseObject({
  openapi: z.literal("3.1.0"),
});

// Request schemas are rendered as input (defaults optional); responses as output.
const requestComponents = {
  CreateSessionRequest: createSessionRequestSchema,
  ListSessionsQuery: listSessionsQuerySchema,
  ListAgentsQuery: listAgentsQuerySchema,
  ListApiKeysQuery: listApiKeysQuerySchema,
  ListTeamsQuery: listTeamsQuerySchema,
  ListMyTeamsQuery: listMyTeamsQuerySchema,
  ListMembersQuery: listMembersQuerySchema,
  CountSessionsQuery: countSessionsQuerySchema,
  LimitsQuery: limitsQuerySchema,
  UsageSummaryQuery: usageSummaryQuerySchema,
  UsageOutcomesQuery: usageOutcomesQuerySchema,
  UsageAchievementsQuery: usageAchievementsQuerySchema,
  UsageSeriesQuery: usageSeriesQuerySchema,
  UsageBreakdownQuery: usageBreakdownQuerySchema,
  UsageToolsQuery: usageToolsQuerySchema,
  UsageToolCallsQuery: usageToolCallsQuerySchema,
  PostSessionMessageRequest: postSessionMessageRequestSchema,
  ListTurnsQuery: listTurnsQuerySchema,
  SearchSlackChannelsQuery: searchSlackChannelsQuerySchema,
  LookupSlackChannelsQuery: lookupSlackChannelsQuerySchema,
  PostSessionAnswerRequest: postSessionAnswerInputSchema,
  PostSessionAnswerResponse: postSessionAnswerResponseSchema,
  InterruptSessionRequest: interruptSessionRequestSchema,
  PauseSessionRequest: pauseSessionRequestSchema,
  TerminateSessionRequest: terminateSessionRequestSchema,
  CloseSessionRequest: closeSessionRequestSchema,
  ResumeSessionRequest: resumeSessionRequestSchema,
  ChangeSessionProfileRequest: changeSessionProfileRequestSchema,
  RecoveryDecisionRequest: recoveryDecisionRequestSchema,
  CreatePushRequestRequest: createPushRequestRequestSchema,
  ResolvePushRequestRequest: resolvePushRequestRequestSchema,
  OpenPullRequestRequest: openPullRequestRequestSchema,
  OpenPullRequestQuery: openPullRequestQuerySchema,
  CommentPullRequestRequest: commentPullRequestRequestSchema,
  DispatchWorkflowRequest: dispatchWorkflowRequestSchema,
  RerunWorkflowRequest: rerunWorkflowRequestSchema,
  SubmitPullRequestReviewRequest: submitPullRequestReviewRequestSchema,
  PutGitHubSettingsRequest: putGitHubSettingsRequestSchema,
  PutAgentPullRequestSettingsRequest: putAgentPullRequestSettingsRequestSchema,
  PutGitHubPullRequestSettingsRequest:
    putGitHubPullRequestSettingsRequestSchema,
  PutGitHubOAuthClientSecretRequest: putGitHubOAuthClientSecretRequestSchema,
  PutGitHubPackagesTokenRequest: putGitHubPackagesTokenRequestSchema,
  PutGitHubPackagesAllowlistRequest: putGitHubPackagesAllowlistRequestSchema,
  GitHubLinkCallbackRequest: githubLinkCallbackRequestSchema,
  PutAgentGitHubEnabledRequest: putAgentGitHubEnabledRequestSchema,
  PutAgentGitHubSettingsRequest: putAgentGitHubSettingsRequestSchema,
  PutAgentGitHubRepositoryAccessRequest:
    putAgentGitHubRepositoryAccessRequestSchema,
  PutAgentMcpSettingsRequest: putAgentMcpSettingsRequestSchema,
  PutEngineSettingsRequest: putEngineSettingsRequestSchema,
  BootstrapRequest: bootstrapRequestSchema,
  LoginRequest: loginRequestSchema,
  PasswordResetRequest: passwordResetRequestSchema,
  SlackLinkCallbackRequest: slackLinkCallbackRequestSchema,
  CreateInviteRequest: createInviteRequestSchema,
  AcceptInviteRequest: acceptInviteRequestSchema,
  UpdateMemberRequest: updateMemberRequestSchema,
  UpdateSessionRequest: updateSessionRequestSchema,
  SetAccessRequest: setAccessRequestSchema,
  GoogleLoginCallbackRequest: googleLoginCallbackRequestSchema,
  AuditRetentionRequest: auditRetentionRequestSchema,
  SlackGuestRequest: slackGuestRequestSchema,
  AgentAccessRequest: agentAccessRequestSchema,
  CreateAchievementCategoryRequest: createAchievementCategoryRequestSchema,
  UpdateAchievementCategoryRequest: updateAchievementCategoryRequestSchema,
  CreateAchievementTypeRequest: createAchievementTypeRequestSchema,
  UpdateAchievementTypeRequest: updateAchievementTypeRequestSchema,
  AchievementRuleRequest: achievementRuleRequestSchema,
  AchievementJudgeRequest: achievementJudgeRequestSchema,
  ReviewAchievementRequest: reviewAchievementRequestSchema,
  PutSlackSecretRequest: putSlackSecretRequestSchema,
  PutGitHubAppRequest: putGitHubAppRequestSchema,
  PostGitHubAppRequest: postGitHubAppRequestSchema,
  PutGitHubUserLinkAppRequest: putGitHubUserLinkAppRequestSchema,
  PutGitHubRepositoryAppPinRequest: putGitHubRepositoryAppPinRequestSchema,
  StartGitHubAppManifestRequest: startGitHubAppManifestRequestSchema,
  CompleteGitHubAppManifestRequest: completeGitHubAppManifestRequestSchema,
  CompleteGitHubInstallationRequest: completeGitHubInstallationRequestSchema,
  GitHubRepositoryPageQuery: githubRepositoryPageQuerySchema,
  PatchGitHubRepositoryRequest: patchGitHubRepositoryRequestSchema,
  PickAgentGitHubRepositoryRequest: pickAgentGitHubRepositoryRequestSchema,
  CreateSlackAppRequest: createSlackAppRequestSchema,
  CompleteSlackInstallRequest: completeSlackInstallRequestSchema,
  SlackEventEnvelope: slackEventEnvelopeSchema,
  SlackInteractionForm: slackInteractionFormSchema,
  CreateAgentRequest: createAgentRequestSchema,
  UpdateAgentRequest: updateAgentRequestSchema,
  CreateAgentReleaseRequest: createAgentReleaseRequestSchema,
  ActivateAgentRequest: activateAgentRequestSchema,
  CreateApiKeyRequest: createApiKeyRequestSchema,
  CreateTeamRequest: createTeamRequestSchema,
  CreateWorkspaceProfileRequest: createWorkspaceProfileRequestSchema,
  CreateInstallationProfileRequest: createInstallationProfileRequestSchema,
  RetryProfileRolloutRequest: retryProfileRolloutRequestSchema,
  SetSessionShareRequest: setSessionShareRequestSchema,
  AuditReadRequest: auditReadRequestSchema,
  AdminTerminateSessionRequest: adminTerminateSessionRequestSchema,
  TakeOverSessionRequest: takeOverSessionRequestSchema,
  UpdateTeamRequest: updateTeamRequestSchema,
  AddTeamMemberRequest: addTeamMemberRequestSchema,
  SetTeamMemberRoleRequest: setTeamMemberRoleRequestSchema,
  AddAgentAdminRequest: addAgentAdminRequestSchema,
  SetAgentManagingTeamRequest: setAgentManagingTeamRequestSchema,
  PutAgentUsageRequest: putAgentUsageRequestSchema,
  PutAgentCallerLimitsRequest: putAgentCallerLimitsRequestSchema,
  LinkAgentIdentityRequest: linkAgentIdentityRequestSchema,
  PutSlackBindingRequest: putSlackBindingRequestSchema,
  ResolveSlackBindingRequest: resolveSlackBindingRequestSchema,
} satisfies Record<string, z.ZodType>;
const responseComponents = {
  ApiErrorResponse: apiErrorResponseSchema,
  ApiRootResponse: apiRootResponseSchema,
  HealthResponse: healthResponseSchema,
  ReadyResponse: readyResponseSchema,
  CreateSessionResponse: createSessionResponseSchema,
  ListSessionsResponse: listSessionsResponseSchema,
  CountSessionsResponse: countSessionsResponseSchema,
  SessionSummary: sessionSummarySchema,
  SessionRepository: sessionRepositorySchema,
  SessionDetail: getSessionResponseSchema,
  SessionDurability: sessionDurabilitySchema,
  PostSessionMessageResponse: postSessionMessageResponseSchema,
  ListTurnsResponse: listTurnsResponseSchema,
  TurnSummary: turnSummarySchema,
  TurnDetail: getTurnResponseSchema,
  SseEvent: sseEventSchema,
  ListPendingRequestsResponse: listPendingRequestsResponseSchema,
  ListTakeoversResponse: listTakeoversResponseSchema,
  SessionShare: sessionShareSchema,
  SetSessionShareResponse: setSessionShareResponseSchema,
  AuditReadResponse: auditReadResponseSchema,
  ListAdminSessionsResponse: listAdminSessionsResponseSchema,
  StartSlackLinkResponse: startSlackLinkResponseSchema,
  SlackLinkCallbackResponse: slackLinkCallbackResponseSchema,
  ListLinkedAccountsResponse: listLinkedAccountsResponseSchema,
  CreateInviteResponse: createInviteResponseSchema,
  ListInvitesResponse: listInvitesResponseSchema,
  AcceptInviteResponse: acceptInviteResponseSchema,
  ListMembersResponse: listMembersResponseSchema,
  MemberView: memberViewSchema,
  SetAccessResponse: setAccessResponseSchema,
  PushRequest: pushRequestSchema,
  PushRequestView: pushRequestViewSchema,
  ListPushRequestsResponse: listPushRequestsResponseSchema,
  OpenPullRequestResponse: openPullRequestResponseSchema,
  ScheduledPullRequestResponse: scheduledPullRequestResponseSchema,
  CommentPullRequestResponse: commentPullRequestResponseSchema,
  DispatchWorkflowResponse: dispatchWorkflowResponseSchema,
  GitHubWorkflowRun: githubWorkflowRunSchema,
  RerunWorkflowResponse: rerunWorkflowResponseSchema,
  SubmitPullRequestReviewResponse: submitPullRequestReviewResponseSchema,
  GitHubSettingsResponse: githubSettingsResponseSchema,
  PutGitHubOAuthClientSecretResponse: putGitHubOAuthClientSecretResponseSchema,
  GitHubPackagesSettingsResponse: githubPackagesSettingsResponseSchema,
  GitHubPackagesWriteResponse: githubPackagesWriteResponseSchema,
  StartGitHubLinkResponse: startGitHubLinkResponseSchema,
  GitHubLinkCallbackResponse: githubLinkCallbackResponseSchema,
  SessionGitHubAttribution: sessionGitHubAttributionSchema,
  ListSessionGitHubRefusalsResponse: listSessionGitHubRefusalsResponseSchema,
  ListSessionOutcomesResponse: listSessionOutcomesResponseSchema,
  ListSessionAchievementsResponse: listSessionAchievementsResponseSchema,
  RejudgeSessionResponse: rejudgeSessionResponseSchema,
  ReviewAchievementResponse: reviewAchievementResponseSchema,
  AgentGitHubResponse: agentGitHubResponseSchema,
  PutAgentGitHubEnabledResponse: putAgentGitHubEnabledResponseSchema,
  PutAgentGitHubSettingsResponse: putAgentGitHubSettingsResponseSchema,
  PutAgentGitHubRepositoryAccessResponse:
    putAgentGitHubRepositoryAccessResponseSchema,
  AgentMcpResponse: agentMcpResponseSchema,
  PutAgentMcpSettingsResponse: putAgentMcpSettingsResponseSchema,
  WorkspaceEngineSettingsResponse: workspaceEngineSettingsResponseSchema,
  AgentEngineSettingsResponse: agentEngineSettingsResponseSchema,
  PutEngineSettingsResponse: putEngineSettingsResponseSchema,
  AgentGitHubActivityResponse: agentGitHubActivityResponseSchema,
  ReceiptAcceptedResponse: receiptAcceptedResponseSchema,
  TerminateSessionResponse: terminateSessionResponseSchema,
  Receipt: getReceiptResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  LoginResponse: loginResponseSchema,
  LoginMethodsResponse: loginMethodsResponseSchema,
  StartGoogleLoginResponse: startGoogleLoginResponseSchema,
  IssuePasswordResetRequest: issuePasswordResetRequestSchema,
  IssuePasswordResetResponse: issuePasswordResetResponseSchema,
  AuditRetentionResponse: auditRetentionResponseSchema,
  SlackGuestResponse: slackGuestResponseSchema,
  AgentAccessResponse: agentAccessResponseSchema,
  SlackSecretSummary: slackSecretSummarySchema,
  PutSlackSecretResponse: putSlackSecretResponseSchema,
  DeleteSlackSecretResponse: deleteSlackSecretResponseSchema,
  SlackConfigTokenSummary: slackConfigTokenSummarySchema,
  PutSlackConfigTokenResponse: putSlackConfigTokenResponseSchema,
  GetGitHubAppResponse: getGitHubAppResponseSchema,
  StartGitHubAppManifestResponse: startGitHubAppManifestResponseSchema,
  CompleteGitHubAppManifestResponse: completeGitHubAppManifestResponseSchema,
  StartGitHubInstallationResponse: startGitHubInstallationResponseSchema,
  CompleteGitHubInstallationResponse: completeGitHubInstallationResponseSchema,
  PutGitHubAppResponse: putGitHubAppResponseSchema,
  DeleteGitHubAppResponse: deleteGitHubAppResponseSchema,
  ListGitHubAppsResponse: listGitHubAppsResponseSchema,
  PutGitHubUserLinkAppResponse: putGitHubUserLinkAppResponseSchema,
  AgentPullRequestResponse: agentPullRequestResponseSchema,
  PutAgentPullRequestSettingsResponse:
    putAgentPullRequestSettingsResponseSchema,
  PutGitHubPullRequestSettingsResponse:
    putGitHubPullRequestSettingsResponseSchema,
  GetGitHubRepositoryAppPinsResponse: getGitHubRepositoryAppPinsResponseSchema,
  PutGitHubRepositoryAppPinResponse: putGitHubRepositoryAppPinResponseSchema,
  ListGitHubRepositoriesResponse: listGitHubRepositoriesResponseSchema,
  GitHubRepositoryWriteResponse: githubRepositoryWriteResponseSchema,
  ListAgentGitHubRepositoriesResponse:
    listAgentGitHubRepositoriesResponseSchema,
  PickAgentGitHubRepositoryResponse: pickAgentGitHubRepositoryResponseSchema,
  GetSlackAppResponse: getSlackAppResponseSchema,
  GetSlackAppManifestResponse: getSlackAppManifestResponseSchema,
  SlackAppSettings: slackAppSettingsSchema,
  CreateSlackAppResponse: createSlackAppResponseSchema,
  DeleteSlackAppResponse: deleteSlackAppResponseSchema,
  ListWorkspaceSlackAppsResponse: listWorkspaceSlackAppsResponseSchema,
  StartSlackInstallResponse: startSlackInstallResponseSchema,
  CompleteSlackInstallResponse: completeSlackInstallResponseSchema,
  SlackEventsResponse: slackEventsResponseSchema,
  SlackInteractionResponse: slackInteractionResponseSchema,
  PasswordResetResponse: passwordResetResponseSchema,
  AuthMeResponse: authMeResponseSchema,
  UpdateAuthMeRequest: updateAuthMeRequestSchema,
  InstallationLimitsResponse: installationLimitsResponseSchema,
  MemberLimitsResponse: memberLimitsResponseSchema,
  LimitsResponse: limitsResponseSchema,
  UsageSummaryResponse: usageSummaryResponseSchema,
  UsageOutcomesResponse: usageOutcomesResponseSchema,
  UsageAchievementsResponse: usageAchievementsResponseSchema,
  UsageSeriesResponse: usageSeriesResponseSchema,
  UsageBreakdownResponse: usageBreakdownResponseSchema,
  UsageToolsResponse: usageToolsResponseSchema,
  UsageToolCallsResponse: usageToolCallsResponseSchema,
  SessionUsageResponse: sessionUsageResponseSchema,
  ListSessionOutputsResponse: listSessionOutputsResponseSchema,
  ListAgentsResponse: listAgentsResponseSchema,
  CountAgentsResponse: countAgentsResponseSchema,
  ListProfilesResponse: listProfilesResponseSchema,
  WorkspaceProfileChangeResponse: workspaceProfileChangeResponseSchema,
  RetryProfileRolloutResponse: retryProfileRolloutResponseSchema,
  ListAchievementCategoriesResponse: listAchievementCategoriesResponseSchema,
  AchievementCategoryChangeResponse: achievementCategoryChangeResponseSchema,
  ListAchievementTypesResponse: listAchievementTypesResponseSchema,
  AchievementTypeChangeResponse: achievementTypeChangeResponseSchema,
  ListAchievementRulesResponse: listAchievementRulesResponseSchema,
  AchievementRuleChangeResponse: achievementRuleChangeResponseSchema,
  AchievementJudgeResponse: achievementJudgeResponseSchema,
  AchievementJudgeChangeResponse: achievementJudgeChangeResponseSchema,
  InstallationProfileOptionsResponse: installationProfileOptionsResponseSchema,
  SettingsDocument: settingsDocumentSchema,
  ExportSettingsResponse: exportSettingsResponseSchema,
  ImportSettingsQuery: importSettingsQuerySchema,
  ImportSettingsResponse: importSettingsResponseSchema,
  ListSettingsConnectionsResponse: listSettingsConnectionsResponseSchema,
  ListSettingsMcpServersResponse: listSettingsMcpServersResponseSchema,
  CreateSettingsConnectionRequest: createSettingsConnectionRequestSchema,
  CreateSettingsMcpServerRequest: createSettingsMcpServerRequestSchema,
  SetConnectionAutoModeRequest: setConnectionAutoModeRequestSchema,
  SetSettingsCredentialRequest: setSettingsCredentialRequestSchema,
  SetSettingsMcpServerRequest: setSettingsMcpServerRequestSchema,
  SettingsChangeResponse: settingsChangeResponseSchema,
  SettingsConnectionImpactResponse: settingsConnectionImpactResponseSchema,
  AgentDetail: agentDetailSchema,
  SaveAgentResponse: saveAgentResponseSchema,
  CreateAgentReleaseResponse: createAgentReleaseResponseSchema,
  ActivateAgentResponse: activateAgentResponseSchema,
  SessionCredentialUnboundDetails: sessionCredentialUnboundDetailsSchema,
  RequestBodyInvalidDetails: requestBodyInvalidDetailsSchema,
  ActivationCredentialUnboundDetails: activationCredentialUnboundDetailsSchema,
  CreateApiKeyResponse: createApiKeyResponseSchema,
  ListApiKeysResponse: listApiKeysResponseSchema,
  RevokeApiKeyResponse: revokeApiKeyResponseSchema,
  ListTeamsResponse: listTeamsResponseSchema,
  TeamDetail: teamDetailSchema,
  TeamChangeResponse: teamChangeResponseSchema,
  DeleteTeamResponse: deleteTeamResponseSchema,
  AgentUsage: agentUsageSchema,
  PutAgentUsageResponse: putAgentUsageResponseSchema,
  AgentCallerLimits: agentCallerLimitsSchema,
  PutAgentCallerLimitsResponse: putAgentCallerLimitsResponseSchema,
  AgentAdmins: agentAdminsViewSchema,
  AgentAdminChangeResponse: agentAdminChangeResponseSchema,
  SetAgentManagingTeamResponse: setAgentManagingTeamResponseSchema,
  ListAdministeredAgentsResponse: listAdministeredAgentsResponseSchema,
  ListUsableAgentsResponse: listUsableAgentsResponseSchema,
  ListMyTeamsResponse: listMyTeamsResponseSchema,
  CreateCredentialBindingRequest: createCredentialBindingRequestSchema,
  CreateCredentialBindingResponse: createCredentialBindingResponseSchema,
  ListCredentialBindingsResponse: listCredentialBindingsResponseSchema,
  RevokeCredentialBindingResponse: revokeCredentialBindingResponseSchema,
  EnvVariableList: envVariableListSchema,
  PutEnvVariableRequest: putEnvVariableRequestSchema,
  PutEnvVariableResponse: putEnvVariableResponseSchema,
  PutEnvVariableGrantsRequest: putEnvVariableGrantsRequestSchema,
  PutEnvVariableGrantsResponse: putEnvVariableGrantsResponseSchema,
  DeleteEnvVariableResponse: deleteEnvVariableResponseSchema,
  AgentEnvVariables: agentEnvVariablesSchema,
  LinkAgentIdentityResponse: linkAgentIdentityResponseSchema,
  ListAgentIdentitiesResponse: listAgentIdentitiesResponseSchema,
  RevokeAgentIdentityResponse: revokeAgentIdentityResponseSchema,
  ListSlackBindingsResponse: listSlackBindingsResponseSchema,
  PutSlackBindingResponse: putSlackBindingResponseSchema,
  ResolveSlackBindingResponse: resolveSlackBindingResponseSchema,
  SearchSlackChannelsResponse: searchSlackChannelsResponseSchema,
  LookupSlackChannelsResponse: lookupSlackChannelsResponseSchema,
  OpenApiDocument: openApiDocumentResponseSchema,
} satisfies Record<string, z.ZodType>;

export const OPENAPI_TAGS = [
  {
    name: "Health",
    description: "Check process health, readiness and API metadata.",
  },
  {
    name: "Auth",
    description:
      "Discover the API, sign in (including by redeeming an invite) and manage authenticated browser sessions.",
  },
  {
    name: "Sessions",
    description: "Create sessions and inspect their state and usage.",
  },
  {
    name: "Messages & turns",
    description: "Send session input and inspect turn history and results.",
  },
  {
    name: "Events",
    description: "Stream durable session events.",
  },
  {
    name: "Pending requests",
    description: "List and answer pending permission and question requests.",
  },
  {
    name: "Push requests",
    description:
      "Ask for a session's result to be pushed to its `agent/<session-id>` branch, and approve or reject that push.",
  },
  {
    name: "GitHub work",
    description:
      "Start, read and rerun GitHub Actions runs in a session's repository, as the agent's release and the workspace ceiling allow.",
  },
  {
    name: "Session control",
    description:
      "Stop, pause, resume, close or interrupt a session's execution.",
  },
  {
    name: "Recovery",
    description:
      "Resolve sessions that require an operator recovery decision. The requester's own decision also takes an API key with `sessions:recover`.",
  },
  {
    name: "Admin",
    description:
      "See and stop every session of the workspace, read a session outside its share with an audited reason, decide recovery for any session, and take over the sessions of members who were offboarded. Owners and admins, signed in; only an owner decides recovery. Every operation here refuses an API key except the recovery decision, which also takes a key holding `sessions:recover`, but only for sessions the key can already see.",
  },
  {
    name: "Members",
    description:
      "Invite people, change member roles and issue password reset links. Owners and admins, from a browser session; only an owner grants or changes the owner role or issues a password reset link.",
  },
  {
    name: "Teams",
    description:
      "Group people into teams; a team named an agent's admin makes every member of it one. Owners and admins change teams, from a browser session. A person added joins at once, without accepting.",
  },
  {
    name: "Workspace settings",
    description: "Change workspace-wide settings. Owners only.",
  },
  {
    name: "Agents",
    description:
      "Write agent cards, release a version against a runtime profile, activate a release and bind the credential names it runs with. Owners, admins, and each agent's own admins.",
  },
  {
    name: "Variables",
    description:
      "Environment variables the workspace or one agent holds and a session's engine and tools read. Owners and admins manage the workspace's own and choose which agents receive them; an agent's admins manage that agent's. Signed-in people only.",
  },
  {
    name: "Linked accounts",
    description:
      "Link and unlink the caller's own Slack account through Sign in with Slack.",
  },
  {
    name: "API keys",
    description:
      "Issue and revoke keys, never above what the issuer holds. Signed-in people only.",
  },
  {
    name: "Limits & receipts",
    description:
      "Inspect installation limits and asynchronous command receipts.",
  },
] as const;

type ComponentName =
  | keyof typeof requestComponents
  | keyof typeof responseComponents;

type ApiTagName = (typeof OPENAPI_TAGS)[number]["name"];

// Scalar renders these as the sections of the reference sidebar.
export const OPENAPI_TAG_GROUPS = [
  { name: "Getting started", tags: ["Auth", "API keys"] },
  { name: "Agents", tags: ["Agents"] },
  {
    name: "Sessions",
    tags: [
      "Sessions",
      "Messages & turns",
      "Events",
      "Pending requests",
      "Session control",
      "Push requests",
      "GitHub work",
    ],
  },
  {
    name: "Workspace management",
    tags: [
      "Members",
      "Teams",
      "Linked accounts",
      "Workspace settings",
      "Variables",
    ],
  },
  { name: "Administration", tags: ["Admin", "Recovery"] },
  { name: "Operations", tags: ["Health", "Limits & receipts"] },
] as const satisfies readonly { name: string; tags: readonly ApiTagName[] }[];

export type RouteDeclaration = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  tag: ApiTagName;
  summary: string;
  description?: string;
  scope?: "read" | "write" | "approve" | "control" | "recover";
  // Who may call: `scope` routes take an API key or a cookie session,
  // `auth: "session"` routes only a cookie session, `auth: "public"` routes
  // sit outside the auth middleware (03 §3.2 allowlist). Default: scope
  // present → both credentials; absent → public probe.
  auth?: "public" | "session";
  // A public route that sets the session cookie needs the CSRF header from
  // every caller (login CSRF), not only from cookie principals.
  csrf?: "always";
  query?: ComponentName;
  body?: ComponentName;
  form?: true;
  // Parsed with the body schema by openapi.test.ts.
  requestExample?: unknown;
  success:
    | {
        status: 200 | 201 | 202;
        schema: ComponentName;
        sse?: boolean;
        description?: string;
        // Parsed with `schema` by openapi.test.ts.
        example?: unknown;
      }
    // A file download: the body is the file's bytes, not JSON.
    | { status: 200; download: true; description: string }
    | { status: 204; description?: string };
  // A second success status the route can answer, with its own body.
  alsoSucceeds?: {
    status: 202;
    schema: ComponentName;
    description: string;
    example?: unknown;
  };
  errors: number[];
  errorCodes?: Partial<Record<number, readonly ApiErrorCode[]>>;
  // Appended to ERROR_CODE_WHEN's sentence where a code is narrower here.
  errorNotes?: Partial<Record<ApiErrorCode, string>>;
  lastEventId?: boolean;
  // Optimistic concurrency: `If-Match` names the version the caller read, the
  // resource's `version`, `grant_version` or `revision`; `ifNoneMatch` also
  // takes `*` to create.
  ifMatch?: "version" | "grant_version" | "revision";
  ifNoneMatch?: true;
  // The service checks `scope` itself, so it can record the refusal; the
  // /v1 scope table leaves the route alone. The document still shows it.
  scopeCheckedBy?: "service";
  // Most POSTs are commands and take Idempotency-Key; auth endpoints do not.
  idempotent?: false;
};

const CONFLICTS = [400, 401, 404, 409];

const COMMON_ERROR_CODES: Partial<Record<number, readonly ApiErrorCode[]>> = {
  400: ["BAD_REQUEST"],
  401: ["UNAUTHORIZED"],
  403: ["FORBIDDEN"],
  404: ["NOT_FOUND"],
  408: ["REQUEST_TIMEOUT"],
  410: ["CURSOR_EXPIRED"],
  413: ["PAYLOAD_TOO_LARGE"],
  422: ["UNSUPPORTED_CAPABILITY"],
  429: ["RATE_LIMITED"],
  500: ["INTERNAL_ERROR"],
  503: ["BACKEND_UNAVAILABLE"],
};

// Example values shared across declarations, so the examples read as one
// session's story.
const EXAMPLE_SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const EXAMPLE_RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";

const EXAMPLE_GITHUB_INSTALLATION_SUMMARY = {
  id: 4242,
  account: "acme",
  connection_id: "019a0000-0000-7000-8000-0000000000b1",
  role: "author",
  permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  repository_count: 1,
};

const EXAMPLE_PULL_REQUEST_SETTINGS = {
  formatting: "on",
  default_template: null,
  template_mode: "repository_first",
  session_link: "url",
} as const;

const EXAMPLE_GITHUB_CONNECTION = {
  connection_id: "019a0000-0000-7000-8000-0000000000b1",
  role: "author",
  name: "werft-agent",
  app_id: 123456,
  html_url: "https://github.com/apps/werft-agent",
  owner: { login: "acme", type: "organization" },
  permissions: {
    contents: "write",
    pull_requests: "write",
    actions: "write",
    metadata: "read",
  },
  key_status: "ok",
  installations: [
    {
      id: 4242,
      account: "acme",
      account_type: "organization",
      status: "approval_pending",
      detail: {
        connection_id: "019a0000-0000-7000-8000-0000000000b1",
        role: "author",
        account_id: 9919,
        permissions: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
        },
        approval: "pending",
        repository_count: 37,
        repository_selection: "selected",
        html_url:
          "https://github.com/organizations/acme/settings/installations/4242",
        created_at: "2026-10-01T09:00:00.000Z",
        suspended_at: null,
      },
    },
  ],
  installations_read_at: "2026-11-02T09:00:00.000Z",
  check: { state: "ok", checked_at: "2026-11-02T09:00:00.000Z" },
};
const EXAMPLE_USER_ID = "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35";
const EXAMPLE_AGENT_ID = "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d";
const EXAMPLE_ENV_VARIABLE = {
  name: "REGION",
  kind: "plain",
  value: "ap-northeast-1",
  version: 41,
  grant_all: false,
  grant_version: 42,
  granted_agents: [EXAMPLE_AGENT_ID],
  engine_delivery: false,
  updated_by: EXAMPLE_USER_ID,
  updated_at: "2026-11-09T01:00:00.000Z",
};
const EXAMPLE_SLACK_APP_REDIRECT = `https://console.example.ts.net/agents/${EXAMPLE_AGENT_ID}/slack/callback`;
const EXAMPLE_SLACK_APP = {
  id: "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
  kind: "agent",
  agent_id: EXAMPLE_AGENT_ID,
  state: "created",
  app_id: "A0B1C2D3E4F",
  client_id: "1234567890.9876543210",
  redirect_url: EXAMPLE_SLACK_APP_REDIRECT,
  created_by_token_user: "U0ISSUER",
  created_at: "2026-10-23T09:00:00Z",
  updated_at: "2026-10-23T09:00:00Z",
  secrets: {
    slack_signing_secret: {
      configured: true,
      last4: "c3d4",
      updated_at: "2026-10-23T09:00:00Z",
      updated_by: null,
    },
    slack_client_secret: {
      configured: true,
      last4: "e5f6",
      updated_at: "2026-10-23T09:00:00Z",
      updated_by: null,
    },
    slack_bot_token: {
      configured: false,
      last4: null,
      updated_at: null,
      updated_by: null,
    },
  },
};
const EXAMPLE_SLACK_AUTHORIZE_URL = `https://slack.com/oauth/v2/authorize?${new URLSearchParams(
  {
    client_id: EXAMPLE_SLACK_APP.client_id,
    scope: BOT_SCOPES.join(","),
    redirect_uri: EXAMPLE_SLACK_APP_REDIRECT,
  },
)}`;
const EXAMPLE_WORKSPACE = {
  id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
  slug: "acme",
  name: "Acme",
  settings: {
    dispatch_model: null,
    kill_switch: false,
    daily_cost_limit_usd: null,
    idle_pause_minutes: 30,
    audit_retention_days: 90,
    slack_guest_enabled: false,
    achievement_judge: {
      connection_id: null,
      threshold: 0.9,
      on_evidence: true,
      every_n_turns: null,
      on_idle: false,
      transcript: "recent",
      daily_budget_usd: 1,
      max_per_session: 20,
    },
  },
  created_at: "2026-10-01T09:00:00Z",
};
const ALL_SCOPES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
];
const EXAMPLE_TEAM_ID = "019a0000-0000-7000-8000-00000000b0a1";
const EXAMPLE_TEAM_MEMBER_ID = "5b9e2d7c-1a4f-4c3b-9e8d-7f6a5b4c3d21";
const EXAMPLE_TEAM = {
  id: EXAMPLE_TEAM_ID,
  workspace_id: EXAMPLE_WORKSPACE.id,
  name: "research admins",
  member_count: 2,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-10-23T09:00:00Z",
  revision: 3,
};
const EXAMPLE_AGENT_ADMINS = {
  users: [
    {
      user_id: EXAMPLE_USER_ID,
      email: "ada@example.com",
      display_name: "Ada Owner",
      created_by: EXAMPLE_USER_ID,
      created_at: "2026-10-23T09:00:00Z",
    },
  ],
  teams: [
    {
      team_id: EXAMPLE_TEAM_ID,
      name: EXAMPLE_TEAM.name,
      created_by: EXAMPLE_USER_ID,
      created_at: "2026-10-24T09:00:00Z",
    },
  ],
};
const TEAM_PAGES =
  "By `name`, then `id`, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. A team renamed while the pages are read can show twice or not at all; every other team shows once.";

const WORKSPACE_PROFILE_EXAMPLE = {
  id: "ws_acme_strict-review_v2",
  source: "workspace",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read", "Glob", "Grep"],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.319",
  billing: "metered",
  repository_mode: "required",
  workspace: {
    name: "strict-review",
    version: 2,
    base_profile_id: "claude-coding-real",
    state: "usable",
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: "2026-10-27T01:00:00.000Z",
    retired_by: null,
    retired_at: null,
  },
} as const;

const ACHIEVEMENT_CATEGORY_EXAMPLE = {
  id: "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  name: "Delivery",
  position: 0,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-11-02T01:00:00.000Z",
  archived_at: null,
  archived_by: null,
};
const ACHIEVEMENT_TYPE_EXAMPLE = {
  id: "6c2f3d4e-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
  key: "design_doc",
  name: "Design doc",
  evidence_kind: "out_file",
  builtin: false,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-11-02T01:00:00.000Z",
  archived_at: null,
  archived_by: null,
};
const ACHIEVEMENT_RULE_REQUEST_EXAMPLE = {
  category_id: ACHIEVEMENT_CATEGORY_EXAMPLE.id,
  title: "Design doc written",
  type_id: ACHIEVEMENT_TYPE_EXAMPLE.id,
  definition:
    "A design document for a change the session made: it says what changes and why.",
  judge: "luna",
};
const ACHIEVEMENT_RULE_EXAMPLE = {
  id: "7d3a4e5f-6b7c-4d8e-8f9a-1b2c3d4e5f60",
  family_id: "8e4b5f6a-7c8d-4e9f-9a0b-2c3d4e5f6a71",
  version: 1,
  ...ACHIEVEMENT_RULE_REQUEST_EXAMPLE,
  agent_ids: null,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-11-02T01:00:00.000Z",
  superseded_by: null,
  disabled_at: null,
  disabled_by: null,
};
const ACHIEVEMENT_JUDGE_EXAMPLE = EXAMPLE_WORKSPACE.settings.achievement_judge;
const ACHIEVEMENT_MANAGERS =
  "Owners and admins (`achievement_rule.manage`), signed in; API keys are refused.";

const SETTINGS_DOCUMENT_EXAMPLE = {
  version: 1,
  connections: {
    "anthropic-main": {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
    },
    "anthropic-console": {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", stored: true, last4: "x9Qa" },
    },
  },
  repositories: {
    "docs-site": {
      url: "https://github.com/acme/docs-site.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
  },
  mcp_servers: {},
};

const SETTINGS_OWNER =
  "The operator (`installation.settings.manage`, the workspace owner), signed in; an API key is 403 whatever its scopes.";
const SETTINGS_LIST =
  "The database's rows, disabled ones included, by id. A credential is shown as `stored` with its `last4`, or as the name of the env or Secrets Manager reference; never a value. `state`: `needs_value` (stored, no value yet), `unresolved` (the credential did not resolve on the replica that answered), `disabled`, else `active`. Changes nothing.";
const SETTINGS_CREATE =
  "The credential is the value in the request, sealed under this row alone in the same transaction as the row; a reference to the deployment's env or Secrets Manager is the operator's settings CLI's. The destination never changes after: another one is a new id. An id ever used (disabled rows count) is 409 `already_exists`; an entry the catalog's rules refuse is 400 `invalid_entry`. With the secret store off (no `PLATFORM_SECRET_KEY`) a credential is 503.";
const SETTINGS_CREDENTIAL =
  "Seals a new value for a row that stores its own: rotating it or giving a `needs_value` row its first. Running sessions are not stopped. A row whose credential comes from the operator's deployment is 409 `not_stored`, a disabled one 409 `disabled`, the secret store off 503. Writes a `set_settings_credential` receipt naming the last four characters.";
const SETTINGS_CONVERT =
  "For a connection whose key comes from the operator's deployment (an env or Secrets Manager reference): the person types the key, it is sealed under the same id, and the row is stored from then on. The server does not read the referenced value. Ceilings made before keep running on the stored key and their pins do not change. A settings document that still names the old entry leaves the row as it is. A connection that already keeps its own value is 409 `not_external`, a disabled one 409 `disabled`, one that another connection is or was exactly 409 `alias_taken`, the secret store off 503. Writes a `set_settings_credential` receipt naming the last four characters and which reference it replaced.";
const SETTINGS_DISABLE =
  "Never undone and nothing is deleted: the id stays taken and the stored value stays sealed. Ceilings over it stop running anything. Disabling one already disabled is 409 `disabled`.";
const SETTINGS_DISABLE_CONNECTION =
  "Nothing is deleted: the id stays taken and the stored value stays sealed. Ceilings over it stop running anything until it is enabled again. Disabling one already disabled is 409 `disabled`.";
const SETTINGS_ENABLE_CONNECTION =
  "Brings a disabled connection back: ceilings over it match it again once the settings are read again (a reference to the deployment that does not resolve leaves it `unresolved`). It is refused with 409 `not_disabled` when the row is in use, 409 `definition_active` when another connection in use is, or was, exactly what this one is (disable that one first), and 409 `needs_value` when its stored value is gone (disabling keeps it, so this is rare). The destination never changes. Writes an `enable_connection` receipt.";
const SETTINGS_CHANGE_EXAMPLE = (id: string) => ({
  id,
  receipt_id: "019a0000-0000-7000-8000-0000000000f3",
});
const SETTINGS_CONNECTION_EXAMPLE = {
  id: "anthropic-console",
  origin: "console",
  state: "active",
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  billing: "per_token",
  auth_kind: "api_key",
  auto_mode: "unknown",
  credential: { source: "stored", last4: "x9Qa" },
  created_at: "2026-11-04T03:00:00.000Z",
  disabled_at: null,
};
const SETTINGS_MCP_EXAMPLE = {
  id: "docs",
  origin: "console",
  state: "active",
  url: "https://mcp.example.com/mcp",
  credential_ref: "docs_mcp",
  workspaces: ["acme"],
  credential: { source: "stored", last4: "b3Rq" },
  created_at: "2026-11-04T03:00:00.000Z",
  disabled_at: null,
};
const INSTALLATION_PROFILE_EXAMPLE = {
  id: "op_coding_v2",
  source: "operator",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-5"],
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  permission_mode: "acceptEdits",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.319",
  billing: "metered",
  repository_mode: "required",
  repository_ids: ["sample-app"],
  installation: {
    name: "coding",
    version: 2,
    origin: "console",
    state: "usable",
    connection_id: "anthropic-main",
    title_model: "claude-haiku-5",
    project_settings: { claude_md: true },
    previous_id: "op_coding_v1",
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: "2026-10-28T01:00:00.000Z",
    retired_by: null,
    retired_at: null,
    blocked_by: null,
    blocked_at: null,
  },
} as const;

const EXAMPLE_AGENT = {
  id: EXAMPLE_AGENT_ID,
  workspace_id: EXAMPLE_WORKSPACE.id,
  slug: "finance",
  name: "Finance analyst",
  description: "Reads the quarterly reports and flags outliers.",
  managing_team_id: EXAMPLE_TEAM_ID,
  managing_team_name: "Finance",
  status: "active",
  active_release_id: null,
  activation_revision: -1,
  auto_model_migration: true,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:00:00Z",
};
const EXAMPLE_SESSION_SUMMARY = {
  id: EXAMPLE_SESSION_ID,
  title: "Fix the flaky checkout test",
  agent: {
    id: "8f6c1d2e-4b3a-4c5d-9e8f-7a6b5c4d3e2f",
    name: "Checkout fixer",
    release_version_no: 3,
    release_label: "2026-10-11_17:00:00",
    release_is_active: true,
  },
  agent_hidden: false,
  created_by: {
    user_id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    display_name: "Mina Park",
  },
  channel: "web",
  slack_permalink: null,
  revision: 7,
  admission_state: "active",
  status: "running",
  runtime: {
    kind: "claude_agent_sdk",
    version: "0.2.1",
    profile_id: "claude-coding-real",
    model: "claude-sonnet-5",
    permission_mode: "default",
  },
  model: "claude-sonnet-5",
  repository_id: "sample-app",
  repository: {
    id: "sample-app",
    full_name: "acme/sample-app",
    branch: "main",
  },
  current_turn_id: "3",
  queued_turn_count: 1,
  last_event_at: "2026-10-11T08:15:42Z",
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:15:40Z",
};
const EXAMPLE_SESSION_DETAIL = {
  ...EXAMPLE_SESSION_SUMMARY,
  execution: {
    backend: "local_docker",
    state: "running",
    observed_at: "2026-10-11T08:15:38Z",
  },
  checkpoint_revision: 2,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: "2026-10-11T08:15:41Z",
    checkpoint_committed_at: "2026-10-11T08:10:02Z",
    checkpoint_revision: 2,
    last_completed_turn_id: "2",
    last_checkpointed_turn_id: "2",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
};
const EXAMPLE_TURN_SUMMARY = {
  turn_id: "1",
  session_id: EXAMPLE_SESSION_ID,
  status: "completed",
  message: "Add a health check endpoint and a test for it.",
  channel: "web",
  created_by: { user_id: EXAMPLE_USER_ID, display_name: "Mina Park" },
  slack_permalink: null,
  terminal_reason: null,
  checkpoint_revision: 2,
  created_at: "2026-10-11T08:00:00Z",
  started_at: "2026-10-11T08:00:05Z",
  ended_at: "2026-10-11T08:03:12Z",
};
const EXAMPLE_PUSH_REQUEST_ID = "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41";
const EXAMPLE_GIT_COMMIT = "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c";
const EXAMPLE_ACTOR = {
  principal: { kind: "user", id: EXAMPLE_USER_ID },
  actor_user_id: EXAMPLE_USER_ID,
  agent_id: null,
};
const EXAMPLE_PUSH_REQUEST = {
  id: EXAMPLE_PUSH_REQUEST_ID,
  session_id: EXAMPLE_SESSION_ID,
  repository_id: "sample-app",
  checkpoint_revision: 3,
  git_commit: EXAMPLE_GIT_COMMIT,
  target_branch: `agent/${EXAMPLE_SESSION_ID}`,
  state: "requested",
  requested_by: EXAMPLE_ACTOR,
  requested_at: "2026-10-11T08:30:00Z",
  resolved_by: null,
  resolved_at: null,
  resolution_reason: null,
  request_receipt_id: EXAMPLE_RECEIPT_ID,
  resolution_receipt_id: null,
  finished_at: null,
  push_receipt_id: null,
};
const EXAMPLE_PULL_REQUEST = {
  push_request_id: EXAMPLE_PUSH_REQUEST_ID,
  session_id: EXAMPLE_SESSION_ID,
  repository_id: "sample-app",
  number: 42,
  url: "https://github.com/acme/sample-app/pull/42",
  head: `agent/${EXAMPLE_SESSION_ID}`,
  base: "main",
  created_at: "2026-10-11T08:40:00Z",
  receipt_id: "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d",
};
const ACCEPTED_RECEIPT = {
  receipt_id: EXAMPLE_RECEIPT_ID,
  receipt_status: "accepted",
};
const RESERVED_HERE =
  "Reserved: this operation does not currently return it, because it accepts a session in that state.";

export const API_ROUTE_DECLARATIONS = [
  {
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tag: "Health",
    summary: "Process liveness",
    description:
      "Answers 200 while the process serves HTTP; it checks nothing else, not even the database. Use it as a liveness probe, and `/readyz` to decide whether to send traffic.",
    success: {
      status: 200,
      schema: "HealthResponse",
      description: "The process is up.",
      example: { status: "ok" },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/readyz",
    operationId: "getReady",
    tag: "Health",
    summary: "DB, schema and config readiness",
    description:
      "Runs the readiness checks in order and stops at the first failure: `database` (the database answers), `schema` (the applied migrations include every migration of this build) and `config` (required settings and limits are valid). Use it as a readiness probe: a 503 means do not route traffic here. The execution backend is not checked. From the moment the process starts shutting down it answers 503 too.",
    success: {
      status: 200,
      schema: "ReadyResponse",
      description: "Every check passed.",
      example: {
        status: "ready",
        checks: { database: "ok", schema: "ok", config: "ok" },
      },
    },
    errors: [503],
    errorCodes: { 503: ["NOT_READY"] },
  },
  {
    method: "get",
    path: "/v1/openapi.json",
    operationId: "getOpenApiDocument",
    tag: "Health",
    summary: "Generated OpenAPI document",
    description:
      "This document as JSON, the same content as `docs/openapi.json` in the repository.",
    auth: "public",
    success: {
      status: 200,
      schema: "OpenApiDocument",
      description: "The OpenAPI 3.1 document.",
      example: {
        openapi: "3.1.0",
        info: { title: "Werft API", version: OPENAPI_VERSION },
      },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/v1",
    operationId: "getApiRoot",
    tag: "Auth",
    summary: "Check a credential and return its owner",
    description:
      "Checks a credential: answers 200 with the owner it authenticates as, or 401. It changes nothing; use it to test an API key before other calls.",
    scope: "read",
    success: {
      status: 200,
      schema: "ApiRootResponse",
      description: "The credential is valid.",
      example: {
        status: "ok",
        owner_id: "7b0e5c1e-2f4a-4d7e-9a51-3c6f0b8d2e14",
      },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/auth/bootstrap",
    operationId: "bootstrap",
    tag: "Auth",
    summary:
      "Create the first owner and default workspace, or recover an owner",
    description:
      "Allowed only while no live owner exists (an owner whose account or membership is disabled is not live). On an installation that already has users it adds or restores the owner in the existing workspace, ignores workspace_name and workspace_slug, revokes every web session in the workspace and writes a `recover_owner` receipt. Each BOOTSTRAP_TOKEN works once per installation; a token presented while a live owner exists is spent. A wrong or spent token answers 401 before the owner state is looked at.",
    auth: "public",
    body: "BootstrapRequest",
    requestExample: {
      bootstrap_token: "<the BOOTSTRAP_TOKEN printed at install>",
      email: "owner@example.com",
      password: "correct horse battery staple",
      display_name: "Ada Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    },
    success: {
      status: 201,
      schema: "BootstrapResponse",
      description:
        "The owner, the workspace and the membership are created, or the owner is restored in the existing workspace.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace: EXAMPLE_WORKSPACE,
        role: "owner",
      },
    },
    errors: [400, 401, 409, 413, 503],
    errorCodes: { 409: ["BOOTSTRAP_DONE"] },
    errorNotes: {
      UNAUTHORIZED:
        "`bootstrap_token` is missing, does not match the installation's token, or was already used; checked first, before the owner state and the rest of the body.",
      BOOTSTRAP_DONE:
        "A live owner exists, checked only after the token matched (the token is then spent); also the answer to the loser of two concurrent bootstraps.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/login-methods",
    operationId: "listLoginMethods",
    tag: "Auth",
    summary: "How a person can sign in on this installation",
    description:
      "`password` always; `google` when Google sign-in is configured. The login page offers these.",
    auth: "public",
    success: { status: 200, schema: "LoginMethodsResponse" },
    errors: [],
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
    tag: "Auth",
    summary: "Email/password login; sets the session cookie",
    description:
      "Checks an email and password and starts a browser session: the response sets the `__Host-werft_session` cookie (HttpOnly, Secure, SameSite=Lax) for 14 days, and the expiry slides forward while the session is used. A user keeps at most 10 live sessions; a new login drops the oldest. This is for the web app; scripts and servers use an API key.",
    auth: "public",
    csrf: "always",
    body: "LoginRequest",
    requestExample: {
      email: "owner@example.com",
      password: "correct horse battery staple",
    },
    success: {
      status: 200,
      schema: "LoginResponse",
      description:
        "Signed in; the response sets the session cookie. `scopes` are the ones the workspace role holds.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace_id: EXAMPLE_WORKSPACE.id,
        role: "owner",
        scopes: ALL_SCOPES,
        expires_at: "2026-10-25T09:00:00Z",
      },
    },
    errors: [400, 401, 403, 413, 429, 503],
    errorNotes: {
      UNAUTHORIZED:
        "Unknown email, wrong password, or a user with no live workspace membership.",
      RATE_LIMITED:
        "Five failed logins for this email within 15 minutes lock it until the window ends (`Retry-After` is the time left), or too many logins are being checked at once (`Retry-After: 1`).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/start",
    operationId: "startGoogleLogin",
    tag: "Auth",
    summary: "Begin Google sign-in; answers the Google URL to open",
    description:
      "Sets a short-lived cookie that binds the flow (state, nonce, PKCE verifier) to this browser. 404 when Google sign-in is not configured.",
    auth: "public",
    csrf: "always",
    success: { status: 200, schema: "StartGoogleLoginResponse" },
    errors: [403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/callback",
    operationId: "googleLoginCallback",
    tag: "Auth",
    summary: "Finish Google sign-in; sets the session cookie",
    description:
      "Posts the `code` and `state` Google returned to the redirect URI. The first matching rule decides: an already linked Google account signs in as its user; an address that already has an account answers 409 LOGIN_LINK_REQUIRED and is never joined by email; otherwise a live invite for the address, or JIT for an allowed domain, creates the account. Anything else answers 401 without saying whether an account exists. A Google account outside the allowed domains answers 403.",
    auth: "public",
    csrf: "always",
    body: "GoogleLoginCallbackRequest",
    success: { status: 200, schema: "LoginResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["LOGIN_LINK_REQUIRED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/password-reset",
    operationId: "resetPassword",
    tag: "Auth",
    summary: "Set a new password with a one-time reset link",
    description:
      "Spends the token, sets the password, revokes every live web session of the user and writes a `reset_password` receipt. There is no failure window: the token cannot be guessed, and a shared one would let anyone lock recovery out. Password hashing shares login's concurrency limit, past which it answers 429.",
    auth: "public",
    body: "PasswordResetRequest",
    success: { status: 200, schema: "PasswordResetResponse" },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/members/{userId}/password-reset",
    operationId: "issuePasswordReset",
    tag: "Members",
    summary: "Issue a one-time password reset link for a member (owner only)",
    description:
      "Requires the issuer's current password, counted against the issuer's login failure window. An owner cannot issue a link for themselves, nor for a member who owns another workspace. The token is returned once and expires in one hour; issuing another revokes the member's open link. Writes an `issue_password_reset` receipt whose result names the target's role.",
    auth: "session",
    body: "IssuePasswordResetRequest",
    success: { status: 201, schema: "IssuePasswordResetResponse" },
    errors: [400, 401, 403, 404, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/audit-retention",
    operationId: "setAuditRetention",
    tag: "Workspace settings",
    summary: "Set how many days authorization decisions are kept (owner only)",
    description:
      "At least 30 days; the default is 90. Rows older than this are deleted by the reconciler. The current value is `workspace.settings.audit_retention_days` in GET /v1/auth/me.",
    auth: "session",
    body: "AuditRetentionRequest",
    success: { status: 200, schema: "AuditRetentionResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/slack-guest",
    operationId: "setSlackGuest",
    tag: "Workspace settings",
    summary: "Let Slack guests call agents, or stop them (owner or admin)",
    description:
      "Off by default. While off, a Slack guest (`is_restricted`) who calls an agent is refused with `guest_disabled`; while on, a guest still has to link their Slack account. Slack Connect users from other organizations are refused either way. An app with Slack's agent features on is closed to guests by Slack itself. The current value is `workspace.settings.slack_guest_enabled` in GET /v1/auth/me.",
    auth: "session",
    body: "SlackGuestRequest",
    success: { status: 200, schema: "SlackGuestResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "patch",
    path: "/v1/workspaces/{id}/agent-access",
    operationId: "setAgentAccess",
    tag: "Workspace settings",
    summary:
      "Set what members outside an agent may do with it and its sessions (owner or admin)",
    description:
      "Inside an agent are owners, admins, the agent's admins (its admin rows, its admin teams' members and its managing team's leads) and its managing team's other members; every other member is outside it. `agent_outsider_access` (default `use`): `use` lets those outside read the agent's information and start its sessions, `view` only read its information (a start is 403 FORBIDDEN, `details.reason_code` `role`), `none` hides the agent from them (absent from GET /v1/agents, 404 on reads of it, and a start is 403). It applies to every agent. `agent_outsider_session_visibility` (default `managing_team`): `managing_team` keeps the `workspace`-scoped sessions of an agent from those outside it, in every list, count, read, stream and usage list; `workspace` lets every member see them. A session the member holds, and a `people` or `team` share naming them, still reach them; an agent still held by the 'Unassigned agents' team that migration 0243 made for agents that had no managing team is not limited, until it is moved to a real team. Both apply from the next request to sessions already made, and an open event stream ends at its next page. A key left out keeps its value; name at least one. Writes a `set_agent_access_settings` receipt with what changed unless nothing did (`receipt_id` null). The current values are `workspace.settings` in GET /v1/auth/me.",
    auth: "session",
    body: "AgentAccessRequest",
    requestExample: { agent_outsider_access: "view" },
    success: {
      status: 200,
      schema: "AgentAccessResponse",
      description: "Both settings as they now stand.",
      example: {
        agent_outsider_access: "view",
        agent_outsider_session_visibility: "managing_team",
        receipt_id: "b3c4d5e6-f7a8-4b9c-8d0e-1f2a3b4c5d6e",
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "getSlackConfigToken",
    tag: "Workspace settings",
    summary:
      "Whether the Slack App Configuration Token is set (owner or admin)",
    description:
      "Says whether a token is set, its last four characters, when it was last set and by whom, when the current access token expires and which Slack user issued it. `state` is `unset`, `active`, or `needs_reentry` when Slack no longer takes the stored token or a rotation's answer was lost: paste a new one. The token itself is never returned. `urls` are the addresses to copy into a Slack app made by hand, computed from the console's public origin (`CONSOLE_ORIGIN`) and fixed paths: `redirect_url` for Sign in with Slack and `events_url_template` with `{agent_id}` for the agent's id. Each is null when it cannot be computed: no origin, or (events) an origin that is not https. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "SlackConfigTokenSummary",
      description: "The token's state; never its value.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        urls: {
          redirect_url:
            "https://werft.example.com/settings/linked-accounts/slack",
          events_url_template:
            "https://werft.example.com/v1/slack/events/{agent_id}",
        },
        state: "active",
        expires_at: "2026-10-23T21:00:00Z",
        issuer: { user_id: "U0ISSUER", team_id: "T0TEAM" },
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "putSlackConfigToken",
    tag: "Workspace settings",
    summary:
      "Set or replace the Slack App Configuration Token (owner or admin)",
    description:
      "Paste the refresh token from api.slack.com/apps. It is rotated with Slack at once (`tooling.tokens.rotate`), which proves Slack takes it; the new access and refresh tokens are stored encrypted together and the pasted one is spent. A token Slack refuses changes nothing stored (409 CONFIG_TOKEN_INVALID, `rejected`). When the token belongs to another Slack user than before, `warnings` says so: that user becomes the collaborator of every app made from now on. The response and the `set_slack_secret` receipt carry the last four characters only, and the value is in no log or error. API keys are refused.",
    auth: "session",
    body: "PutSlackSecretRequest",
    requestExample: { value: "<refresh-token-from-api.slack.com>" },
    success: {
      status: 200,
      schema: "PutSlackConfigTokenResponse",
      description:
        "Stored; the summary as GET now answers it, the receipt and any warnings.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        urls: {
          redirect_url:
            "https://werft.example.com/settings/linked-accounts/slack",
          events_url_template:
            "https://werft.example.com/v1/slack/events/{agent_id}",
        },
        state: "active",
        expires_at: "2026-10-23T21:00:00Z",
        issuer: { user_id: "U0ISSUER", team_id: "T0TEAM" },
        receipt_id: EXAMPLE_RECEIPT_ID,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; nothing stored changed.",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "deleteSlackConfigToken",
    tag: "Workspace settings",
    summary: "Delete the Slack App Configuration Token (owner or admin)",
    description:
      "Deletes the stored token and writes a `delete_slack_secret` receipt with its last four characters. 404 when none is set. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteSlackSecretResponse",
      description: "Deleted; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "getGitHubApp",
    tag: "Workspace settings",
    summary:
      "The workspace's GitHub App and where it is installed (owner or admin)",
    description:
      "The App registered in the console (its id, name and page, and when and by whom the private key was last set; never the key), then GitHub's answer for it now, asked with the App's own JWT: its installations, and for each catalog repository written as `auth: { kind: github_app }` the installation that covers it (null when the App is not installed there). `check` is null with no App registered, and `failed` when GitHub did not answer (`github_unreachable`) or refused the App (`github_rejected`: a revoked key or a deleted App). API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetGitHubAppResponse",
      description: "The App and its installations; never the private key.",
      example: {
        github_app: {
          app_id: 123456,
          slug: "acme-agents",
          name: "Acme agents",
          html_url: "https://github.com/apps/acme-agents",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
        },
        check: { state: "ok" },
        installations: [
          {
            id: 7654321,
            account: "acme",
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/acme/settings/installations/7654321",
          },
        ],
        repositories: [
          {
            id: "app",
            url: "https://github.com/acme/app.git",
            installation_id: 7654321,
          },
        ],
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "putGitHubApp",
    tag: "Workspace settings",
    summary: "Register or replace the workspace's GitHub App (owner or admin)",
    description:
      "The author App's route; `…/github-apps/author` is the same. Takes the App's id and the private key GitHub issued for it (the PEM file's text). The key must be an RSA private key (400 `invalid_private_key`), and GitHub must accept a JWT signed with it for that id (400 `github_app_rejected`); only then is it stored, encrypted under the master key, with the App's name and page as GitHub reports them. A workspace has one author App: this replaces the one before, and repositories written as `auth: { kind: github_app }` use the new one from their next token. Writes a `set_github_app` receipt naming the App id. The key is in no response, receipt, log or error. API keys are refused.",
    auth: "session",
    body: "PutGitHubAppRequest",
    requestExample: {
      app_id: 123456,
      private_key: "<the .pem file GitHub downloaded>",
    },
    success: {
      status: 200,
      schema: "PutGitHubAppResponse",
      description: "Stored; the App as GET now answers it, and the receipt.",
      example: {
        github_app: {
          app_id: 123456,
          slug: "acme-agents",
          name: "Acme agents",
          html_url: "https://github.com/apps/acme-agents",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["GITHUB_APP_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or GitHub could not be reached (`github_unreachable`); nothing stored changed.",
      GITHUB_APP_CONFLICT: "Here: `same_app`, the reviewer App is this App.",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "deleteGitHubApp",
    tag: "Workspace settings",
    summary: "Remove the workspace's GitHub App (owner or admin)",
    description:
      "Deletes the App and its private key and writes a `delete_github_app` receipt. Repositories written as `auth: { kind: github_app }` can no longer be cloned, pushed to or get pull requests until an App is registered again. The App stays on GitHub. 404 when none is registered. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteGitHubAppResponse",
      description: "Deleted; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-apps/{role}",
    operationId: "getWorkspaceGitHubApp",
    tag: "Workspace settings",
    summary:
      "One of the workspace's GitHub Apps and where it is installed (owner or admin)",
    description:
      "`role` is `author` (the App that clones, pushes and opens pull requests; `…/github-app` is the same) or `reviewer` (an optional second App that only submits pull request reviews, since GitHub refuses an approval from the App that opened the pull request), served while the role has at most one connection (else 409 `GITHUB_APP_CONFLICT` `ambiguous_role`), or a connection id (`GET …/github-apps` lists them; 404 for one not the workspace's). `usage` says what removing it affects: repositories pinned to it, agents with GitHub on whose active release names one, sessions not ended on one, and whether people link their accounts with it. Answers as `GET …/github-app` does for that role's App: the App as registered, its permissions as GitHub reports them now, its installations, and for each catalog repository written as `auth: { kind: github_app }` the installation that covers it and what that installation grants (`installation_permissions`; it trails the App's own permissions until an owner approves a raise on GitHub). API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetGitHubAppResponse",
      description: "The App and its installations; never the private key.",
      example: {
        github_app: {
          role: "reviewer",
          app_id: 234567,
          slug: "acme-reviewer",
          name: "Acme reviewer",
          html_url: "https://github.com/apps/acme-reviewer",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
          permissions: {
            contents: "read",
            metadata: "read",
            pull_requests: "write",
          },
          permissions_checked_at: "2026-10-30T09:00:00Z",
          warnings: [],
        },
        check: { state: "ok" },
        installations: [
          {
            id: 7654322,
            account: "acme",
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/acme/settings/installations/7654322",
          },
        ],
        repositories: [
          {
            id: "app",
            url: "https://github.com/acme/app.git",
            installation_id: 7654322,
            installation_permissions: {
              contents: "read",
              metadata: "read",
              pull_requests: "write",
            },
          },
        ],
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["GITHUB_APP_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-apps/{role}",
    operationId: "putWorkspaceGitHubApp",
    tag: "Workspace settings",
    summary:
      "Register or replace one of the workspace's GitHub Apps (owner or admin)",
    description:
      "Takes the App's id and private key as `PUT …/github-app` does, checks the key with GitHub the same way, and stores it. `role` is a role or a connection id. A role registers the role's first connection, or replaces it while the role has exactly one; with several it is 409 `GITHUB_APP_CONFLICT` `ambiguous_role` (name one by id, or add with `POST …/github-apps`). Replacing it with another App drops the repository pins it held (`pins_cleared`). A connection id rotates that connection's key: the `app_id` must be its App (400 `app_id_mismatch`). Each connection has its own key: changing one never touches another. One App is one connection in a workspace, whatever the role (409 `same_app`), and a reviewer App needs an author App first (409 `no_author_app`); both are decided under the workspace's lock. A reviewer App needs `pull_requests: write` and `contents`, `metadata` read; wider permissions are kept and listed in `warnings`. Writes a `set_github_app` receipt naming the App id and role. The key is in no response, receipt, log or error. API keys are refused.",
    auth: "session",
    body: "PutGitHubAppRequest",
    requestExample: {
      app_id: 234567,
      private_key: "[REDACTED]",
    },
    success: {
      status: 200,
      schema: "PutGitHubAppResponse",
      description: "Stored; the App as GET now answers it, and the receipt.",
      example: {
        github_app: {
          role: "reviewer",
          app_id: 234567,
          slug: "acme-reviewer",
          name: "Acme reviewer",
          html_url: "https://github.com/apps/acme-reviewer",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
          permissions: {
            contents: "read",
            metadata: "read",
            pull_requests: "write",
          },
          permissions_checked_at: "2026-10-30T09:00:00Z",
          warnings: [],
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["GITHUB_APP_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or GitHub could not be reached (`github_unreachable`); nothing stored changed.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/github-apps/author/manifest",
    operationId: "startGitHubAppManifest",
    tag: "Workspace settings",
    summary:
      "Start making the author GitHub App from a manifest (owner or admin)",
    description: `Returns the manifest for a new author App and the GitHub URL the browser form-POSTs it to (field \`manifest\`), with a new single-use \`state\` in that URL, valid ${GITHUB_APP_MANIFEST_STATE_TTL_SECONDS / 60} minutes and bound to the caller and the workspace. \`owner\` picks an organization (its owners can create the App) or the caller's own account; a private App (\`public: false\`, the default) installs only on that account. The manifest asks for \`contents\` and \`pull_requests\` write and \`metadata\` read, plus \`actions\` and \`workflows\` write with \`actions: true\`; its webhook is off, its redirect is the console's \`/settings/workspace/integrations/github/new-app\` and its callback the account-link page. The App it makes is always another author connection, beside any registered: \`replace\` is ignored, and moving to the new App is removing the old connection afterwards. API keys are refused.`,
    auth: "session",
    body: "StartGitHubAppManifestRequest",
    requestExample: {
      owner: { kind: "organization", login: "acme" },
      public: false,
      actions: false,
    },
    success: {
      status: 200,
      schema: "StartGitHubAppManifestResponse",
      description:
        "Where the browser posts the manifest, and when the state expires.",
      example: {
        action_url:
          "https://github.com/organizations/acme/settings/apps/new?state=<single-use>",
        manifest: '{"name":"werft-acme-1a2b","public":false}',
        expires_at: "2026-11-01T10:00:00Z",
      },
    },
    errors: [400, 401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or without CONSOLE_ORIGIN (`console_origin_unset`).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/github-apps/author/manifest/complete",
    operationId: "completeGitHubAppManifest",
    tag: "Workspace settings",
    summary: "Finish making the author GitHub App with what GitHub returned",
    description:
      "The console's callback page sends the `code` and `state` from GitHub's redirect. The state is spent first: unknown, spent, expired, or issued to another caller or workspace answers 400 `BAD_REQUEST` `state_invalid`. The code is exchanged once with `POST /app-manifests/{code}/conversions` (400 `code_rejected` when GitHub refuses it, 503 `github_unreachable` when it cannot be reached; never retried). The App is stored as another author connection, with its private key, in one transaction with a `set_github_app` receipt (`source: manifest`); its OAuth client secret is kept only when it becomes the connection people link their accounts with (the workspace had no author connection), and the webhook secret is not kept. If storing fails, 503 `store_failed`, naming the App made on GitHub in `details.app_id` and `details.html_url`. No key, secret or code is in any response, receipt or log, and every answer carries `Referrer-Policy: no-referrer`. API keys are refused.",
    auth: "session",
    body: "CompleteGitHubAppManifestRequest",
    requestExample: {
      code: "code-from-the-redirect",
      state: "state-from-the-redirect",
    },
    success: {
      status: 200,
      schema: "CompleteGitHubAppManifestResponse",
      description:
        "Stored; the App, where it is installed next, and the receipt.",
      example: {
        github_app: {
          role: "author",
          app_id: 234568,
          slug: "werft-acme-1a2b",
          name: "werft-acme-1a2b",
          html_url: "https://github.com/apps/werft-acme-1a2b",
          private_key: {
            updated_at: "2026-11-01T09:05:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-11-01T09:05:00Z",
          updated_at: "2026-11-01T09:05:00Z",
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
          },
          permissions_checked_at: "2026-11-01T09:05:00Z",
          warnings: [],
        },
        install_url:
          "https://github.com/apps/werft-acme-1a2b/installations/new",
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), GitHub could not be reached (`github_unreachable`), or the App could not be stored (`store_failed`).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/github-apps/{connectionId}/installations/start",
    operationId: "startGitHubInstallation",
    tag: "Workspace settings",
    summary:
      "Start installing a connection's GitHub App on an account (owner or admin)",
    description: `Returns the App's \`/installations/new\` page with a new single-use \`state\`, valid ${GITHUB_INSTALLATION_STATE_TTL_SECONDS / 60} minutes and bound to the caller, the workspace and the connection; only its SHA-256 is stored. GitHub sends the browser back to the App's setup URL with \`installation_id\` and the state, and \`POST …/github-apps/installations/complete\` records who connected it. 404 for a connection not the workspace's. API keys are refused.`,
    auth: "session",
    success: {
      status: 200,
      schema: "StartGitHubInstallationResponse",
      description:
        "Where the browser installs the App, and when the state expires.",
      example: {
        install_url:
          "https://github.com/apps/werft-acme-1a2b/installations/new?state=<single-use>",
        expires_at: "2026-11-02T10:00:00Z",
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/github-apps/installations/complete",
    operationId: "completeGitHubInstallation",
    tag: "Workspace settings",
    summary: "Record who connected a GitHub App installation from the console",
    description:
      "The console's setup page sends the `state` and `installation_id` GitHub's setup URL redirect carried. The state is spent first: unknown, spent, expired, issued to another caller or workspace, or for a connection that was removed or now holds another App answers 400 `BAD_REQUEST` `state_invalid`. The installation is read with the state's App's JWT (`GET /app/installations/{id}`): one that App does not have is 404 `installation_not_found`, and GitHub not answering is 502 `GITHUB_UNAVAILABLE` (`github_unavailable` or `github_app_auth_failed`). The caller and the time are recorded only when GitHub made the installation after the state, and only once: an installation that existed before, or already has someone recorded, answers `recorded: false` and keeps what it has. The setup URL's values can be forged, so the record is what `GET …/github-settings` shows as `detail.connected` and decides no access. Every answer carries `Referrer-Policy: no-referrer`. API keys are refused.",
    auth: "session",
    body: "CompleteGitHubInstallationRequest",
    requestExample: {
      state: "state-from-the-redirect",
      installation_id: 7654323,
    },
    success: {
      status: 200,
      schema: "CompleteGitHubInstallationResponse",
      description:
        "The installation's connection, and whether it was recorded now.",
      example: {
        connection_id: "6f1b8c1e-3a4d-4f0a-9c7e-2b5d8e9f0a1b",
        installation_id: 7654323,
        recorded: true,
      },
    },
    errors: [400, 401, 403, 404, 502, 503],
    errorCodes: { 502: ["GITHUB_UNAVAILABLE"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/github-apps/{role}",
    operationId: "deleteWorkspaceGitHubApp",
    tag: "Workspace settings",
    summary: "Remove one of the workspace's GitHub Apps (owner or admin)",
    description:
      "Deletes a connection and its private key and writes a `delete_github_app` receipt naming the role. `role` is a role while it has exactly one connection (else 409 `GITHUB_APP_CONFLICT` `ambiguous_role`), or a connection id. Repositories pinned to it keep their pin, emptied: their work for that role is refused (`pinned_app_removed`) until an admin pins another connection, or the same App is added again. The connection people link their accounts with is refused while another author connection exists (409 `in_use_for_user_link`; choose another with `PUT …/github-settings/user-link-app` first); the last author connection is removed with the link. Without a reviewer App, review work is refused from the next request on (409 `GITHUB_REFUSED` `no_reviewer_app`). `GET` on it answers `usage` first. The App stays on GitHub. 404 when none is registered. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteGitHubAppResponse",
      description: "Deleted; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["GITHUB_APP_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-apps",
    operationId: "listWorkspaceGitHubApps",
    tag: "Workspace settings",
    summary: "Every GitHub App connection of the workspace (owner or admin)",
    description:
      "Each registered App connection, author ones first and oldest first within a role, with its `connection_id`, as stored: nothing is asked of GitHub. A role may have several connections; `…/github-apps/{connection_id}` reads, rotates the key of, or removes one. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "ListGitHubAppsResponse",
      description: "The connections; never a private key.",
      example: { github_apps: [] },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/github-apps",
    operationId: "addWorkspaceGitHubApp",
    tag: "Workspace settings",
    summary: "Add a GitHub App connection for a role (owner or admin)",
    description:
      "Takes `role`, the App's id and private key, checks the key with GitHub as `PUT …/github-apps/{role}` does and stores a new connection; a role may have any number. An App already registered in the workspace, in either role, is 409 `GITHUB_APP_CONFLICT` `same_app`; a reviewer App needs an author App first (409 `no_author_app`). The first author connection is the one people link their accounts with. Pins that the same App held before it was removed are filled again with the new connection (`pins_restored`). Writes a `set_github_app` receipt. API keys are refused.",
    auth: "session",
    body: "PostGitHubAppRequest",
    requestExample: {
      role: "author",
      app_id: 234569,
      private_key: "[REDACTED]",
    },
    success: {
      status: 200,
      schema: "PutGitHubAppResponse",
      description: "Stored; the new connection and the receipt.",
      example: {
        github_app: {
          role: "author",
          connection_id: "019a0000-0000-7000-8000-0000000000c9",
          app_id: 234569,
          slug: "acme-second",
          name: "Acme second",
          html_url: "https://github.com/apps/acme-second",
          private_key: {
            updated_at: "2026-11-02T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-11-02T09:00:00Z",
          updated_at: "2026-11-02T09:00:00Z",
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
          },
          permissions_checked_at: "2026-11-02T09:00:00Z",
          warnings: [],
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
        pins_cleared: 0,
        pins_restored: 0,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["GITHUB_APP_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or GitHub could not be reached (`github_unreachable`); nothing stored changed.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-repositories",
    operationId: "listGitHubRepositories",
    tag: "Workspace settings",
    summary:
      "A page of the GitHub Apps' repositories, and the catalog's (owner or admin)",
    description:
      "The repositories one installation of the workspace's GitHub Apps reaches, a page at a time as GitHub pages them (`GET /installation/repositories`): `installation_id` picks the installation (absent: the first not suspended, the author App's before the reviewer App's, by account; while the role read first has several connections, absent is 400 `installation_required`), `page` and `per_page` (at most 100) the page, and `total_count` is GitHub's count. `installations` lists the author App's installations, then the reviewer App's, each with its App's `connection_id` and `role`, the `permissions` the account approved, and `repository_count` (GitHub's count, asked for the first 20 installations; null past them or when GitHub did not give it). An App GitHub does not answer for leaves its installations out. Nothing is registered: a repository becomes a catalog row when an agent's manager picks it (`POST /v1/agents/{id}/github/repositories`), and `catalog_id` then names it; `agent_count` counts agents whose active release names it, and on a reviewer App's page only those that turn review on. `unavailable` says why the page is empty: `no_author_app`, `no_installation`, or, with no `installation_id` named, GitHub not answering (`github_unavailable` or `github_app_auth_failed`, the author App's cause first) or every installation suspended (`installation_suspended`); then `catalog` and the installations that were read still come back, to name one. `catalog` lists the rows picks resolved or a seed left (`source` `selection`, `console` or `seed`; their branch is changed with PATCH), each with its `agent_count`; `installed` says whether an installation of any author App covers a row now (asked for the first 100 rows; null past them, or when GitHub could not answer for an App and none said yes), and a row's `pins` names the connection each role's work uses (`GET …/app-pins` for the choices). An installation id no registered App has, or one GitHub no longer has, is 404 `installation_not_found`; a suspended one is 409 `INSTALLATION_SUSPENDED`; GitHub not answering for the App that may hold a named installation is 502 `GITHUB_UNAVAILABLE` (`github_unavailable` is worth retrying, `github_app_auth_failed` is not). API keys are refused.",
    auth: "session",
    query: "GitHubRepositoryPageQuery",
    success: {
      status: 200,
      schema: "ListGitHubRepositoriesResponse",
      description: "The page and the catalog's repositories.",
      example: {
        installations: [EXAMPLE_GITHUB_INSTALLATION_SUMMARY],
        installation_id: 4242,
        page: 1,
        per_page: 30,
        total_count: 1,
        repositories: [
          {
            github_repository_id: 123456789,
            full_name: "acme/app",
            default_branch: "main",
            private: true,
            catalog_id: "app",
            agent_count: 2,
          },
        ],
        unavailable: null,
        catalog: [
          {
            id: "app",
            github_repository_id: 123456789,
            full_name: "acme/app",
            url: "https://github.com/acme/app.git",
            branch: "main",
            source: "selection",
            version: 1,
            installed: true,
            updated_at: "2026-11-01T09:00:00Z",
            agent_count: 2,
          },
        ],
      },
    },
    errors: [400, 401, 403, 404, 409, 502],
    errorCodes: {
      409: ["INSTALLATION_SUSPENDED"],
      502: ["GITHUB_UNAVAILABLE"],
    },
  },
  {
    method: "patch",
    path: "/v1/workspaces/{id}/github-repositories/{repositoryId}",
    operationId: "updateGitHubRepository",
    tag: "Workspace settings",
    summary: "Change a repository's default branch (owner or admin)",
    description:
      "Sets the branch sessions start from. `version` is the one last read; another is 409 `REVISION_CONFLICT`. A session already running on the repository is refused its next repository request (`CATALOG_MISMATCH`). Writes a `set_repository_branch` receipt with the branch before and after. API keys are refused.",
    auth: "session",
    body: "PatchGitHubRepositoryRequest",
    requestExample: { branch: "develop", version: 1 },
    success: {
      status: 200,
      schema: "GitHubRepositoryWriteResponse",
      description: "Changed; the repository and the receipt.",
      example: {
        repository: {
          id: "app",
          github_repository_id: 123456789,
          full_name: "acme/app",
          url: "https://github.com/acme/app.git",
          branch: "develop",
          source: "selection",
          version: 2,
          installed: true,
          updated_at: "2026-11-01T09:05:00Z",
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins",
    operationId: "getGitHubRepositoryAppPins",
    tag: "Workspace settings",
    summary:
      "Which App connection a repository uses per role, and the choices (owner or admin)",
    description:
      "`pins` names the connection each role's work on the repository uses (null: none yet, or the pinned one was removed, which the gate then refuses as `pinned_app_removed`). `candidates` lists every connection with `installed`: whether an installation of its App covers the repository now (null when GitHub did not answer). API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetGitHubRepositoryAppPinsResponse",
      description: "The pins and the candidates.",
      example: {
        catalog_id: "app",
        pins: {
          author: "019a0000-0000-7000-8000-0000000000c9",
          reviewer: null,
        },
        candidates: [
          {
            connection_id: "019a0000-0000-7000-8000-0000000000c9",
            role: "author",
            name: "Acme second",
            app_id: 234569,
            installed: true,
          },
        ],
      },
    },
    errors: [401, 403, 404],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins/{role}",
    operationId: "putGitHubRepositoryAppPin",
    tag: "Workspace settings",
    summary:
      "Pin the App connection a repository's work uses for a role (owner or admin)",
    description:
      "Sets the connection `role`'s tokens for the repository are issued from. The connection must be the workspace's and of that role (else 404, or 400 `role_mismatch`), and an installation of its App must cover the repository now (400 `not_installed`); GitHub not answering is 502 `GITHUB_UNAVAILABLE`. Tokens already issued keep working until they expire; the next one comes from the new connection. Writes a `set_repository_github_app` receipt with the connection before and after; `receipt_id` is null when it was already pinned there. API keys are refused.",
    auth: "session",
    body: "PutGitHubRepositoryAppPinRequest",
    requestExample: { connection_id: "019a0000-0000-7000-8000-0000000000c9" },
    success: {
      status: 200,
      schema: "PutGitHubRepositoryAppPinResponse",
      description: "Pinned; the receipt.",
      example: {
        catalog_id: "app",
        role: "author",
        connection_id: "019a0000-0000-7000-8000-0000000000c9",
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 502, 503],
    errorCodes: { 502: ["GITHUB_UNAVAILABLE"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-settings",
    operationId: "getGitHubSettings",
    tag: "Workspace settings",
    summary: "The workspace's GitHub ceiling (members)",
    description:
      "What the workspace lets its agents turn on beyond writing a pull request: `workflows`, `actions`, `checks`, `issues`, `review`, all false until an owner or admin saves the ceiling (`revision` 0 until then). `merge` is the ceiling's alone, no agent or release holds it: it lets the workspace's agents squash-merge the pull request their own session opened, it reads false when a stored ceiling lacks it, and GitHub's branch protection and required checks still apply. An agent's release may turn a feature on only under the ceiling, and every GitHub token is cut to the ceiling again when it is issued. `agents_using` counts, per feature, agents with GitHub on whose active release turns it on; sessions still running an earlier release are not counted. `connections` lists every registered App (author ones first; a role may have several) with its `name`, `app_id`, the `owner` account GitHub names, the `permissions` it asks for, `key_status`, and where it is installed: each installation's `account`, `account_type` and `status` (`suspended`, `approval_pending` when the account has not approved every permission the App asks for, `unknown` before the App's permissions were read or when the list could not be read now, else `active`). Installations are read from GitHub with each App's own key on every request, so one App failing does not hide another's: its `check` is `failed` with `reason_code` (`github_unavailable` or `github_app_auth_failed`), its `installations` is the last list read for that App with each `status` `unknown` (empty when none was ever read), and `installations_read_at` says when that list was read (null when never). An installation's `detail` (connection, account id, approved permissions, `approval`, `repository_count` for the first 20 when read now, `repository_selection`, its settings page, `created_at`, `suspended_at`, and `connected`: who finished installing it from the console and when, null when not recorded) is given to owners and admins only; a member reads null. `apps` has each role's App permissions as last read from GitHub; it reads null for a role with several Apps, so read `connections`. Any member signed in to the console reads it; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GitHubSettingsResponse",
      description: "The ceiling and who uses it.",
      example: {
        ceiling: {
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
          merge: false,
        },
        revision: 3,
        agents_using: {
          workflows: 0,
          actions: 2,
          checks: 0,
          issues: 0,
          review: 0,
        },
        oauth: {
          client_id: "Iv23liExampleClientId",
          client_secret_set: true,
          callback_url:
            "https://console.example.com/settings/linked-accounts/github",
        },
        pull_request: EXAMPLE_PULL_REQUEST_SETTINGS,
        pull_request_revision: 0,
        connections: [EXAMPLE_GITHUB_CONNECTION],
        apps: {
          author: {
            permissions: {
              contents: "write",
              pull_requests: "write",
              actions: "write",
              metadata: "read",
            },
          },
          reviewer: null,
        },
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-settings",
    operationId: "putGitHubSettings",
    tag: "Workspace settings",
    summary: "Change the workspace's GitHub ceiling (owner or admin)",
    description:
      "Replaces the ceiling. `revision` is the one last read; a stale one is 409 `REVISION_CONFLICT` and nothing changes. Lowering a feature refuses it from the next GitHub token on (409 `GITHUB_REFUSED` `over_workspace_ceiling`), for sessions of every release that turns it on; raising it lets the same releases use it again. `merge` is read on every merge call, so turning it on needs no new release and applies from the next call, and turning it off refuses the next call with `GITHUB_REFUSED` `merge_off` before GitHub is called; a body without `merge` saves it as false. Writes a `set_github_ceiling` receipt with the ceiling before and after. API keys are refused.",
    auth: "session",
    body: "PutGitHubSettingsRequest",
    requestExample: {
      ceiling: {
        workflows: false,
        actions: true,
        checks: false,
        issues: false,
        review: false,
        merge: true,
      },
      revision: 2,
    },
    success: {
      status: 200,
      schema: "GitHubSettingsResponse",
      description: "Stored; the settings as GET now answers them.",
      example: {
        ceiling: {
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
          merge: true,
        },
        revision: 3,
        agents_using: {
          workflows: 0,
          actions: 2,
          checks: 0,
          issues: 0,
          review: 0,
        },
        oauth: {
          client_id: "Iv23liExampleClientId",
          client_secret_set: true,
          callback_url:
            "https://console.example.com/settings/linked-accounts/github",
        },
        pull_request: EXAMPLE_PULL_REQUEST_SETTINGS,
        pull_request_revision: 0,
        connections: [EXAMPLE_GITHUB_CONNECTION],
        apps: { author: { permissions: null }, reviewer: null },
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-settings/pull-request",
    operationId: "putGitHubPullRequestSettings",
    tag: "Workspace settings",
    summary:
      "Change how the workspace's pull request bodies are laid out (owner or admin)",
    description:
      "Replaces `formatting` (`off` leaves every template out, so the fields land on the platform's default layout), `template_mode` (`repository_first`: the repository's template, else `default_template`; `override`: `default_template` always, the repository's is not read), `default_template` (markdown up to 16 KiB, or null for the platform's default) and `session_link` (`id` leaves the console's address out of the pull request tail and the `Agent-Session` trailer). `revision` is `pull_request_revision` as last read; a stale one is 409 `REVISION_CONFLICT` and nothing changes. It is separate from the ceiling's `revision`. A template the platform will not lay text around is 400 with `reason_code` `template_too_large`, `template_not_utf8` or `template_unsupported`. A change reaches pull requests opened or updated afterwards and commits made after a worker's next claim; text already on GitHub is not rewritten. Writes a `set_github_pull_request_settings` receipt with the values before and after (a template as its size and hash, never its text); `receipt_id` is null when nothing changed. API keys are refused.",
    auth: "session",
    body: "PutGitHubPullRequestSettingsRequest",
    requestExample: {
      pull_request: {
        formatting: "on",
        default_template: null,
        template_mode: "repository_first",
        session_link: "id",
      },
      revision: 0,
    },
    success: {
      status: 200,
      schema: "PutGitHubPullRequestSettingsResponse",
      description: "Stored; the settings and their new revision.",
      example: {
        pull_request: {
          formatting: "on",
          default_template: null,
          template_mode: "repository_first",
          session_link: "id",
        },
        pull_request_revision: 1,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/slack/apps",
    operationId: "listWorkspaceSlackApps",
    tag: "Workspace settings",
    summary: "List the Slack apps this console made in the workspace",
    description:
      "Every agent app and the account-link app the platform made here and still keeps (`creating`, `created` or `deleting`): the link app first, then agent apps by agent name. Manual apps and ones failed, abandoned or deleted are left out. Each agent app names its agent and whether the agent's bot is installed now. Owners and admins only; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "ListWorkspaceSlackAppsResponse",
      description: "The made apps; secrets only as whether each is stored.",
      example: {
        items: [
          {
            slack_app: EXAMPLE_SLACK_APP,
            agent: {
              id: EXAMPLE_SLACK_APP.agent_id,
              name: "Release notes",
              slug: "release-notes",
              installed: true,
            },
          },
        ],
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "When the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-settings/oauth-client-secret",
    operationId: "putGitHubOAuthClientSecret",
    tag: "Workspace settings",
    summary:
      "Set the author App's client secret for user linking (owner or admin)",
    description:
      "Stores the client secret of the author GitHub App people link their accounts with (`oauth.connection_id`), made in GitHub under the App's settings, so people can link their GitHub account. It is kept encrypted like the App's private key and never returned, logged or echoed; the answer carries only whether one is set. Setting it again replaces it. Registering a different App, or deleting the author App, drops it. Refused with 409 `GITHUB_LINK_NOT_CONFIGURED` (`reason_code` `no_author_app`) while the workspace has no author App. `client_id` names the App the secret was made for, as `oauth.client_id` showed it; when the author App's client id is another one by the time the secret is stored (the App was replaced meanwhile), nothing is stored and the answer is 409 `REVISION_CONFLICT` (`reason_code` `github_app_changed`). Writes a `set_github_app` receipt with the secret's last four characters. Does not change the ceiling's `revision`. API keys are refused.",
    auth: "session",
    body: "PutGitHubOAuthClientSecretRequest",
    requestExample: {
      client_id: "Iv23liExampleClientId",
      client_secret: "<client-secret-from-github>",
    },
    success: {
      status: 200,
      schema: "PutGitHubOAuthClientSecretResponse",
      description: "Stored; the receipt and the user-linking state.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        oauth: {
          client_id: "Iv23liExampleClientId",
          client_secret_set: true,
          callback_url:
            "https://console.example.com/settings/linked-accounts/github",
        },
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["GITHUB_LINK_NOT_CONFIGURED", "REVISION_CONFLICT"] },
    errorNotes: {
      BACKEND_UNAVAILABLE: "Also when the API runs without a secret key.",
    },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-settings/user-link-app",
    operationId: "putGitHubUserLinkApp",
    tag: "Workspace settings",
    summary:
      "Choose the author App people link their GitHub accounts with (owner or admin)",
    description:
      "Names the author connection (`connection_id`) whose OAuth client people link their accounts with. The client secret belongs to that connection: after a change, `oauth.client_secret_set` is that connection's, so a secret may need setting again (`PUT …/oauth-client-secret`). A link started before the change cannot finish with the old connection's state. A reviewer connection is 400 `role_mismatch`; an unknown one 404. Writes a `set_github_app` receipt with the connection before and after; `receipt_id` is null when nothing changed. API keys are refused.",
    auth: "session",
    body: "PutGitHubUserLinkAppRequest",
    requestExample: { connection_id: "019a0000-0000-7000-8000-0000000000c9" },
    success: {
      status: 200,
      schema: "PutGitHubUserLinkAppResponse",
      description: "Stored; the receipt and the user-linking state.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        oauth: {
          connection_id: "019a0000-0000-7000-8000-0000000000c9",
          client_id: "Iv23liExampleClientId",
          client_secret_set: false,
          callback_url:
            "https://console.example.com/settings/linked-accounts/github",
        },
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE: "Also when the API runs without a secret key.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-packages",
    operationId: "getGitHubPackages",
    tag: "Workspace settings",
    summary:
      "The workspace's GitHub Packages bot token and allowlist (members)",
    description:
      "What sessions may fetch from GitHub Packages (npm and RubyGems) through the egress proxy. `token` says whether a bot token is registered, with its last four characters, the GitHub login it belongs to and its expiry (`expires_at` null when it never expires), never the value. `allowlist` lists each owner's package, or every package of an owner (`name` `*`), that sessions may read; an entry with `repository_id` or `agent_id` applies only to sessions of that repository or agent. Without a token, or for a package no entry names, the proxy refuses the request. `revision` is 0 until the allowlist is first saved. Any member signed in to the console reads it; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GitHubPackagesSettingsResponse",
      description: "The token's summary and the allowlist.",
      example: {
        token: {
          configured: true,
          last4: "x9Qa",
          login: "acme-packages-bot",
          expires_at: "2027-01-30T00:00:00.000Z",
          updated_at: "2026-11-01T09:00:00.000Z",
          updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Mina" },
        },
        allowlist: [
          {
            registry: "npm",
            owner: "acme",
            name: "*",
            repository_id: null,
            agent_id: null,
          },
        ],
        revision: 1,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-packages/token",
    operationId: "putGitHubPackagesToken",
    tag: "Workspace settings",
    summary:
      "Register or replace the GitHub Packages bot token (owner or admin)",
    description:
      "Stores a bot account's classic personal access token whose only scope is `read:packages`; GitHub Packages accepts no GitHub App token. Before storing, the API calls GitHub's `GET /user` with it: a token GitHub refuses is 400 `BAD_REQUEST` (`reason_code` `token_invalid`), and one with any other scope, or a fine-grained token, which has no classic scopes, is 400 (`reason_code` `token_scopes`). The login and expiry GitHub reports are kept beside it. The token is kept encrypted and never returned, logged or echoed; only the egress proxy's requests to GitHub Packages carry it. Setting it again replaces it. Writes a `set_github_packages_token` receipt with its last four characters. API keys are refused.",
    auth: "session",
    body: "PutGitHubPackagesTokenRequest",
    requestExample: { token: "ghp_EXAMPLE" },
    success: {
      status: 200,
      schema: "GitHubPackagesWriteResponse",
      description: "Stored; the receipt and the settings.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        token: {
          configured: true,
          last4: "MPLE",
          login: "acme-packages-bot",
          expires_at: "2027-01-30T00:00:00.000Z",
          updated_at: "2026-11-01T09:00:00.000Z",
          updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Mina" },
        },
        allowlist: [],
        revision: 0,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "When GitHub cannot be asked about the token, or the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/github-packages/token",
    operationId: "deleteGitHubPackagesToken",
    tag: "Workspace settings",
    summary: "Remove the GitHub Packages bot token (owner or admin)",
    description:
      "Drops the stored token; from the next request on, the proxy refuses every GitHub Packages request. The allowlist stays. Writes a `delete_github_packages_token` receipt with the token's last four characters; 404 when none is stored. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GitHubPackagesWriteResponse",
      description: "Removed; the receipt and the settings.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        token: {
          configured: false,
          last4: null,
          login: null,
          expires_at: null,
          updated_at: null,
          updated_by: null,
        },
        allowlist: [],
        revision: 0,
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "When the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-packages/allowlist",
    operationId: "putGitHubPackagesAllowlist",
    tag: "Workspace settings",
    summary: "Replace the GitHub Packages allowlist (owner or admin)",
    description:
      "Replaces the whole allowlist, at most 200 entries. Each entry names a registry (`npm` or `rubygems`), a GitHub owner and a package name or `*`; `repository_id` (a catalog repository id) or `agent_id` narrows it to sessions of that repository or agent. Owners compare case-insensitively. `revision` is the one last read: a stale one is 409 `REVISION_CONFLICT`. Takes effect from the next request; a session's npm scopes and gem sources follow the owners named here from its next claim. Writes a `set_github_packages_allowlist` receipt. API keys are refused.",
    auth: "session",
    body: "PutGitHubPackagesAllowlistRequest",
    requestExample: {
      allowlist: [
        {
          registry: "rubygems",
          owner: "acme",
          name: "acme-auth",
          repository_id: "billing",
          agent_id: null,
        },
      ],
      revision: 0,
    },
    success: {
      status: 200,
      schema: "GitHubPackagesWriteResponse",
      description: "Stored; the receipt and the settings.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        token: {
          configured: false,
          last4: null,
          login: null,
          expires_at: null,
          updated_at: null,
          updated_by: null,
        },
        allowlist: [
          {
            registry: "rubygems",
            owner: "acme",
            name: "acme-auth",
            repository_id: "billing",
            agent_id: null,
          },
        ],
        revision: 1,
      },
    },
    errors: [400, 401, 403, 404, 409, 413],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/slack/apps/{app_id}",
    operationId: "deleteSlackApp",
    tag: "Workspace settings",
    summary: "Delete one of the workspace's Slack apps in Slack",
    description:
      "Deletes the app in Slack (`apps.manifest.delete` with the config token) and its stored secrets; the row stays as `deleted`. Only an app recorded in this workspace's Slack apps can be named. An agent's app takes an owner, an admin or that agent's admin; any other app an owner or admin. An app Slack no longer has counts as deleted. One still being created answers 409 SLACK_APP_CREATING. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteSlackAppResponse",
      description:
        "Deleted in Slack, or already gone there; the app as now stored, its secrets dropped.",
      example: {
        slack_app: {
          ...EXAMPLE_SLACK_APP,
          state: "deleted",
          secrets: {
            slack_signing_secret: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
            slack_client_secret: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
            slack_bot_token: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
          },
        },
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID", "SLACK_APP_CREATING"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached or refused; the app stays `deleting` and the same request retries it.",
    },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}",
    operationId: "putSlackAppSecret",
    tag: "Workspace settings",
    summary: "Set a secret of a Slack app made by hand (owner or admin)",
    description:
      "`purpose` is `slack_signing_secret`, `slack_client_secret` or `slack_bot_token`. Only an app of kind `manual` takes values from a person: the platform writes the secrets of the apps it created (403 `server_managed_secret`), since whoever knew an app's signing secret could sign events as Slack. The value is stored encrypted under the app; the response and the `set_slack_secret` receipt carry its last four characters only. API keys are refused.",
    auth: "session",
    body: "PutSlackSecretRequest",
    requestExample: { value: "<value-from-api.slack.com>" },
    success: {
      status: 200,
      schema: "PutSlackSecretResponse",
      description: "Stored; its summary and the receipt.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    errorNotes: {
      BAD_REQUEST:
        "Also when `app_id` is not a UUID or `purpose` is not one of the three, `slack_config_token` included.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/logout",
    operationId: "logout",
    tag: "Auth",
    summary: "Revoke the session cookie",
    description:
      "Revokes the cookie session that sent the request and clears the cookie. The user's other sessions stay signed in.",
    auth: "session",
    success: {
      status: 204,
      description: "The session is revoked and the cookie cleared.",
    },
    errors: [401, 403, 503],
    errorNotes: {
      FORBIDDEN: "Also when the caller is not a cookie session (an API key).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/me",
    operationId: "getAuthMe",
    tag: "Auth",
    summary: "The authenticated principal, user and workspace",
    description:
      "Says who the credential authenticates as and what it may do: the principal with its scopes, the workspace, and for a cookie session the user and the management actions its role holds (`permissions`). An API key has no user, so `user` is null and `permissions` is empty; `workspace` is the key's workspace, or null for a legacy key that predates workspaces. The web app boots from this. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "AuthMeResponse",
      description: "The authenticated principal; `scopes` is what it may do.",
      example: {
        principal: {
          kind: "user",
          id: EXAMPLE_USER_ID,
          workspace_id: EXAMPLE_WORKSPACE.id,
          role: "owner",
          scopes: ALL_SCOPES,
        },
        user: {
          id: EXAMPLE_USER_ID,
          email: "owner@example.com",
          display_name: "Ada Owner",
          locale: "ko",
        },
        workspace: EXAMPLE_WORKSPACE,
        scopes: ALL_SCOPES,
        permissions: [
          "workspace.manage",
          "audit_retention.manage",
          "member.manage",
          "team.manage",
          "api_key.manage",
          "api_key.manage_own",
          "account.link",
          "agent.create",
          "agent.manage",
          "agent.restore",
          "agent.admin.manage",
          "credential.bind",
          "binding.manage",
          "session.audit_read",
          "session.admin_list",
          "usage.installation_read",
          "usage.agent_read",
          "profile.installation.manage",
          "profile.define",
          "installation.settings.manage",
        ],
      },
    },
    errors: [401, 503],
    errorNotes: {
      UNAUTHORIZED: "Also when the session's workspace no longer exists.",
    },
  },
  {
    method: "patch",
    path: "/v1/auth/me",
    operationId: "updateAuthMe",
    tag: "Auth",
    summary: "Save the signed-in user's language",
    description:
      "Saves `locale` (`ko`, `ja` or `en`) on the signed-in user: what `user.locale` in GET /v1/auth/me returns and the language the user's Slack notices are written in. Slack's ephemeral notices follow the reader's language; a thread's replies and notices follow the language of whoever started the session. A user who never saved one reads English.",
    auth: "session",
    body: "UpdateAuthMeRequest",
    requestExample: { locale: "en" },
    success: { status: 204, description: "The language is saved." },
    errors: [400, 401, 403, 413, 503],
    errorNotes: {
      FORBIDDEN: "Also when the caller is not a cookie session (an API key).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tag: "Sessions",
    summary: "Durably accept a session and its first input",
    description:
      "Creates a session for a catalog profile and repository and queues `message` as turn `1`. Whether `repository_id` is sent follows the profile's `repository_mode` (`GET /v1/profiles`): where the catalog judges the pair, `none` refuses it, `optional` takes either, and `required` needs it. A session on the agent's own GitHub settings (the agent has a settings row) or on a workspace-scoped profile is judged by the workspace ceiling and the agent's list instead, and may start without one whatever the mode. A repository named here is checked against the agent's GitHub settings list where those apply and against the workspace ceiling where the profile uses it, else 403 GITHUB_REFUSED. A session created without one starts in an empty workspace, has no default push target (`POST /v1/sessions/{id}/push-requests` must name an attached repository, else it answers 409 PUSH_SOURCE_MISSING) and its detail's `repository_id` is null. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. `model` picks one of the models the profile offers (its `model` or `models` in the catalog); omitted, the model of the release's card runs when `agent_release_id` is sent, else the profile's default. The session's detail reports it as `model`. The model stays until the session's profile is changed (`POST /v1/sessions/{id}/profile`), which runs the new profile's default. A session waits in `queued` while no execution slot is free; it is never refused for that. `agent_release_id` pins the session to that release of an agent, so a key bound to the agent may create it (it reads the agent's `active_release_id` from `GET /v1/agents`);`profile_id` may then be omitted for the release's runtime profile, and sent it must be that profile (409 RELEASE_PROFILE_MISMATCH). Omitted, an agent with GitHub settings starts without a repository and attaches what it needs, and an agent with none uses the release's `repository_id`. A release whose profile is no longer in the catalog, or changed since, answers 409 PROFILE_DIGEST_MISMATCH. A profile the operator blocked, or a workspace profile over a blocked one, answers 409 PROFILE_BLOCKED, with a release or without. A private agent (`GET /v1/agents/{id}/usage`) is used only by the members of its teams, the workspace's owners and admins, its admins and the members of its managing team; for anyone else its release answers 404, the very answer of a release that does not exist, before the integrity, profile and state refusals below and whatever else the caller lacks (a key without the scope, or bound to another agent, or a Slack channel past its ceiling, included). An agent that is paused or archived answers 409 AGENT_NOT_RUNNABLE with `details.reason_code` `agent_inactive`, and a release no activation ever approved answers it with `release_unapproved`; an older release that was approved still starts while the agent is active, and a retry of a session made earlier gets its first answer. Every credential the release names must still be bound to its agent; otherwise 409 CREDENTIAL_UNBOUND, whose `details` carry the guidance to show the requester and the agent's admins to ask (`SessionCredentialUnboundDetails`), never the missing names. The caller limits of the agent (`GET /v1/agents/{id}/caller-limits`) that reach the caller are merged (the workspace's, those of the teams the caller is in, and the Slack channel's) and fixed on the session as `caller_limit`; a start whose repository falls outside the merged `repositories`, or whose credentials the merged `credentials_deny` names, answers 403 `FORBIDDEN` with `details` `{reason_code: caller_limited, dimension: repository | credential}` and no session. The write merges the limits again under lock, and its result wins over a rule changed since. The receipt settles with turn `1`: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
    scope: "write",
    body: "CreateSessionRequest",
    requestExample: {
      profile_id: "claude-coding-real",
      repository_id: "sample-app",
      message: "Add a health check endpoint and a test for it.",
    },
    success: {
      status: 201,
      schema: "CreateSessionResponse",
      description:
        "The session and its first turn are stored; `receipt_id` tracks the acceptance.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        turn_id: "1",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
        status: "queued",
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 422, 429, 503],
    errorCodes: {
      400: ["BAD_REQUEST", "PERMISSION_WAIT_ABOVE_PROFILE"],
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "RELEASE_PROFILE_MISMATCH",
        "PROFILE_DIGEST_MISMATCH",
        "PROFILE_BLOCKED",
        "AGENT_NOT_RUNNABLE",
        "CREDENTIAL_UNBOUND",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      BAD_REQUEST:
        "A body its schema refuses, `profile_id` missing without `agent_release_id` included, names each field at fault in `details.issues` (`RequestBodyInvalidDetails`).",
      PERMISSION_WAIT_ABOVE_PROFILE:
        "A `permission_wait` value is longer than the profile's (`GET /v1/profiles`).",
      GITHUB_REFUSED:
        "`repository_not_allowed`: the agent's GitHub settings cannot be read, they do not list `repository_id`, the workspace ceiling does not allow the session's repository (one named, or the release's when the agent has no settings), or one of `attached_repository_ids` is the session's own repository, not listed there, or not allowed for the profile, or the list was sent for a session without an agent release, or for a profile whose `repository_mode` is `none` when the agent has no GitHub settings. No receipt is written: `details.receipt_id` is null.",
      UNSUPPORTED_CAPABILITY:
        "`profile_id` or `repository_id` is not in the catalog, the catalog does not allow the pair, the profile does not offer `model`, where the catalog judges the pair, `repository_id` is missing for a profile whose `repository_mode` is `required` (`Profile <id> needs a repository: send repository_id`), or sent for one whose `repository_mode` is `none` (`Profile <id> runs without a repository: omit repository_id`).",
      RATE_LIMITED:
        "Reserved here: the per-session input queue limit applies to later messages, not to the first, so this operation does not currently return it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tag: "Sessions",
    summary: "List the owner's sessions, newest first",
    description:
      "Lists the sessions of the credential's owner that the caller can read, newest `created_at` first, closed ones included, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `status` keeps only sessions reporting that status, `needs_input` included; `relation` keeps the ones the caller started, was shared or administers the agent of; `q` searches titles and id prefixes; `agent_id` keeps the sessions of one agent, any of its releases. Every filter only narrows what the caller can read. It changes nothing.",
    scope: "read",
    query: "ListSessionsQuery",
    success: {
      status: 200,
      schema: "ListSessionsResponse",
      description: "One page of session summaries.",
      example: {
        items: [EXAMPLE_SESSION_SUMMARY],
        next_cursor: null,
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/counts",
    operationId: "countSessions",
    tag: "Sessions",
    summary: "Count the sessions a list would return, per status",
    description:
      "Counts, for each status, the sessions `GET /v1/sessions` would list with that `status` and the same `relation` and `q` when read to its last page; `total` is their sum. A session the caller cannot read is never counted. It changes nothing.",
    scope: "read",
    query: "CountSessionsQuery",
    success: {
      status: 200,
      schema: "CountSessionsResponse",
      description: "The number of sessions per status.",
      example: {
        counts: {
          queued: 0,
          running: 2,
          needs_input: 1,
          idle: 5,
          failed: 1,
          stopped: 3,
        },
        total: 12,
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    tag: "Sessions",
    summary: "Session detail with projection, execution and durability",
    description:
      "Reads one session: its `admission_state` (whether it takes input and controls: `active`, `pausing`, `paused`, `resuming`, `stopping`, `stopped`, `recovery_required`, `closing`, `closed`), its `status`, the current `revision`, the execution as last observed, the number of pending requests, `attention` (why the session is held or slowed, if it is) and checkpoint `durability`. Read `revision` here and send it as `expected_revision` to pause, resume, close, terminate or decide recovery. `status: needs_input` and `attention` are computed on each read; reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionDetail",
      description: "The session as it stands now.",
      example: EXAMPLE_SESSION_DETAIL,
    },
    errors: [401, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/sessions/{id}",
    operationId: "updateSession",
    tag: "Sessions",
    summary: "Rename the session",
    description:
      "Sets `title`, in any admission state; the session's `revision` does not change and no receipt is written. Allowed to the session's creator (for a session an API key made, that key), the workspace's owners and admins, and the admins of its agent; since the answer is the session's detail, a key also needs `sessions:read`. Anyone else the session is visible to, through its share, gets 403; anyone it is not visible to, 404. A changed title is a `status` event on the stream carrying `title`; naming the title the session already has writes none. Answers with the session as `GET /v1/sessions/{id}` reads it.",
    scope: "write",
    body: "UpdateSessionRequest",
    requestExample: { title: "Fix the flaky checkout test" },
    success: {
      status: 200,
      schema: "SessionDetail",
      description: "The session with its new title.",
      example: EXAMPLE_SESSION_DETAIL,
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/share",
    operationId: "getSessionShare",
    tag: "Sessions",
    summary: "Who sees the session",
    description:
      "Readable by whoever sees the session. A session never re-shared reads `workspace` at revision 0. `audience_limited` is true when `workspace` does not reach every member: the session is an agent's, the agent is not held by the 'Unassigned agents' team of migration 0243, and the workspace's `agent_outsider_session_visibility` is `managing_team`, so only those inside the agent see it (PATCH /v1/workspaces/{id}/agent-access).",
    scope: "read",
    success: { status: 200, schema: "SessionShare" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/share",
    operationId: "setSessionShare",
    tag: "Sessions",
    summary: "Change who sees the session",
    description:
      "`private` is the creator alone; `people` and `team` add the people or the current members of the teams named; `workspace` is every member, or only those inside the agent while `audience_limited` holds (GET /v1/sessions/{id}/share). A person's session is changed only by its creator; a session an API key made, by owners, admins and the admins of its agent. Anyone else the session is visible to gets 403; anyone it is not visible to, 404. Open event streams that may no longer see the session end. Writes a `share_session` receipt unless the share was already as asked (`receipt_id` null).",
    auth: "session",
    body: "SetSessionShareRequest",
    success: { status: 200, schema: "SetSessionShareResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/audit-read",
    operationId: "auditReadSession",
    tag: "Admin",
    summary: "Read a session outside its share, with a reason",
    description:
      "Owners and admins. The session detail and a page of its turns, whatever the share; nothing on the session changes and no other action is opened by it. Every read is recorded with its `justification`.",
    auth: "session",
    body: "AuditReadRequest",
    success: { status: 200, schema: "AuditReadResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/admin/sessions",
    operationId: "listAdminSessions",
    tag: "Admin",
    summary: "Every session of the workspace, metadata only",
    description:
      "Owners and admins. Who made each session, its agent release, state and share scope, newest first; no content, title or summary.",
    auth: "session",
    success: { status: 200, schema: "ListAdminSessionsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/terminate",
    operationId: "adminTerminateSession",
    tag: "Admin",
    summary: "Stop any session of the workspace, with a reason",
    description:
      "Owners and admins, whatever the session's share. The `justification` is recorded with the decision and becomes the stop reason. Otherwise as `POST /v1/sessions/{id}/terminate`.",
    auth: "session",
    body: "AdminTerminateSessionRequest",
    success: { status: 202, schema: "TerminateSessionResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/recovery-decisions",
    operationId: "adminDecideSessionRecovery",
    tag: "Admin",
    summary: "Decide recovery for any session of the workspace",
    description:
      "Owners only, whatever the session's share. The decision's `reason` is the justification, recorded with the decision. Otherwise as `POST /v1/sessions/{id}/recovery-decisions`.",
    auth: "session",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    tag: "Sessions",
    summary: "Estimated cost of a session and whether every turn reported it",
    description:
      "Reads the session's estimated provider cost and token count over its lifetime, its cost and token limits, and its queued input against the per-session limit. The cost is the platform's estimate from the model calls it saw, not a bill. `cost.complete: false` means a turn is still open or ended without reporting, so the true total is unknown; do not read it as zero. `budget_exceeded: true` means either limit is reached: no new turn is dispatched, but input is still accepted and queued. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionUsageResponse",
      description: "The session's usage as of `refreshed_at`.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        period: "session_lifetime",
        refreshed_at: "2026-10-11T08:15:43Z",
        cost: {
          amount_usd: "0.4231",
          kind: "estimated",
          source: "provider_usage",
          completeness_scope: "turn_reports",
          complete: false,
          reported_turn_count: 2,
          unreported_turn_count: 0,
          open_turn_count: 1,
        },
        cost_limit_usd: "20",
        token_count: 182450,
        token_limit: null,
        budget_exceeded: false,
        queued_input_count: 1,
        queued_input_limit: 20,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/outputs",
    operationId: "listSessionOutputs",
    tag: "Sessions",
    summary: "Files the session left under out/ at its latest checkpoint",
    description:
      "Lists the files under the workspace's `out/` directory as the session's latest committed checkpoint recorded them: `path` (relative to the workspace, starting with `out/`), `bytes` and `sha256`. A file over the output limits is listed with `omitted: too_large` and `sha256: null`; its bytes were not kept, so it cannot be downloaded. A file written after the latest checkpoint is not listed until the next one commits. A session with no committed checkpoint answers an empty list with `checkpoint_revision: null`. Download a listed file with `GET /v1/sessions/{id}/outputs/{path}`. Reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListSessionOutputsResponse",
      description: "The outputs of the session's latest committed checkpoint.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        checkpoint_revision: 2,
        items: [
          {
            path: "out/report.md",
            bytes: 2048,
            sha256:
              "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            omitted: null,
          },
          {
            path: "out/recording.mp4",
            bytes: 734003200,
            sha256: null,
            omitted: "too_large",
          },
        ],
      },
    },
    errors: [401, 404, 409, 503],
    errorCodes: { 409: ["CHECKPOINT_UNAVAILABLE"] },
    errorNotes: {
      CHECKPOINT_UNAVAILABLE:
        "The latest checkpoint's manifest is missing, damaged or unreadable; `message` names it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/outputs/{path}",
    operationId: "downloadSessionOutput",
    tag: "Sessions",
    summary: "Download one file the session left under out/",
    description:
      "Streams one file that `GET /v1/sessions/{id}/outputs` lists, as `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. `{path}` is the listed `path` exactly, percent-encoded as one path segment (`out/report.md` is `out%2Freport.md`). The bytes are the ones the checkpoint verified; if the store no longer holds them the transfer ends early with an error rather than completing with other bytes, so check the length (or `sha256`) of what arrived. A path the list does not name, a file listed with `omitted`, or a session with no committed checkpoint answers 404.",
    scope: "read",
    success: {
      status: 200,
      download: true,
      description: "The file's bytes.",
    },
    errors: [401, 404, 409, 503],
    errorCodes: { 409: ["CHECKPOINT_UNAVAILABLE"] },
    errorNotes: {
      NOT_FOUND:
        "Also when the path is not listed, is listed as `omitted`, or the session has no committed checkpoint.",
      CHECKPOINT_UNAVAILABLE:
        "The latest checkpoint's manifest or this file's stored object is missing, damaged or unreadable; `message` names it.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "appendSessionMessage",
    tag: "Messages & turns",
    summary: "Enqueue the next input after the current turn",
    description:
      "Queues `message` as the session's next turn in the same engine conversation, after every turn already queued. Only an `active` session takes input; the other admission states answer the 409 codes below. The 202 means the input is stored under a new sequential `turn_id`, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or on the event stream. A session over its budget still queues input but runs no new turn (`attention.code: BUDGET_EXCEEDED`). The receipt settles with the turn: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown. A caller who sees the session but may not use its private agent (`GET /v1/agents/{id}/usage`) is refused with 403 `FORBIDDEN`, `reason_code` `agent_private`, and no one to ask; a retry of an input taken before they lost the agent still gets its stored answer. A sender whose caller limits (`GET /v1/agents/{id}/caller-limits`) leave out something the session loads, after the limit the session was created under took its part away, is refused with 403 `FORBIDDEN`, `reason_code` `caller_limited` and `details.dimension` (`tool`, `mcp_server`, `repository` or `credential`); a rule change counts from the next input.",
    scope: "write",
    body: "PostSessionMessageRequest",
    requestExample: { message: "Now add the endpoint to the README." },
    success: {
      status: 202,
      schema: "PostSessionMessageResponse",
      description: "The input is stored as a queued turn.",
      example: {
        turn_id: "4",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 422, 429, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
        "TAKEOVER_REQUIRED",
        "PROFILE_BLOCKED",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "A failed session that has no runtime spec pinned on its own model, which it needs to run again once specs are authoritative; nothing is queued.",
      RATE_LIMITED:
        "The session already holds the installation's maximum of queued inputs; `Retry-After` is 5.",
      PROFILE_BLOCKED:
        "The operator blocked the session's profile, or the installation profile its workspace profile narrows; nothing is queued. The session's `attention` says the same, and it takes messages again once the operator unblocks it.",
      CHECKPOINT_UNAVAILABLE:
        "A pending checkpoint problem holds new work, so a new turn could not be checkpointed; `message` names it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listSessionTurns",
    tag: "Messages & turns",
    summary: "Queued and finished turns",
    description:
      "Lists the session's turns oldest first, in `turn_id` order: queued, running and finished, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. Items are summaries; read one turn for its result, usage and attempts. It changes nothing.",
    scope: "read",
    query: "ListTurnsQuery",
    success: {
      status: 200,
      schema: "ListTurnsResponse",
      description: "One page of turn summaries.",
      example: {
        items: [
          EXAMPLE_TURN_SUMMARY,
          {
            ...EXAMPLE_TURN_SUMMARY,
            turn_id: "2",
            status: "running",
            message: "Now add the endpoint to the README.",
            checkpoint_revision: null,
            created_at: "2026-10-11T08:14:00Z",
            started_at: "2026-10-11T08:14:02Z",
            ended_at: null,
          },
        ],
        next_cursor: null,
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns/{turn_id}",
    operationId: "getSessionTurn",
    tag: "Messages & turns",
    summary: "Committed result of one turn",
    description:
      "Reads one turn: its status, terminal reason, the engine's committed `result` and `usage`, and the worker attempts that ran it. This is the durable answer to whether a turn finished: `completed`, `failed`, `interrupted`, `cancelled` and `outcome_unknown` are terminal. `completed` means the engine ended the turn normally, not that the requested work is done. `result` and `usage` are null until the turn ends, and their shape is the runtime's. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "TurnDetail",
      description: "The turn as it stands now.",
      example: {
        ...EXAMPLE_TURN_SUMMARY,
        result: {
          type: "result",
          subtype: "success",
          result: "Added GET /health and a test for it.",
        },
        usage: { input_tokens: 48210, output_tokens: 3120 },
        attempts: [
          {
            attempt_id: "att_01",
            state: "exited",
            lease_epoch: 1,
            execution_generation: 1,
            started_at: "2026-10-11T08:00:05Z",
            ended_at: "2026-10-11T08:03:12Z",
            profile_id: "claude-coding-real",
          },
        ],
      },
    },
    errors: [401, 404, 503],
    errorNotes: {
      NOT_FOUND: "Also when `turn_id` names no turn of the session.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "streamSessionEvents",
    tag: "Events",
    summary: "Durable event replay and live stream (SSE)",
    description:
      "Streams the session's events as Server-Sent Events: first the stored events after `Last-Event-ID` (all of them without it), then new ones as they are written. Each frame's `id` is its cursor, `event` its kind (`system`, `assistant`, `tool_use`, `tool_result`, `question`, `result`, `status`, `error`), and `data` a versioned envelope naming the session, turn and attempt. Frames arrive in `id` order, the order to rely on; a new event's `occurred_at` is no earlier than the one before it. An event the engine emits after its turn's terminal belongs to no turn (`turn_id` null). `question` events announce pending requests; `status` events report the session's status and, after a pause, resume, terminate or recovery decision, its `admission_state`. `system` events with a platform `subtype` are the control plane's own: `session_closed` when a close commits, and `input_wait` with `stage` (`parked` when a turn parks on its unanswered requests, `expired` when a parked turn's requests expire, `lost` when the worker holding them went away unanswered) and the `request_ids` it covers. The stream does not end with a turn or the session: it stays open until the client disconnects, the credential is revoked, or the session's share stops covering the caller (the reconnect then answers 404). Reading changes nothing.\n\nReconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.",
    scope: "read",
    lastEventId: true,
    success: {
      status: 200,
      schema: "SseEvent",
      sse: true,
      description:
        "`text/event-stream`: one frame per event, each an `id:`, an `event:` and a `data:` line, with the envelope as JSON on the `data:` line.",
      example: {
        id: "ev_2s",
        event: "status",
        data: {
          schema_version: 1,
          session_id: EXAMPLE_SESSION_ID,
          turn_id: "2",
          attempt_id: "att_01",
          occurred_at: "2026-10-11T08:14:02Z",
          data: { phase: "running" },
        },
      },
    },
    // 410 CURSOR_EXPIRED is declared for clients but never produced in alpha:
    // events are not trimmed (api.md § 이벤트).
    errors: [400, 401, 404, 410, 429, 503],
    errorNotes: {
      RATE_LIMITED:
        "This owner already has 8 open streams, or the process 256; `Retry-After` is 15.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/pending-requests",
    operationId: "listPendingRequests",
    tag: "Pending requests",
    summary: "Open permission and question requests",
    description:
      "Lists the permission and question requests the session waits on that a client can still answer, oldest first: open, unexpired, and either raised by the worker attempt that holds the running turn (`state: waiting`) or parked (`state: parked`). A request nobody answers by `park_at` has its turn parked: the platform stops the turn with its checkpoint and pauses the session, and the request stays answerable until `expires_at` whatever happened to the worker that asked. Requests of one `group` resume their turn together. A `permission` item names the `tool` and its `input`; a `question` item carries the questions and their option ids. Answer before `expires_at` with `POST /v1/sessions/{id}/answers`. New requests also arrive as `question` events on the event stream. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPendingRequestsResponse",
      description: "Every request that can be answered now; empty when none.",
      example: {
        items: [
          {
            request_id: "req_7f3a",
            turn_id: "2",
            attempt_id: "att_01",
            created_at: "2026-10-11T08:14:30Z",
            expires_at: "2026-10-12T08:14:30Z",
            state: "waiting",
            park_at: "2026-10-11T08:44:30Z",
            group: "2",
            kind: "permission",
            tool: "Bash",
            input: { command: "npm test", description: "Run the tests" },
          },
        ],
        answerable: true,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/answers",
    operationId: "answerPendingRequest",
    tag: "Pending requests",
    summary: "Answer a pending permission or question request",
    description:
      "Answers one pending request by `request_id`: a permission with `action` `allow` or `deny` (a denial needs a `reason` the model can act on), a question with one answer per question, by option ids or free text where the question allows it. The answer is stored and the request closes at once: the pending list drops it and a `status` event ends the wait. The worker then hands the answer to the engine, and the receipt settles when it reports: `succeeded` once delivered, `failed` if the request expired (`REQUEST_EXPIRED`) or was cancelled (`REQUEST_STALE`, with why in its message: an interrupt, a park, a shutdown, the worker refusing the answer, or the engine having closed the request already) first, `unknown` if the execution ended before it reported or the engine no longer knew the request, so it may or may not have acted on the answer.\n\nA parked request (`state: parked`) is answered the same way, whichever worker asked. The answer is kept until every request of its `group` is answered or expired; the one that closes the group resumes the session (`resumed: true`), and the receipt settles once the turn that resumes it has the answer. `waiting_for` counts the group's requests still open. A session paused by a person rather than by its park keeps the answer and stays paused.\n\nSeeing a session is not answering for it: only its creator, its agent's admins, the workspace's owners and admins, and the keys of its agent that hold `sessions:approve` answer. Anyone else the session is visible to gets 403 (`reason_code: role`) and the request stays open; anyone it is not visible to, 404. No workspace key (personal or agent) answers a session that key started: 403 (`reason_code: self_approval`) with a failed `answer` receipt named by `error.details.receipt_id`, and the request stays open for another key or a person.",
    scope: "approve",
    body: "PostSessionAnswerRequest",
    requestExample: {
      request_id: "req_7f3a",
      kind: "permission",
      action: "allow",
    },
    success: {
      status: 202,
      schema: "PostSessionAnswerResponse",
      description:
        "The answer is stored; the receipt tracks its delivery, and `approval` records who answered and the decision that let them.",
      example: {
        ...ACCEPTED_RECEIPT,
        approval: {
          answered_by: {
            principal: { kind: "user", id: EXAMPLE_USER_ID },
            actor_user_id: EXAMPLE_USER_ID,
            agent_id: null,
          },
          surface: "web",
          decision_id: "5b9e2d7a-1c4f-4a83-b6e0-8d3f7a2c1e94",
        },
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REQUEST_EXPIRED",
        "REQUEST_STALE",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      RECOVERY_REQUIRED:
        "A parked request whose session has a turn with an unknown outcome: the answer is not kept, since the turn could not resume.",
      CHECKPOINT_UNAVAILABLE:
        "A parked request whose session has no checkpoint to resume from: the answer is not kept.",
      BAD_REQUEST:
        "Also when the answer does not fit the pending request (its kind, question or option ids); `message` says how.",
      NOT_FOUND: "Also when `request_id` names no request of the session.",
      REQUEST_STALE:
        "The attempt that asked is no longer the session's live attempt: it ended, lost its lease, or the turn moved on. A parked request can be answered whatever happened to the attempt that asked.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests",
    operationId: "createPushRequest",
    tag: "Push requests",
    summary: "Ask for the session's latest checkpoint to be pushed",
    description:
      "Pins the session's latest committed checkpoint: its `checkpoint_revision`, the `git_commit` its verified manifest names, the repository and the target branch. The commit cannot be chosen. `checkpoint_revision` (default: the latest committed one) may name the revision you looked at; it is refused as `checkpoint_moved` once a newer one has been saved. Work the session did after that revision may not be in it. `repository_id` (default: the session's own) may name another catalog repository the session's release lists in `github.repositories` and its profile allows; the session's workspace has it as a git remote of that name. `branch` (default: none) makes the target `agent/<session-id>-<branch>` instead of `agent/<session-id>`, so one session can push to several branches, each its own pull request. The request starts `requested` and nothing is pushed until a holder of `sessions:approve` approves it (`POST .../push-requests/{push_request_id}/approve`); the push itself is the platform's, never the worker's.\n\nA session has at most one open request (`requested`, `approved` or `pushing`) per repository and branch; there is no limit on how many it makes. Every attempt, refused ones included, leaves a `request_push` receipt naming the repository and branch; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request it created.",
    scope: "write",
    body: "CreatePushRequestRequest",
    requestExample: { repository_id: "docs", branch: "fix-typo" },
    success: {
      status: 201,
      schema: "PushRequest",
      description: "The request, pinned and waiting for a decision.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "PUSH_SOURCE_MISSING",
        "PUSH_REQUEST_OPEN",
        "CHECKPOINT_UNAVAILABLE",
        "CHECKPOINT_MOVED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the deployment does not authenticate callers (`AUTH_MODE=none`): push requests need a verified credential; and with `details.refusal: repository_not_allowed` when `repository_id` names a repository the session's release does not list, its profile does not allow, or its agent has GitHub off.",
      PUSH_REQUEST_OPEN:
        "Here: the session already has an open request to this repository and branch; requests to other branches or repositories are not held back.",
      CHECKPOINT_UNAVAILABLE:
        "Here: the latest checkpoint's manifest did not verify; a push never falls back to an older one.",
      CHECKPOINT_MOVED:
        "Here: the session checkpointed again while the request was being pinned; send it again.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests",
    operationId: "listPushRequests",
    tag: "Push requests",
    summary: "List the session's push requests",
    description:
      "Every push request of the session, newest first, with its state and who requested and resolved it.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPushRequestsResponse",
      description: "The session's push requests.",
      example: { items: [EXAMPLE_PUSH_REQUEST] },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}",
    operationId: "getPushRequest",
    tag: "Push requests",
    summary: "Read one push request",
    description:
      "One push request: what it pinned, its state (`requested`, `approved`, `rejected`, then `pushing`, `pushed` or `failed` once the platform pushes an approved one), and who resolved it (`resolved_by`).\n\nThe API pushes an approved request within seconds: exactly the pinned commit, to `refs/heads/agent/<session-id>` on the repository the request pinned, never by force. It refuses, as `failed`, when the catalog entry for the repository changed after the request, the target is the repository's default branch, or the remote branch holds a commit the pinned one does not build on. `finished_at` and `push_receipt_id` are set once it ends; that `push` receipt (`GET /v1/receipts/{receipt_id}`) names the remote, the ref, the commit it replaced, the approver, and on failure the `refusal`.",
    scope: "read",
    success: {
      status: 200,
      schema: "PushRequestView",
      description: "The push request as it stands now.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/approve",
    operationId: "approvePushRequest",
    tag: "Push requests",
    summary: "Approve a push request",
    description:
      "Approves a `requested` push request: the platform pushes the pinned commit to the request's branch. `git_commit` must be the commit the approver reviewed; an approval naming any other is refused. An approval is also refused when the session has checkpointed since the request was made, so what is approved is what the session last committed; reject the request and ask again.\n\nOnly a verified credential that holds `sessions:approve` approves or rejects: an API key or a signed-in user. A workspace key (personal or agent) that started the session never approves or rejects its requests (403, `refusal: self_approval`); another key or a person does. Worker credentials are not accepted on `/v1` at all (401). Every attempt, refused ones included, leaves a `resolve_push` receipt carrying the actor, the verdict and the refusal reason; a refusal's `error.details.receipt_id` names it. A request is approved or rejected once: a second answer, by either path, is 409 `PUSH_REQUEST_RESOLVED`. An Idempotency-Key is shared with `/reject`: replayed on either with the same answer and body, it answers the request as it is now (once the platform has taken it to push, `state` reads `pushing`, `pushed` or `failed`, while `resolved_by`, `resolved_at` and `resolution_receipt_id` still name this answer); with another answer or body it is 409 `IDEMPOTENCY_CONFLICT`.",
    scope: "approve",
    scopeCheckedBy: "service",
    body: "ResolvePushRequestRequest",
    requestExample: {
      git_commit: EXAMPLE_GIT_COMMIT,
    },
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The request as answered.",
      example: {
        ...EXAMPLE_PUSH_REQUEST,
        state: "approved",
        resolved_by: EXAMPLE_ACTOR,
        resolved_at: "2026-10-11T08:35:00Z",
        resolution_receipt_id: "e1d2c3b4-a5f6-4789-9abc-def012345678",
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "PUSH_REQUEST_RESOLVED",
        "CHECKPOINT_MOVED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal is not one that may decide, or the deployment does not authenticate callers (`AUTH_MODE=none`).",
      CHECKPOINT_MOVED:
        "Here: an approval whose `git_commit` is not the pinned one, or a session that checkpointed after the request; the request stays `requested`.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/reject",
    operationId: "rejectPushRequest",
    tag: "Push requests",
    summary: "Reject a push request",
    description:
      "Rejects a `requested` push request; nothing is pushed. `git_commit` is required as for an approval but not compared: a rejection is not refused when the session has moved on.\n\nOnly a verified credential that holds `sessions:approve` approves or rejects: an API key or a signed-in user. A workspace key (personal or agent) that started the session never approves or rejects its requests (403, `refusal: self_approval`); another key or a person does. Worker credentials are not accepted on `/v1` at all (401). Every attempt, refused ones included, leaves a `resolve_push` receipt carrying the actor, the verdict and the refusal reason; a refusal's `error.details.receipt_id` names it. A request is approved or rejected once: a second answer, by either path, is 409 `PUSH_REQUEST_RESOLVED`. An Idempotency-Key is shared with `/approve`: replayed on either with the same answer and body, it answers the request as it is now (once the platform has taken it to push, `state` reads `pushing`, `pushed` or `failed`, while `resolved_by`, `resolved_at` and `resolution_receipt_id` still name this answer); with another answer or body it is 409 `IDEMPOTENCY_CONFLICT`.",
    scope: "approve",
    scopeCheckedBy: "service",
    body: "ResolvePushRequestRequest",
    requestExample: {
      git_commit: EXAMPLE_GIT_COMMIT,
    },
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The request as answered.",
      example: {
        ...EXAMPLE_PUSH_REQUEST,
        state: "rejected",
        resolved_by: EXAMPLE_ACTOR,
        resolved_at: "2026-10-11T08:35:00Z",
        resolution_receipt_id: "e1d2c3b4-a5f6-4789-9abc-def012345678",
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "PUSH_REQUEST_RESOLVED",
        "CHECKPOINT_MOVED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal is not one that may decide, or the deployment does not authenticate callers (`AUTH_MODE=none`).",
      CHECKPOINT_MOVED:
        "Here: an approval whose `git_commit` is not the pinned one, or a session that checkpointed after the request; the request stays `requested`.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request",
    operationId: "openPullRequest",
    tag: "Push requests",
    summary: "Open a pull request from a pushed request",
    description:
      "Opens a pull request on the request's repository's forge (GitHub or GHES) from the request's branch (`agent/<session-id>` or `agent/<session-id>-<branch>`) into that catalog entry's `branch`. Only a `pushed` request opens one (without `?schedule=true`; a request that is not pushed yet is refused with `PUSH_NOT_PUSHED`, as before; with `?schedule=true` the call is held until the push finishes for a push request made with the agent action flows on, and refused with `PUSH_NOT_PUSHED` for one made with them off (the legacy flow), and `PUSH_REQUEST_RESOLVED` answers a request a later one superseded), and only while the catalog entry is still the one the request pinned. The platform calls GitHub with its own credential: an installation token of the catalog's GitHub App, scoped to this repository with `contents: read` and `pull_requests: write`.\n\nThe content is the structured fields `summary`, `changes`, `rationale`, `testing`, `notes` and `related`, or the legacy `body` text, never both. The platform lays the fields out on the repository's pull request template when its default branch has one (`.github/`, the repository root or `docs/`, a `pull_request_template.md` or the one file of a `PULL_REQUEST_TEMPLATE/` directory; read at the default branch's commit as it is when the request is handled, never from the pull request's own branch), under the template's headings or at its `<!-- werft:slot summary -->` lines, keeping the template's own text, comments and checkboxes; otherwise on its default template, a heading per field that has content, in English. A template that is over 16 KiB, not a plain UTF-8 file, ambiguous (several in a directory), unreadable, or written with HTML, tables, reference definitions or comments that share a row with text is passed over for the default template, and the pull request still opens; `body_source.kind` is `repository` with the template's `path`, or `platform` with `skipped` saying why, and the receipt's `template` records the commit, path and blob read. The template's own mentions, closing keywords and references are broken like the fields', a line that looks like a secret is replaced like theirs, and it cannot pass for the platform's tail. On either layout, `related` items become `Closes #N` (an issue of the pull request's own repository, when `closes` is true) or `Refs owner/repo#N`, written by the platform from the catalog, and an item whose `repository_id` the session's catalog does not have is left out (`body_source.related_dropped` counts them). A legacy `body` is used as written. `body_source` says which one the platform wrote, and is null when the pull request was already open and its body was left alone.\n\n`title` (default `Agent session <session-id>`) and the text are cleaned before GitHub sees them: `@` mentions, cross-repository references (`owner/repo#N`), closing keywords (`Closes #N` and the like) and HTML comments are broken with a zero-width space, a line that looks like a secret is replaced by `[REDACTED]`, an engine's own signature line (Claude Code's `Generated with` link) is removed, and the body is cut to GitHub's limit, the last fields first. The body ends with a line naming the session and the commit. This call never approves, merges or asks for reviews. A session's agent merges the pull request of its own push request with the built-in `github` MCP server's `merge_pull_request`, only while the workspace allows it.\n\nSafe to retry: a request opens at most one pull request. When one is already recorded, or GitHub already has an open one for the branch on the pushed commit, it is answered with `created: false` (200). An open one on another commit is not adopted: `PUSH_REQUEST_RESOLVED` with `refusal: head_moved` (`expected_sha`, `actual_sha`), or `BACKEND_UNAVAILABLE` when GitHub only lags behind the push. A pull request this call created on a moved head ends the stage for good: later calls answer the same `head_moved` without asking GitHub. Every attempt, refused ones included, leaves an `open_pull_request` receipt; `receipt_id` names this one, and a refusal's `error.details.receipt_id` names it.\n\nA verified credential that holds `sessions:approve` opens one, as for a push decision. One that may only submit to the session (an agent's key without `sessions:approve`, or the key that started the session) opens one too, since the request was already pushed. The token is issued through the agent's GitHub settings: with GitHub off for the agent, or the repository outside its release, the call is refused with `GITHUB_REFUSED`. Worker credentials are not accepted on `/v1` (401).",
    scope: "approve",
    scopeCheckedBy: "service",
    idempotent: false,
    query: "OpenPullRequestQuery",
    body: "OpenPullRequestRequest",
    requestExample: { title: "Add retry to the sync job" },
    success: {
      status: 201,
      schema: "OpenPullRequestResponse",
      description:
        "The pull request: 201 when this call opened it, 200 with `created: false` when it was already open.",
      example: {
        pull_request: EXAMPLE_PULL_REQUEST,
        created: true,
        body_source: { kind: "platform" },
        receipt_id: EXAMPLE_PULL_REQUEST.receipt_id,
      },
    },
    alsoSucceeds: {
      status: 202,
      schema: "ScheduledPullRequestResponse",
      description:
        'Only with `?schedule=true` and a push that is not finished: `status: "scheduled"`. The platform keeps the content of the first call and opens the pull request once the push is done (a repeated call answers `scheduled` again and changes nothing).',
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: [
        "PUSH_NOT_PUSHED",
        "PUSH_REQUEST_RESOLVED",
        "CATALOG_MISMATCH",
        "GITHUB_REFUSED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal holds neither `sessions:approve` nor `sessions:submit`, the deployment does not authenticate callers (`AUTH_MODE=none`), or the repository has no GitHub credential (a GitHub App).",
      CATALOG_MISMATCH:
        "Here: the catalog entry for the repository changed after the push request pinned it.",
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries).",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments",
    operationId: "commentPullRequest",
    tag: "Push requests",
    summary: "Post or update a comment on the pull request",
    description:
      "Posts a comment on the pull request opened from this push request, or edits the one posted before with the same `marker` (default `status`), so a progress note is updated in place instead of piling up. The comment carries a hidden line `<!-- werft:<session-id>:<marker> -->` that finds it again. `body` is cleaned the same way as a pull request body.\n\nEvery attempt, refused ones included, leaves a `comment_pull_request` receipt with the actor, the pull request, the comment id and `created`. The same credentials as opening the pull request are needed.",
    scope: "approve",
    scopeCheckedBy: "service",
    idempotent: false,
    body: "CommentPullRequestRequest",
    requestExample: {
      body: "Tests pass on the pushed commit.",
      marker: "status",
    },
    success: {
      status: 201,
      schema: "CommentPullRequestResponse",
      description:
        "The comment: 201 when this call posted it, 200 with `created: false` when it edited the marked one.",
      example: {
        pull_request: EXAMPLE_PULL_REQUEST,
        comment: {
          id: 2401,
          url: "https://github.com/acme/sample-app/pull/42#issuecomment-2401",
          marker: "status",
          created: true,
        },
        receipt_id: "b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d1e",
      },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["PULL_REQUEST_MISSING", "CATALOG_MISMATCH", "GITHUB_REFUSED"],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal holds neither `sessions:approve` nor `sessions:submit`, the deployment does not authenticate callers, or the repository has no GitHub credential.",
      CATALOG_MISMATCH:
        "Here: the catalog entry for the repository changed after the push request pinned it.",
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries).",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/github/workflow-dispatches",
    operationId: "dispatchWorkflow",
    tag: "GitHub work",
    summary: "Start a workflow the agent's release allows",
    description:
      "Starts a GitHub Actions run of `workflow` (a file under `.github/workflows/`) on `ref` in the session's repository. The agent's release must turn on `actions` under the workspace ceiling and list the pair in its allowlist: `ref` matches an entry's `ref` glob (`*` does not cross `/`), or is the catalog entry's `branch` when the entry has no `ref`. A ref under `agent/` is refused (`agent_ref_refused`) whatever the allowlist says. A refused call never reaches GitHub and leaves a `dispatch_workflow` receipt with the `reason_code`.\n\n`inputs` go to GitHub as given and are never stored: the receipt keeps the workflow, the ref and the input names only. A run GitHub reports back is recorded with the session, so a later rerun can prove the platform started it; `run` is null when GitHub did not name it.",
    scope: "write",
    body: "DispatchWorkflowRequest",
    requestExample: {
      workflow: "deploy-preview.yml",
      ref: "main",
      inputs: { environment: "preview" },
    },
    success: {
      status: 201,
      schema: "DispatchWorkflowResponse",
      description: "Started; the receipt and the run GitHub named.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        run: {
          id: 9012345678,
          html_url:
            "https://github.com/acme/sample-app/actions/runs/9012345678",
        },
      },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the dispatch; the message never repeats the inputs.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/github/workflow-runs/{run_id}",
    operationId: "getWorkflowRun",
    tag: "GitHub work",
    summary: "Read a workflow run in the session's repository",
    description:
      "Reads one Actions run: its status, conclusion, workflow file and branch. Needs `actions` on in the agent's release under the workspace ceiling; any run in the repository can be read, not only ones the platform started.",
    scope: "read",
    success: {
      status: 200,
      schema: "GitHubWorkflowRun",
      description: "The run.",
      example: {
        id: 9012345678,
        status: "completed",
        conclusion: "failure",
        path: ".github/workflows/deploy-preview.yml",
        head_branch: "main",
        html_url: "https://github.com/acme/sample-app/actions/runs/9012345678",
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      NOT_FOUND: "Also when GitHub has no such run in the repository.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/github/workflow-runs/{run_id}/rerun",
    operationId: "rerunWorkflow",
    tag: "GitHub work",
    summary: "Rerun a workflow run the platform started",
    description:
      "Reruns a run this platform dispatched, all jobs or only the failed ones (`failed_only`). A run the platform has no dispatch record of is refused (`run_ref_unprovable`), and so is one whose workflow and ref the release's current allowlist no longer names (`workflow_not_allowed`). Leaves a `rerun_workflow` receipt either way.",
    scope: "write",
    body: "RerunWorkflowRequest",
    requestExample: { failed_only: true },
    success: {
      status: 201,
      schema: "RerunWorkflowResponse",
      description: "Rerun requested; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/github/attribution",
    operationId: "getSessionGitHubAttribution",
    tag: "GitHub work",
    summary: "Read whose name the session's commits carry",
    description:
      "How the session started (`trigger`: web, Slack, a personal key, an agent key or the operator) and what its commits carry. `co_author`: the person who started it linked a GitHub account, and commits end with `Co-authored-by` naming them. `unlinked`: a person started it but has no GitHub account linked. `app_only`: nobody started it (an agent key or the operator); commits carry only the App and the `Agent-Session` trailer. Read at the time asked: linking or unlinking later changes the answer, not commits already made.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionGitHubAttribution",
      description: "The attribution.",
      example: { trigger: "web", attribution: "co_author", login: "octocat" },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/github/refusals",
    operationId: "listSessionGitHubRefusals",
    tag: "GitHub work",
    summary: "Read why GitHub work of the session was refused lately",
    description:
      "The session's latest refusals by the GitHub gate, newest first, at most 10: each refused clone, push, pull request, Actions call, review or merge leaves a failed receipt (`mint_github_token`, `dispatch_workflow`, `rerun_workflow`, `review_pull_request` or `merge_pull_request`), and this lists its `receipt_id`, `operation`, `purpose` and `reason_code` (a `GITHUB_REFUSED` reason such as `github_disabled` or `repository_not_allowed`). GitHub's own refusals of a call it received are not listed: they are the work's own receipt. Reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListSessionGitHubRefusalsResponse",
      description: "The refusals, newest first.",
      example: {
        items: [
          {
            receipt_id: EXAMPLE_RECEIPT_ID,
            operation: "mint_github_token",
            purpose: "push",
            reason_code: "github_disabled",
            created_at: "2026-10-30T09:12:44.000Z",
          },
        ],
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/outcomes",
    operationId: "listSessionOutcomes",
    tag: "Sessions",
    summary:
      "What the session made: the pull requests it opened and the reviews it submitted",
    description:
      "The session's outcomes, oldest first. Each pull request the platform's pull request opening recorded is one `github_pull_request` outcome, written in the same transaction as its `open_pull_request` receipt (`receipt_id`); opening it again for a later push request of the session answers the same pull request and adds none. Each review the session submitted is one `github_review` outcome, written in the same transaction as its `review_pull_request` receipt: `url` is the review's, `external_id` the review id, `state` always `submitted`, and `metadata` the pull request `number`, the `event`, the `commit_id` reviewed and `opened_by_session_id` (null for a pull request the platform did not open); never the review's body. Only the server writes outcomes.\n\nA pull request's `state` is `open`, `merged` or `closed` as GitHub last answered, at `state_checked_at` (null until the first answer): GitHub tells the platform nothing, so the platform reads each pull request again on an interval (every 5 minutes in its first day, hourly to 30 days, then daily; a closed one daily for 30 days; a merged one never). A failed read keeps the state and sets `check_error` (`not_found`, `forge_failed`, `github_refused`). `metadata.adopted` is true when the platform answered a pull request it did not create, already open for the session's branch, and null when unknown. `metadata.title` is the pull request's title cut to 200 characters, as the platform sent it or GitHub last answered; null until the first read of one the platform did not create, and on a row written before titles were kept until its next read, so a pull request already merged then keeps null. A review is never read again. Reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListSessionOutcomesResponse",
      description: "The outcomes, oldest first.",
      example: {
        items: [
          {
            id: "6c1f5b0e-2d7a-4e8b-9f3c-1a2b3c4d5e6f",
            type: "github_pull_request",
            url: "https://github.com/acme/sample-app/pull/12",
            repository_id: "sample-app",
            external_id: "12",
            state: "merged",
            state_changed_at: "2026-10-30T10:02:11.000Z",
            merged_at: "2026-10-30T10:01:58.000Z",
            closed_at: "2026-10-30T10:01:58.000Z",
            state_checked_at: "2026-10-30T10:02:11.000Z",
            check_error: null,
            metadata: {
              title: "Retry failed payment webhooks",
              head: `agent/${EXAMPLE_SESSION_ID}`,
              base: "main",
              adopted: false,
              merge_commit_sha: "9f2c1e0b7a6d5c4b3a2918f7e6d5c4b3a2918f7e",
              additions: 42,
              deletions: 7,
              changed_files: 3,
              commits: 2,
            },
            created_at: "2026-10-30T09:40:03.000Z",
          },
          {
            id: "6c1f5b0e-2d7a-4e8b-9f3c-1a2b3c4d5e70",
            type: "github_review",
            url: "https://github.com/acme/sample-app/pull/9#pullrequestreview-2104",
            repository_id: "sample-app",
            external_id: "2104",
            state: "submitted",
            state_changed_at: "2026-10-30T10:20:00.000Z",
            merged_at: null,
            closed_at: null,
            state_checked_at: null,
            check_error: null,
            metadata: {
              number: 9,
              event: "APPROVE",
              commit_id: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
              opened_by_session_id: null,
            },
            created_at: "2026-10-30T10:20:00.000Z",
          },
        ],
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/achievements",
    operationId: "listSessionAchievements",
    tag: "Sessions",
    summary: "What the workspace's achievement rules counted in the session",
    description:
      "The session's achievements in force, oldest first, and its latest judgment. Only the platform's judge writes achievements: when the session's evidence appears or changes (a pull request opened, merged or closed, a review submitted, a checkpoint whose `out/` files differ from its parent's) a judgment is queued in the same transaction, one queued per session, and the judge takes it once two minutes have passed since the last such change. It pairs each rule in use with the session's evidence of its type's `evidence_kind`. An `always` rule counts every pair at no cost; one rule family counts a piece of evidence of a session once (`evidence_id`: the outcome id, the `out/` path, or null for the conversation). `title` and `link` are the pull request or review as `owner/repo#number` and its URL, the file's path and the session's console path, or the session's title and console path. `payload` is set only for the built-in types (`pull_request`, `code_review`, `document`). `review_state` is `auto` for pull request and review evidence, counted at once, and `needs_review` for `out/` files and the conversation, counted once a person confirms them; `confirmed` and `rejected` are a person's decision (`POST /v1/achievements/{id}/review`), which a later judgment never changes. `rule_title`, `rule_version` and `type_key` name the rule version that counted it and its type. `threshold` is the workspace threshold its judgment held a `luna` rule's `probability` against, kept with that judgment; null when that judgment asked the judge nothing. `rejudged_after_merge` is true for pull request evidence counted by a judgment made after the pull request merged, in a session with a judgment made before the merge.\n\n`judgment_count` is the session's finished judgments and `judge_cost_usd` what their judge calls cost, apart from the session's own cost.\n\n`judgment` is null before the session's first. Its `trigger` is `evidence`, `turns` (every `every_n_turns` turns, with a rule of `conversation` evidence in use), `idle` (the session's run ended idle, paused or closed, with `on_idle` on) or `manual`; `evidence_change` is `pr_merged` for an `evidence` judgment when one of the session's pull requests merged after the judgment before it was made and by the time this one was, and null otherwise. Its `status` is `queued`, `running`, `succeeded` (with `error_code: judge_refused` when the judge refused a pair, which then is no achievement and is not asked again), `failed`, `deferred` (the workspace's judgment calls spent `daily_budget_usd` for the UTC day; taken again after the next UTC midnight, or two minutes after a new trigger, when `always` rules count the new evidence and `luna` pairs wait again) or `skipped` (`error_code: judge_unavailable`: a `luna` rule had evidence and the workspace's connection does not reach a judge; `session_limit`: the session's other judgments that called the judge reached `max_per_session`). A try that fails is queued again 1, 5 and 30 minutes later, then ends `failed`, with the `error_code` of its last failure: `judge_timeout` (no answer within 10 seconds), `judge_http_error` (an error status, or the judge was not reached), `judge_bad_response` (an answer of another shape); `error_code: outputs_unavailable` says the checkpoint's `out/` list could not be read, and the achievements that need no `out/` list are written all the same. Reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListSessionAchievementsResponse",
      description: "The achievements, oldest first, and the latest judgment.",
      example: {
        items: [
          {
            id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
            session_id: EXAMPLE_SESSION_ID,
            agent_id: null,
            agent_release_id: null,
            rule_id: "7d3a4e5f-6b7c-4d8e-8f9a-1b2c3d4e5f60",
            rule_family_id: "8e4b5f6a-7c8d-4e9f-9a0b-2c3d4e5f6a71",
            type_id: "9f5c6a7b-8d9e-4f0a-8b1c-3d4e5f6a7b82",
            title: "acme/sample-app#12",
            link: "https://github.com/acme/sample-app/pull/12",
            evidence_kind: "github_pull_request",
            evidence_id: "6c1f5b0e-2d7a-4e8b-9f3c-1a2b3c4d5e6f",
            payload: {
              repository: "acme/sample-app",
              number: 12,
              url: "https://github.com/acme/sample-app/pull/12",
              state: "open",
              merged_at: null,
              additions: 42,
              deletions: 7,
            },
            judge: "always",
            rule_title: "Merged pull request",
            rule_version: 2,
            type_key: "pull_request",
            probability: null,
            threshold: null,
            rejudged_after_merge: false,
            judgment_id: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
            review_state: "auto",
            reviewed_by: null,
            reviewed_at: null,
            review_note: null,
            created_at: "2026-10-30T09:42:10.000Z",
          },
        ],
        judgment: {
          id: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
          trigger: "evidence",
          status: "succeeded",
          error_code: null,
          evidence_change: null,
          created_at: "2026-10-30T09:40:03.000Z",
          finished_at: "2026-10-30T09:42:10.000Z",
        },
        judgment_count: 1,
        judge_cost_usd: 0,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/achievement-judgments",
    operationId: "rejudgeSession",
    tag: "Sessions",
    summary: "Judge the session again against the achievement rules",
    description: `${ACHIEVEMENT_MANAGERS} The caller must also be able to read the session. Queues a \`manual\` judgment of the session, or, when one is already pending (queued, or \`deferred\` to the next UTC day's budget), merges into it, makes its trigger \`manual\` and answers its id; the judge takes it once two minutes have passed since the session's last trigger. Rules changed since are applied as they are now; nothing else is rejudged. Writes a \`rejudge_session\` receipt naming the judgment. Another owner's session is 404.`,
    auth: "session",
    success: {
      status: 202,
      schema: "RejudgeSessionResponse",
      description: "The pending judgment, and the receipt.",
      example: {
        judgment_id: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievements/{id}/review",
    operationId: "reviewAchievement",
    tag: "Sessions",
    summary: "Confirm or reject one of a session's achievements",
    description:
      "Owners, admins and the admins of the achievement's agent (`achievement.review`), signed in, who can also read its session; API keys are refused. `confirm` counts a `needs_review` achievement (`review_state: confirmed`); `reject` drops an `auto` or `needs_review` one from the count (`rejected`). A review is final: a later judgment never changes it, and a second review, or confirming an `auto` one, is 409 REVISION_CONFLICT with `details.reason_code: not_reviewable`. `note` is kept on the achievement as `review_note`, not in the receipt. Writes a `review_achievement` receipt naming the achievement and its new state. An achievement of another owner, or one a later judgment replaced, is 404.",
    auth: "session",
    body: "ReviewAchievementRequest",
    requestExample: { action: "confirm" },
    success: {
      status: 200,
      schema: "ReviewAchievementResponse",
      description: "The achievement as reviewed, and the receipt.",
      example: {
        achievement: {
          id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
          session_id: EXAMPLE_SESSION_ID,
          agent_id: null,
          agent_release_id: null,
          rule_id: "7d3a4e5f-6b7c-4d8e-8f9a-1b2c3d4e5f60",
          rule_family_id: "8e4b5f6a-7c8d-4e9f-9a0b-2c3d4e5f6a71",
          type_id: "9f5c6a7b-8d9e-4f0a-8b1c-3d4e5f6a7b82",
          title: "out/payment-retry.md",
          link: `/sessions/${EXAMPLE_SESSION_ID}`,
          evidence_kind: "out_file",
          evidence_id: "out/payment-retry.md",
          payload: { path: "out/payment-retry.md", size: 4198 },
          judge: "always",
          rule_title: "Design document",
          rule_version: 3,
          type_key: "document",
          probability: null,
          threshold: null,
          rejudged_after_merge: false,
          judgment_id: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
          review_state: "confirmed",
          reviewed_by: EXAMPLE_USER_ID,
          reviewed_at: "2026-10-30T10:02:00.000Z",
          review_note: null,
          created_at: "2026-10-30T09:42:10.000Z",
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/github/pull-requests/{number}/reviews",
    operationId: "submitPullRequestReview",
    tag: "GitHub work",
    summary: "Review a pull request in the session's repository",
    description:
      "Submits a review (`APPROVE`, `REQUEST_CHANGES` or `COMMENT`) on pull request `number` of the session's repository with the workspace's reviewer App, a second App apart from the one that opens pull requests, since GitHub refuses an approval from a pull request's own author. Any open pull request in the repository can be reviewed, whoever opened it. The agent's release must turn on `review` under the workspace ceiling; without a reviewer App the call is refused (409 `GITHUB_REFUSED` `no_reviewer_app`). The token is the reviewer App's, scoped to this repository with `contents: read` and `pull_requests: write`.\n\n`commit_id` is the head the caller read and is required: GitHub files the review on that commit, so nothing pushed after the read is approved. The platform also reads the pull request first, and when its head is not `commit_id` it submits nothing and refuses with 409 `GITHUB_REFUSED` `stale_commit` (`error.details.head_sha` is the head it read). `body` (required unless `APPROVE`) goes to GitHub only, with mentions and cross-references neutralized and secret-shaped lines replaced by `[REDACTED]`. Whether an approval satisfies the repository's required reviews is GitHub's rule, as are branch protection and CODEOWNERS. Leaves a `review_pull_request` receipt either way, naming the commit, the event and, when the platform opened the pull request, the session and agent that opened it; never the body.",
    scope: "write",
    body: "SubmitPullRequestReviewRequest",
    requestExample: {
      event: "APPROVE",
      commit_id: "9f2c1e0b7a6d5c4b3a2918f7e6d5c4b3a2918f7e",
    },
    success: {
      status: 201,
      schema: "SubmitPullRequestReviewResponse",
      description: "Submitted; the receipt and the review GitHub made.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        review: {
          id: 2345678901,
          html_url:
            "https://github.com/acme/sample-app/pull/12#pullrequestreview-2345678901",
        },
      },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Here: no token for the reviewer App (not installed on the repository; the receipt names the App), or GitHub refused or failed the review (a commit not in the pull request, an approval of the App's own pull request; the receipt has GitHub's status).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/interrupt",
    operationId: "interruptSession",
    tag: "Session control",
    summary: "Interrupt the targeted turn only",
    description:
      "Asks the worker to stop turn `target_turn_id` while it runs; the session's admission state and its other turns are left alone. The event stream shows a `status` event with phase `interrupting` when the worker takes the request and `engine_stopped` when the engine has stopped the turn; the turn reads `interrupted` once its checkpoint commits. If the turn has not ended 60 seconds after acceptance, its execution is killed.\n\nAccepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.",
    scope: "control",
    body: "InterruptSessionRequest",
    requestExample: { target_turn_id: "2" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The interrupt is stored (`accepted`), or the turn had already ended (`succeeded`, `no_op: true` on the receipt).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a turn running on the legacy pod binding, which no worker polls
    // control for.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "TURN_NOT_STARTED"],
    },
    errorNotes: {
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      UNSUPPORTED_CAPABILITY:
        "The turn runs on a legacy pod binding, which no worker polls for control.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/pause",
    operationId: "pauseSession",
    tag: "Session control",
    summary: "Drain the current turn, checkpoint, stop the execution",
    description:
      "Pauses an `active` session so it holds no worker: the running turn, if any, is drained, its checkpoint commits and the execution stops. Queued input is kept and runs after a resume. The session goes `pausing` and the receipt stays `accepted` until the execution is observed gone; then the session is `paused` and the receipt `succeeded` with result `{resulting_admission_state, checkpoint_revision, queued_turn_count}`. A session with no execution goes `paused` at once. A drain that takes over 60 seconds shows `attention.code: PAUSE_BLOCKED` with the reason; nothing is killed for it, and terminating is the caller's choice. The receipt fails if the pause cannot commit, a resume cancels it, or a terminate overtakes it. Each step is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "PauseSessionRequest",
    requestExample: { expected_revision: 7, reason: "Done for the day" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The pause is stored (`accepted`), or the session had no execution and is `paused` already (`succeeded`).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Checked before the admission state, so a stale revision answers this even on a session that is already paused.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      CHECKPOINT_UNAVAILABLE:
        "No live worker can drain the turn and no committed checkpoint covers the last turn; terminate instead.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/close",
    operationId: "closeSession",
    tag: "Session control",
    summary: "Finish the session: drain, checkpoint, close for good",
    description:
      "Ends a session whose work is done. Unlike terminate, nothing is killed: the running turn finishes, its checkpoint commits, and the session ends `closed`, which nothing reopens. Unlike a recovery close (`POST /v1/sessions/{id}/recovery-decisions`, `decision: close`), it is the owner's call on a healthy session, needs `sessions:control` rather than `sessions:recover`, and its receipt operation is `close` rather than `recovery_decision`. [The API guide](https://jeongjaesoon.github.io/werft/en/reference/api-guide/#ending-a-session-close-terminate-and-recovery-close) compares the three.\n\n- **`active` with a live worker:** the worker drains as for a pause and the session goes `closing`. The receipt stays `accepted` until the execution is observed gone with a checkpoint covering every turn that ran; then the session is `closed` and the receipt `succeeded`. A drain over 60 seconds shows `attention.code: CLOSE_BLOCKED` with the reason; nothing is killed for it. An open question or approval holds the close until it is answered or the turn interrupted. If the drain cannot commit, the receipt fails and the session goes back to `active` (or `recovery_required` for a turn whose outcome is unknown), with its queued input intact; a terminate overtakes it (`CONTROL_SUPERSEDED`).\n- **`active` with no live worker, `paused`, or a `stopped` session that can be resumed:** closed in this request. With an execution still bound the receipt is `accepted` until it is observed gone; otherwise `succeeded` in the response.\n\nQueued input is cancelled in the transaction that closes the session (each input's receipt fails with `SESSION_CLOSED`). Push requests are left alone; request a push of the result after the close has succeeded, since a push requested inside the last turn is refused `CHECKPOINT_MOVED` once the close commits that turn's checkpoint. The receipt result is `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`. The stream carries a `status` event for `closing` and for `closed`, and a `system` event `{subtype: session_closed, closed_by: close, close_receipt_id, checkpoint_revision, cancelled_turn_count}`. A caller closing its own session from inside a turn must not wait on the receipt: the drain waits for that turn to end. After the close, messages and controls answer `409 SESSION_CLOSED`.",
    scope: "control",
    body: "CloseSessionRequest",
    requestExample: { expected_revision: 7, reason: "Work is done" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The close is stored (`accepted`), or the session had nothing to wait on and is `closed` already (`succeeded`).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Checked before the admission state, but after `closed`: a closed session answers `SESSION_CLOSED` whatever the revision.",
      SESSION_PAUSED: "The session is pausing; close it once it is paused.",
      SESSION_STOPPED:
        "The session is stopping; close it once the terminate receipt has settled.",
      RECOVERY_REQUIRED:
        "The session is `recovery_required`, or `stopped` and cannot be resumed; end it with a recovery close instead.",
      CHECKPOINT_UNAVAILABLE:
        "No live worker can drain and no trusted checkpoint covers the last turn that ran; terminate, then use a recovery close.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/terminate",
    operationId: "terminateSession",
    tag: "Session control",
    summary: "Block dispatch and force the execution down",
    description:
      "Stops the session by force, in any admission state but `closed`: dispatch is blocked, queued input is cancelled (each input's receipt fails with `SESSION_STOPPED`), open requests close and the execution is killed. The session goes `stopping` until the kill is observed, then `stopped`; with nothing to kill it is `stopped` at once and the receipt is `succeeded` in the response. A `recovery_required` session keeps that state. A turn the kill cut short may end `outcome_unknown`, which holds the session in `recovery_required` until `POST /v1/sessions/{id}/recovery-decisions`. The kill reverts nothing the execution already did outside (commits, pushes, API calls): the response and the receipt say `external_effects_reverted: false`. The receipt result is `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`. Resume a `stopped` session from its last checkpoint with `POST /v1/sessions/{id}/resume`. A pause or close still draining is overtaken: its receipt fails with `CONTROL_SUPERSEDED`. To end a session whose work is done, close it instead (`POST /v1/sessions/{id}/close`).",
    scope: "control",
    body: "TerminateSessionRequest",
    requestExample: { expected_revision: 7, reason: "Runaway tool loop" },
    success: {
      status: 202,
      schema: "TerminateSessionResponse",
      description:
        "The terminate is stored (`accepted`), or there was nothing to kill and the session is `stopped` (`succeeded`).",
      example: { ...ACCEPTED_RECEIPT, external_effects_reverted: false },
    },
    // Served: an oversized body, a legacy binding with no kill path, and a
    // database outage are real answers.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
    errorNotes: {
      SESSION_PAUSED: RESERVED_HERE,
      SESSION_RESUMING: RESERVED_HERE,
      SESSION_STOPPED: RESERVED_HERE,
      RECOVERY_REQUIRED: RESERVED_HERE,
      UNSUPPORTED_CAPABILITY:
        "The session runs on a legacy pod binding with no kill path.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/profile",
    operationId: "changeSessionProfile",
    tag: "Session control",
    summary: "Run the session's next turns on another profile",
    description:
      "Moves an `active`, `paused` or `stopped` session onto `profile_id`, a profile this host's catalog allows with the session's repository, or, for a session created without one, a profile whose `repository_mode` is `optional` or `none`. It takes effect at the next turn that starts: a turn running now finishes on the profile it started with, and its worker then leaves so the next one claims the new profile and restores the session's checkpoint, conversation included. The session then runs the new profile's default `model`, whatever `model` it was created with. Earlier turns keep their record and cost; each turn's `attempts[].profile_id` says what it ran on.\n\nThe new profile must run the same runtime kind and version, since the next worker restores checkpoints that runtime took, and must be billed the same way (`billing: none` or not), since the session's cost limit stays as it is. A session created from an agent release runs the release's profile and answers `409 RELEASE_PROFILE_MISMATCH`. The change settles in the request: the receipt is `succeeded` with result `{previous_profile_id, profile_id}`, and a `status` event on the stream carries both. Naming the profile the session already runs changes nothing and still answers `succeeded`.",
    scope: "control",
    body: "ChangeSessionProfileRequest",
    requestExample: { expected_revision: 8, profile_id: "claude-coding-fast" },
    success: {
      status: 200,
      schema: "ReceiptAcceptedResponse",
      description: "The session runs `profile_id` from its next turn on.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID, receipt_status: "succeeded" },
    },
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "RELEASE_PROFILE_MISMATCH",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Also when the session's profile changed between the read and the change.",
      SESSION_PAUSED: "The session is pausing.",
      SESSION_STOPPED: "The session is stopping.",
      RELEASE_PROFILE_MISMATCH:
        "The session belongs to an agent release, which sets its profile.",
      UNSUPPORTED_CAPABILITY:
        "The profile is not in the catalog, not allowed with the session's repository, runs another runtime, or is billed differently.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    tag: "Session control",
    summary: "Restore from the last committed checkpoint or cancel a pause",
    description:
      "Brings a `stopped` or `paused` session back to `active`, or cancels a pause that is still draining. The receipt result is `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n\n- **From `stopped`:** the session is `active` at once, the next worker restores the last committed checkpoint, queued input is dispatched, and the receipt is `succeeded` in the response.\n- **From `paused`:** the session goes `resuming` and a new worker restores the pause's checkpoint. The receipt stays `accepted` until that worker reports ready; then the session is `active` and the receipt `succeeded`. If the restore keeps failing, the receipt fails and the session goes `recovery_required`.\n- **From `pausing`, before the stop is committed:** the pause is cancelled (its receipt fails), the session is `active` again, and this receipt is `succeeded`. Once the stop is committed the answer is `409 PAUSE_COMMITTING`.\n\nEach change is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "ResumeSessionRequest",
    requestExample: { expected_revision: 8 },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The resume is stored: `accepted` while a worker restores a paused session, `succeeded` when it took effect in the request.",
      example: ACCEPTED_RECEIPT,
    },
    // 409 PAUSE_COMMITTING once a pause can no longer be cancelled, 409
    // SESSION_RESUMING while a resume is restoring; 422: a legacy pod
    // binding; 413/503 as for every mutation.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_RESUMING",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
        "PAUSE_COMMITTING",
        "PENDING_REQUESTS_OPEN",
      ],
    },
    errorNotes: {
      PENDING_REQUESTS_OPEN:
        "The session's parked turn still has a request that is neither answered nor expired: answer it, or wait for its `expires_at`. Its answer then resumes the session.",
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      RECOVERY_REQUIRED:
        "The session is stopping or needs recovery, or a turn's outcome is unknown.",
      REQUEST_STALE: "The session is already active.",
      CHECKPOINT_UNAVAILABLE:
        "The stopped or paused session has no restore point it can resume from.",
      UNSUPPORTED_CAPABILITY:
        "The session runs on a legacy pod binding, or has no runtime spec pinned on its own model, which a session needs to run once specs are authoritative.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/recovery-decisions",
    operationId: "decideSessionRecovery",
    tag: "Recovery",
    summary:
      "Operator decision for an unknown outcome or a context no checkpoint covers",
    description:
      "Records an operator's decision where the platform will not guess: a turn whose outcome is unknown, or context no checkpoint covers. Nothing the execution did outside is reverted.\n\n- `abandon`: the `outcome_unknown` turn `target_turn_id` becomes `cancelled` and its input receipt fails; the session is `stopped`.\n- `confirm_completed`: with `evidence_ref`, the turn becomes `completed` and its input receipt succeeds; it needs a committed checkpoint that reaches the turn. The session is `stopped`.\n- `close`: ends the session for good.\n- `start_fresh`: continues on a new engine session that does not remember the turns before; the checkpoints so far are retired and queued input runs.\n- `retry_restore`: restores the same checkpoint again after what made the restores fail is fixed; queued input runs.\n\nThe decision takes effect in the request: the receipt is `succeeded` in the response, with result `{resulting_admission_state, checkpoint_revision, resumable}`. After `abandon` or `confirm_completed`, resume the session; `resumable: false` means a resume would answer `CHECKPOINT_UNAVAILABLE`. The decision is also recorded as a `system` event on the stream.",
    scope: "recover",
    body: "RecoveryDecisionRequest",
    requestExample: {
      decision: "abandon",
      expected_revision: 9,
      target_turn_id: "3",
      reason: "The call had no external effect.",
    },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description: "The decision is applied; the receipt is `succeeded`.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID, receipt_status: "succeeded" },
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorNotes: {
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      REQUEST_STALE:
        "The decision does not apply to the session now: `close` or `start_fresh` on a session not awaiting recovery, `confirm_completed` or `abandon` on a turn whose outcome is not unknown, or `retry_restore` on a session a failed restore did not stop.",
      RECOVERY_REQUIRED:
        "The execution is not yet confirmed gone, or `start_fresh` while a turn's outcome is still unknown.",
      CHECKPOINT_UNAVAILABLE:
        "`confirm_completed` with no committed checkpoint that reaches the target turn.",
      SESSION_PAUSED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_RESUMING: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_STOPPED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      UNSUPPORTED_CAPABILITY:
        "The session runs on a legacy pod binding, or has no runtime spec pinned on its own model, which a session needs to run once specs are authoritative.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/invites",
    operationId: "createInvite",
    tag: "Members",
    summary: "Invite a person to the workspace",
    description:
      "The token is returned once and expires in seven days; only its sha256 is stored. Inviting an address that already has a live invite revokes that invite. An address that is already a live member answers 400. Every invite writes an `invite_member` receipt.",
    auth: "session",
    body: "CreateInviteRequest",
    success: { status: 201, schema: "CreateInviteResponse" },
    errors: [400, 401, 403, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/invites",
    operationId: "listInvites",
    tag: "Members",
    summary: "Invites of the workspace, newest first",
    description:
      "Each invite's status is pending, accepted, revoked or expired. Tokens are never returned.",
    auth: "session",
    success: { status: 200, schema: "ListInvitesResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/invites/{id}",
    operationId: "revokeInvite",
    tag: "Members",
    summary: "Revoke an invite",
    description:
      "Writes a `revoke_invite` receipt. Revoking an invite that was already revoked does nothing; an accepted one answers 409.",
    auth: "session",
    success: { status: 204 },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["INVITE_USED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/invites/accept",
    operationId: "acceptInvite",
    tag: "Auth",
    summary: "Redeem an invite; sets the session cookie",
    description:
      "An address with no account gets one with this password. An existing account joins with its current password, which is never changed. The token is spent once; a revoked, replaced or expired token answers 410, an accepted one 409. Writes an `accept_invite` receipt.",
    auth: "public",
    csrf: "always",
    body: "AcceptInviteRequest",
    success: { status: 200, schema: "AcceptInviteResponse" },
    errors: [400, 401, 403, 409, 410, 413, 429, 503],
    errorCodes: { 409: ["INVITE_USED"], 410: ["INVITE_EXPIRED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/members",
    operationId: "listMembers",
    tag: "Members",
    summary: "Members of the workspace, oldest first",
    description:
      "Lists the workspace's members, disabled ones included, oldest membership first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `q` keeps the members whose display name or email contains it, ignoring case. `user_ids` (comma-separated, at most 100) keeps the members among those users, as one page of a screen that already holds the ids and needs their names or roles. Each row's `actions` says, for the caller as the list was read, whether each role change, disable and enable would be accepted, and if not, why: the reason is the lower-cased error code the write answers with, or `unchanged` when it would answer 200 and change nothing. The write checks again when it runs. A client that validates responses strictly needs this version's schema to read the field.",
    auth: "session",
    query: "ListMembersQuery",
    success: { status: 200, schema: "ListMembersResponse" },
    errors: [400, 401, 403, 503],
  },
  {
    method: "patch",
    path: "/v1/members/{user_id}",
    operationId: "updateMember",
    tag: "Members",
    summary: "Change a member's role",
    description:
      "When several apply, the first answers: no `member.manage` (403 FORBIDDEN), your own role (403 SELF_PROTECTED), no such member (404), an owner targeted, or the owner role granted, by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED), a disabled membership (409 MEMBER_DISABLED), the role it already has (200, nothing written), demoting the workspace's last live owner (409 LAST_OWNER). Writes a `change_member_role` receipt when the role changes.",
    auth: "session",
    body: "UpdateMemberRequest",
    success: { status: 200, schema: "MemberView" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["ACCOUNT_DISABLED", "MEMBER_DISABLED", "LAST_OWNER"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/disable",
    operationId: "disableMember",
    tag: "Members",
    summary: "Disable a member of the workspace",
    description:
      "In the same transaction: the membership is disabled, every web session of the person is revoked (open event streams end), their personal keys in the workspace are revoked, and the sessions they asked for wait for an owner's takeover. Agent keys are untouched. Only an owner disables an owner: an admin targeting one answers 403 OWNER_PROTECTED and nothing changes. Disabling yourself answers 403 SELF_PROTECTED, the last live owner 409 LAST_OWNER. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), already disabled (200, nothing written), the last live owner (409). Writes a `disable_member` receipt unless the membership was already disabled (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["LAST_OWNER"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/enable",
    operationId: "enableMember",
    tag: "Members",
    summary: "Enable a disabled member again",
    description:
      "Revoked web sessions and personal keys stay revoked: the person signs in again. Sessions no owner took over go back to them. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED: the membership alone would not bring them back, lift the suspension), already live (200, nothing written). Writes an `enable_member` receipt unless the membership was already live (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["ACCOUNT_DISABLED"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/disable",
    operationId: "disableUser",
    tag: "Members",
    summary: "Suspend an account",
    description:
      "Allowed only when every live membership of the account is in a workspace the caller owns or administers; otherwise 403 FORBIDDEN. An account that is an owner, even with that membership disabled, in any workspace the caller is not a live owner of answers 403 OWNER_PROTECTED first. The account cannot sign in anywhere, and the same cut-off as disabling a member applies in each of its workspaces. Suspending yourself answers 403 SELF_PROTECTED. Writes a `disable_user` receipt unless the account was already suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/enable",
    operationId: "enableUser",
    tag: "Members",
    summary: "Lift an account suspension",
    description:
      "The same rules as suspending, OWNER_PROTECTED included. Revoked web sessions and personal keys stay revoked. Writes an `enable_user` receipt unless the account was not suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/takeovers",
    operationId: "listTakeovers",
    tag: "Admin",
    summary: "Sessions waiting for an owner to take them over",
    description:
      "Sessions whose requester was offboarded. Each takes no further input until an owner takes it over. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListTakeoversResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/takeover",
    operationId: "takeOverSession",
    tag: "Admin",
    summary: "Become the requester of an offboarded member's session",
    description:
      "The caller becomes the session's requester and its queued input runs again. A session shared with less than the whole workspace and not with the caller needs a `justification`, kept on the decision and the receipt; without one it answers 403 with `reason_code` `justification_required`. The body may be empty. API keys are refused.",
    auth: "session",
    body: "TakeOverSessionRequest",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REQUEST_STALE"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/start",
    operationId: "startSlackLink",
    tag: "Linked accounts",
    summary: "Start linking the caller's Slack account",
    description:
      "Returns Slack's consent URL and sets a one-time state cookie for the callback, valid ten minutes. Scopes are `openid profile`; no email is requested. The consent is for the workspace's link app; a workspace without one gets it made now with its App Configuration Token (once: concurrent starts share it), unless the installation names a fallback OIDC app. Refused with 409 when the workspace has no verified Slack install, or nothing to link with. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "StartSlackLinkResponse" },
    errors: [401, 403, 409, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "SLACK_LINK_NOT_CONFIGURED",
        "SLACK_APP_CREATING",
        "REVISION_CONFLICT",
      ],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/callback",
    operationId: "slackLinkCallback",
    tag: "Linked accounts",
    summary: "Finish linking with the code Slack returned",
    description:
      "Spends the state cookie, exchanges the code and verifies the id_token, then links the Slack account to the caller and writes a `link_account` receipt. Refused when the account's Slack team is not installed for the workspace, when the account is linked to someone else (never overwritten), or when the caller already linked another account in that team. API keys are refused.",
    auth: "session",
    body: "SlackLinkCallbackRequest",
    success: { status: 201, schema: "SlackLinkCallbackResponse" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "LINK_TEAM_MISMATCH",
        "LINK_TAKEN",
        "LINK_EXISTS",
      ],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/github/start",
    operationId: "startGitHubLink",
    tag: "Linked accounts",
    summary: "Start linking the caller's GitHub account",
    description:
      "Returns GitHub's consent URL for the workspace's author GitHub App (its user authorization, not a separate OAuth App) and sets a one-time state cookie for the callback, valid ten minutes. Refused with 409 `GITHUB_LINK_NOT_CONFIGURED` (`reason_code` `github_oauth_unset`) until an owner or admin has registered the author App, GitHub has given its client id, its client secret is set and the console has an origin to be called back on. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "StartGitHubLinkResponse",
      description:
        "Where to send the browser; the state cookie is set on this answer.",
      example: {
        authorize_url:
          "https://github.com/login/oauth/authorize?client_id=Iv23liExampleClientId&redirect_uri=https%3A%2F%2Fconsole.example.com%2Fsettings%2Flinked-accounts%2Fgithub&state=3q2-7wE&allow_signup=false",
        expires_at: "2026-10-30T09:10:00Z",
      },
    },
    errors: [401, 403, 409, 503],
    errorCodes: { 409: ["GITHUB_LINK_NOT_CONFIGURED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/github/callback",
    operationId: "githubLinkCallback",
    tag: "Linked accounts",
    summary: "Finish linking with the code GitHub returned",
    description:
      "Spends the state cookie, exchanges the code for a user token, reads `GET /user` once for the account's numeric id and login, and drops the token: nothing of it is kept. Links that account to the caller (`external_tenant` `github.com`) and writes a `link_account` receipt. From then on the commits of sessions the caller starts name them as co-author, `Co-authored-by: <login> <id+login@users.noreply.github.com>`. A spent, expired or someone else's state, or a code GitHub refuses, is 400. Refused when the GitHub account is linked to someone else (never overwritten) or the caller already linked a GitHub account. API keys are refused.",
    auth: "session",
    body: "GitHubLinkCallbackRequest",
    requestExample: { code: "<code-from-github>", state: "3q2-7wE" },
    success: {
      status: 201,
      schema: "GitHubLinkCallbackResponse",
      description: "Linked; the account and the receipt.",
      example: {
        linked_account: {
          id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
          user_id: EXAMPLE_USER_ID,
          provider: "github",
          external_tenant: "github.com",
          external_user_id: "583231",
          external_tenant_name: "GitHub",
          external_user_name: "octocat",
          status: "active",
          verified_at: "2026-10-30T09:01:00Z",
          revision: 1,
          expires_at: null,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: {
      409: ["GITHUB_LINK_NOT_CONFIGURED", "LINK_TAKEN", "LINK_EXISTS"],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/linked-accounts",
    operationId: "listLinkedAccounts",
    tag: "Linked accounts",
    summary: "The caller's linked accounts that are active or stale",
    description:
      "Each item's `expires_at` is its provider token's expiry, null when no token is kept (every Slack link). API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListLinkedAccountsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/linked-accounts/{id}",
    operationId: "unlinkAccount",
    tag: "Linked accounts",
    summary: "Unlink one of the caller's accounts",
    description:
      "Revokes the link and writes an `unlink_account` receipt. Input from that Slack account is refused from then on, including input that was already waiting to be processed. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    tag: "Agents",
    summary: "The workspace's agents",
    description:
      "Lists the workspace's agents oldest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. Every member of the workspace lists it, except that a private agent the caller may not use is left out, as if it did not exist (the same rule as `GET /v1/usable-agents` and a session start; owners, admins, the agent's admins and its managing team's members keep it), each agent's row being its information (name, slug, description, managing team id and name, status, active release id). `include=summary` adds to each item a `summary` of what a card shows (the version people talk to, its runtime profile, live credential bindings, admins, and how many of the agent's sessions the caller can see are `needs_input` and `running`, as `GET /v1/sessions` shows them), read for the whole page at once, only on the agents whose settings the caller reads (`GET /v1/agents/{id}`); the other items come without it. Without `include` the items are as before. `q` keeps the agents whose name or slug contains it, ignoring case, `ids` the agents named (at most 100; an id of no agent in the workspace is left out); each narrows the same order, so the cursor works as before. An agent key that holds `sessions:write` gets its own agent alone, on one page, so it can find the `active_release_id` to send as `agent_release_id` to `POST /v1/sessions`; it is refused `include=summary`, `q` and `ids` keep its agent only when it matches them, and every other API key is refused.",
    // A key needs sessions:write here, the right to start a session on the
    // agent it finds; a person's role holds it.
    scope: "write",
    query: "ListAgentsQuery",
    success: {
      status: 200,
      schema: "ListAgentsResponse",
      description: "One page of agents.",
      example: {
        items: [EXAMPLE_AGENT],
        next_cursor:
          "eyJjcmVhdGVkX2F0IjoiMjAyNi0xMC0xMSAwODowMDowMCswMCIsImlkIjoiOGQyYzRmMWEtNmIzZS00YTlkLWI3YzUtMmUxZjBhOWI4YzdkIn0",
      },
    },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/agents/counts",
    operationId: "countAgents",
    tag: "Agents",
    summary:
      "How many agents the workspace has, by state, and how many the caller administers",
    description:
      "`all` is how many agents GET /v1/agents lists read to the last page; `administered` is how many of them the caller administers now, directly or through a team they are a live member of; `active` is how many are `active` with an `active_release_id`, and `draft` how many are not `archived` and have none yet. Answered for the same callers as the list, over the same agents: every member counts what the list shows them, so a private agent the caller may not use is in no count. API keys are refused. It changes nothing.",
    auth: "session",
    success: {
      status: 200,
      schema: "CountAgentsResponse",
      description: "The counts.",
      example: {
        counts: {
          all: 128,
          administered: 3,
          active: 97,
          draft: 24,
        },
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    tag: "Agents",
    summary: "Create an agent and its first card version",
    description:
      "Without `runtime_profile_id` nothing is released or activated. With it the save makes the first release on that profile and activates it, as `PATCH /v1/agents/{id}` does; `model_source` defaults to `profile`, which runs the profile's default model. The agent and its card are kept when the release is refused: `release.status` is then `failed` with the reason, and the agent's `draft` holds the request until a new save. The creator administers the agent. `managing_team_id` is required (400 BAD_REQUEST with a `details.issues` entry at `managing_team_id` when absent): an owner or admin names any live team (404 when there is none by that id), anyone else only a team they are in (403 FORBIDDEN, `details.reason_code` `team_not_allowed`). A slug already used in the workspace answers 409 ALREADY_EXISTS. API keys are refused.",
    auth: "session",
    body: "CreateAgentRequest",
    success: { status: 201, schema: "SaveAgentResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    tag: "Agents",
    summary: "An agent with its versions, releases and active release",
    description:
      "The agent's settings: its card versions, releases and active release. Read by the workspace's owners and admins and by those inside the agent: its admins and the live members of its managing team. A member outside it gets 403 and reads the agent's row from `GET /v1/agents` (`ids`) instead, or 404 while the workspace's `agent_outsider_access` is `none`, since the agent is then hidden from them; an id of no agent in the workspace is 404. A private agent the caller may not use is 404 too, with the body of an id of no agent, whatever the caller's other rights outside it. It changes nothing.",
    auth: "session",
    success: { status: 200, schema: "AgentDetail" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    tag: "Agents",
    summary: "Rename or describe an agent, or save its card and profile",
    description:
      "`name` and `description` change the agent itself: no version is made, and `description: null` clears it. Neither reaches a run. A `card` becomes a new version; existing versions never change, and a card equal to one the agent already has reuses it. A card, `runtime_profile_id` or `model_source` changes what the agent does: unless it equals what the agent runs (`release.status: unchanged`, nothing released), the save makes a release of it and activates it (`applied`). `runtime_profile_id` alone saves the card the agent runs now on that profile; without a card or profile the agent's current ones are used. `model_source: profile` runs the profile's default model and writes it into the card; `fixed` keeps the card's model; absent, the current source is kept while the card's model is the one running. A refused release (`failed`, with its `reason`) keeps the card version and leaves the request as the agent's `draft`; a save a newer one replaced answers `superseded` and changes nothing.",
    auth: "session",
    body: "UpdateAgentRequest",
    success: { status: 200, schema: "SaveAgentResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/releases",
    operationId: "createAgentRelease",
    tag: "Agents",
    summary: "Release a version against a runtime profile",
    description:
      "The release id is a hash of the card, the profile's digest and the resolved runtime settings; releasing the same content again returns the stored release with `created: false`. The optional `note` (trimmed, 1 to 200 characters) is stored with the release but is not part of its id, so a re-release keeps the note it was first made with. A card tool outside the profile, a different model or an unknown profile answers 422. `repository_id` names the catalog repository the release pins (`GET /v1/profiles`, `repository_ids`): required when the profile's `repository_mode` is `required` (422 `repository_id: Profile <id> needs a repository: send repository_id`), refused when it is `none`, and 422 when the catalog has no such repository or it does not allow the profile. Slack sessions and API sessions that send no `repository_id` start on it only while the agent has no GitHub settings; an agent with settings starts them without a repository. A profile the operator blocked, or one over a blocked base, answers 409 PROFILE_BLOCKED. A request carrying `github` for an agent that already has GitHub settings answers 409 ALREADY_EXISTS with `reason_code: github_settings_exist`: those are saved with `PUT /v1/agents/{id}/github/settings`. Releasing approves and activates nothing.",
    auth: "session",
    body: "CreateAgentReleaseRequest",
    success: { status: 200, schema: "CreateAgentReleaseResponse" },
    errors: [400, 401, 403, 404, 409, 413, 422, 503],
    errorCodes: { 409: ["PROFILE_BLOCKED", "ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/activate",
    operationId: "activateAgent",
    tag: "Agents",
    summary: "Point the agent at a release (compare-and-swap)",
    description:
      "`expected_revision` is the agent's current `activation_revision` (-1 before the first activation); a stale one answers 409 REVISION_CONFLICT. Sending the same activation again is a no-op with a null `receipt_id`. A release whose runtime profile changed since answers 409 PROFILE_DIGEST_MISMATCH and has to be released again; one whose profile the operator blocked answers 409 PROFILE_BLOCKED. A release whose card names a credential not bound to the agent answers 409 CREDENTIAL_UNBOUND with the missing names in `details.missing` (`ActivationCredentialUnboundDetails`). Sessions already pinned keep their release.",
    auth: "session",
    body: "ActivateAgentRequest",
    success: { status: 200, schema: "ActivateAgentResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "REVISION_CONFLICT",
        "PROFILE_DIGEST_MISMATCH",
        "PROFILE_BLOCKED",
        "CREDENTIAL_UNBOUND",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "listCredentialBindings",
    tag: "Agents",
    summary: "The credential names bound to an agent",
    description:
      "Owners, admins and those inside the agent: its admins and the live members of its managing team, who read it without binding. Each binding carries `running_sessions`, the sessions of this agent that name it and have not closed, with the `revoke_notice` the unbind screen shows: unbinding stops the next session and the next message of a running one, and cuts its remote MCP calls within 30 seconds. Names only; no value is ever stored.",
    auth: "session",
    success: { status: 200, schema: "ListCredentialBindingsResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "createCredentialBinding",
    tag: "Agents",
    summary: "Bind a credential name to an agent",
    description:
      "Owners, admins and the agent's admins; never an API key. `credential_ref` names a credential held outside Werft (a secret store entry, a remote MCP server connection). Binding a name already bound answers `created: false` and a null `receipt_id`; otherwise writes a `bind_credential` receipt. A name an agent identity holds answers 409 CREDENTIAL_REF_IN_USE.",
    auth: "session",
    body: "CreateCredentialBindingRequest",
    success: { status: 200, schema: "CreateCredentialBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["CREDENTIAL_REF_IN_USE"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/credential-bindings/{binding_id}",
    operationId: "revokeCredentialBinding",
    tag: "Agents",
    summary: "Unbind a credential name from an agent",
    description:
      "Takes what binding takes. The next session of a release naming it, and the next message to a running one, is refused 409 CREDENTIAL_UNBOUND with a failed receipt; a running session's remote MCP calls are refused from the next exchange and an open one is cut within 30 seconds, while a call already sent finishes. The answer's `binding.running_sessions` and `revoke_notice` say so. Writes an `unbind_credential` receipt; a binding already revoked is not found.",
    auth: "session",
    success: { status: 200, schema: "RevokeCredentialBindingResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspace/variables",
    operationId: "listWorkspaceVariables",
    tag: "Variables",
    summary: "The workspace's own variables",
    description:
      "Owners and admins; never an API key. A plain variable carries its `value`; a secret never does. `granted_agents` is who may receive it, `grant_all` that every agent may (plain only).",
    auth: "session",
    success: {
      status: 200,
      schema: "EnvVariableList",
      description: "The workspace's variables, by name.",
      example: { items: [EXAMPLE_ENV_VARIABLE] },
    },
    errors: [401, 403, 503],
  },
  {
    method: "put",
    path: "/v1/workspace/variables/{name}",
    operationId: "putWorkspaceVariable",
    tag: "Variables",
    summary: "Create or replace a workspace variable",
    description:
      "Owners and admins, signed in as a person; never an API key. `If-None-Match: *` creates, `If-Match: <version>` replaces the value. A new variable reaches no agent until it is granted. Only `kind: plain` is accepted for now: a secret answers 400 SECRET_ENV_UNSUPPORTED. The value is text of at most 48 KB without NUL bytes. Writes a `set_env_variable` receipt that names the variable and its version, never the value.",
    auth: "session",
    body: "PutEnvVariableRequest",
    requestExample: { kind: "plain", value: "ap-northeast-1" },
    success: {
      status: 200,
      schema: "PutEnvVariableResponse",
      description: "The variable's new `version` and its `grant_version`.",
      example: { name: "REGION", version: 44, grant_version: 42 },
    },
    errors: [400, 401, 403, 409, 412, 413, 428, 503],
    errorCodes: {
      400: [
        "BAD_REQUEST",
        "VARIABLE_NAME_INVALID",
        "VARIABLE_NAME_RESERVED",
        "VARIABLE_VALUE_INVALID",
        "VARIABLE_VALUE_TOO_LARGE",
        "SECRET_ENV_UNSUPPORTED",
      ],
      409: ["VARIABLE_QUOTA_EXCEEDED"],
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "version",
    ifNoneMatch: true,
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspace/variables/{name}",
    operationId: "deleteWorkspaceVariable",
    tag: "Variables",
    summary: "Delete a workspace variable",
    description:
      "Takes what writing takes, and `If-Match: <version>`. `affected_agents` counts the agents that received the value and `open_sessions` the sessions not closed yet that copied it when they started: those keep the value until they close. Writes a `delete_env_variable` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteEnvVariableResponse",
      description:
        "How many agents received the value and sessions still hold it.",
      example: { affected_agents: 3, open_sessions: 1 },
    },
    errors: [400, 401, 403, 404, 412, 428, 503],
    errorCodes: {
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "version",
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspace/variables/{name}/grants",
    operationId: "putWorkspaceVariableGrants",
    tag: "Variables",
    summary: "Replace the agents that may receive a workspace variable",
    description:
      "Owners and admins; never an API key. The whole set is replaced. `grant_all: true` takes no `agents`. `If-Match: <grant_version>` is required, so two edits of the same grants cannot overwrite each other: the later one answers 412. Writes a `set_env_variable_grants` receipt with the set before and after.",
    auth: "session",
    body: "PutEnvVariableGrantsRequest",
    requestExample: { grant_all: false, agents: [{ id: EXAMPLE_AGENT_ID }] },
    success: {
      status: 200,
      schema: "PutEnvVariableGrantsResponse",
      description: "The grants now held, and their new `grant_version`.",
      example: { name: "REGION", grant_version: 43 },
    },
    errors: [400, 401, 403, 404, 412, 413, 428, 503],
    errorCodes: {
      400: ["BAD_REQUEST", "SECRET_GRANT_ALL_FORBIDDEN"],
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "grant_version",
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/variables",
    operationId: "listAgentVariables",
    tag: "Variables",
    summary: "The variables an agent has",
    description:
      "Owners, admins and that agent's admins; never an API key. `items` are the agent's own; `granted_workspace_values` are the workspace values granted to it, the only workspace values this answer shows. `effective` lists each name once with its `source`; `workspace_value_ungranted` says a workspace variable of the same name exists but is not granted to this agent, with no value. A secret never carries a value.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentEnvVariables",
      description:
        "The agent's own variables and the workspace values it gets.",
      example: {
        effective: [
          {
            name: "REGION",
            kind: "plain",
            source: "workspace",
            shadows_workspace: false,
            workspace_value_ungranted: false,
          },
        ],
        items: [],
        granted_workspace_values: [
          { name: "REGION", kind: "plain", value: "ap-northeast-1" },
        ],
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/variables/{name}",
    operationId: "putAgentVariable",
    tag: "Variables",
    summary: "Create or replace an agent's own variable",
    description:
      "Owners, admins and that agent's admins, signed in as a person; never an API key. Preconditions, limits and receipt as for the workspace's variables; an agent holds 50. The agent's value wins over a workspace value of the same name.",
    auth: "session",
    body: "PutEnvVariableRequest",
    requestExample: { kind: "plain", value: "ap-northeast-1" },
    success: {
      status: 200,
      schema: "PutEnvVariableResponse",
      description: "The variable's new `version` and its `grant_version`.",
      example: { name: "REGION", version: 44, grant_version: 42 },
    },
    errors: [400, 401, 403, 404, 409, 412, 413, 428, 503],
    errorCodes: {
      400: [
        "BAD_REQUEST",
        "VARIABLE_NAME_INVALID",
        "VARIABLE_NAME_RESERVED",
        "VARIABLE_VALUE_INVALID",
        "VARIABLE_VALUE_TOO_LARGE",
        "SECRET_ENV_UNSUPPORTED",
      ],
      409: ["VARIABLE_QUOTA_EXCEEDED"],
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "version",
    ifNoneMatch: true,
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/variables/{name}",
    operationId: "deleteAgentVariable",
    tag: "Variables",
    summary: "Delete an agent's own variable",
    description:
      "Takes what writing takes, and `If-Match: <version>`. `open_sessions` counts the sessions not closed yet that copied the value when they started.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteEnvVariableResponse",
      description:
        "How many agents received the value and sessions still hold it.",
      example: { affected_agents: 3, open_sessions: 1 },
    },
    errors: [400, 401, 403, 404, 412, 428, 503],
    errorCodes: {
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "version",
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/identities",
    operationId: "linkAgentIdentity",
    tag: "Agents",
    summary: "Pin the agent to its Slack app's install in one team",
    description:
      "Slack events from that app and team then resolve to this agent and no other; events from another app, or after the identity or the install is revoked, are dropped. The install must be verified for the workspace (409 SLACK_NOT_INSTALLED); one already pinned to another agent answers 409 AGENT_IDENTITY_TAKEN, and to this agent 409 ALREADY_EXISTS. `credential_ref` names the bot token in the secret store, never its value, and is this identity's alone: a name bound to an agent or another identity answers 409 CREDENTIAL_REF_IN_USE, and the name is freed when the identity is revoked. Owners, admins and the agent's admins; API keys are refused. Writes a `link_agent_identity` receipt.",
    auth: "session",
    body: "LinkAgentIdentityRequest",
    success: { status: 201, schema: "LinkAgentIdentityResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "AGENT_IDENTITY_TAKEN",
        "ALREADY_EXISTS",
        "CREDENTIAL_REF_IN_USE",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/identities",
    operationId: "listAgentIdentities",
    tag: "Agents",
    summary: "The agent's Slack app identities",
    description:
      "Active first, then revoked, newest first within each; up to 50. Owners, admins, the agent's admins and the live members of its managing team.",
    auth: "session",
    success: { status: 200, schema: "ListAgentIdentitiesResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/identities/{identity_id}",
    operationId: "revokeAgentIdentity",
    tag: "Agents",
    summary: "Revoke an agent identity",
    description:
      "Events from that app and team are dropped from then on, including events already waiting to be processed. Revoking one already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_agent_identity` receipt. The agent's Slack channel bindings in that install are revoked with it. Linking again makes a new identity.",
    auth: "session",
    success: { status: 200, schema: "RevokeAgentIdentityResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack-bindings",
    operationId: "listSlackBindings",
    tag: "Agents",
    summary: "The agent's Slack channel bindings",
    description:
      "Live bindings of the channels of the agent's Slack app, and its DM binding (`surface_kind: dm`, no `external_surface_id`): the home channel first, then oldest first; up to 500. Channel ids only; the console resolves names. A binding's `status` is `ready` (in use), `pending_approval` (a private channel waiting for an owner or admin) or `left` (the bot was removed from or left the private channel: inactive, no input is taken and nothing is sent there, `membership.state` is `awaiting_invite`, `approved_at` is null; its `mode` and `ceiling` are kept). Owners, admins, the agent's admins and the live members of its managing team.",
    auth: "session",
    success: { status: 200, schema: "ListSlackBindingsResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/slack-bindings",
    operationId: "putSlackBinding",
    tag: "Agents",
    summary: "Set how the agent answers in one Slack channel or its DMs",
    description:
      "Replaces the binding of `channel_id` in the agent's Slack app install, or the install's one DM binding when `channel_id` is null, creating it the first time. The channel's kind is what Slack's `conversations.info` answers with the bot token; `channel_kind`, when sent, only has to agree on whether this is the DM row (400 when Slack names a DM or does not know the channel, 503 when Slack cannot be read). `mode` is `off` (the channel takes nothing; a mention there is refused) or `on` (in use; the agent's `mention_only` setting says whether it also answers a top-level message without a mention).`home: true` makes this channel the agent's home and clears the previous one; a DM is never home. A missing `ceiling` is the default: every Slack action, shown in full. The agent needs a live Slack app identity (409 SLACK_NOT_INSTALLED); a concurrent change to the same channel or home answers 409 REVISION_CONFLICT. The bot does not join the channel here. A binding that is `left` stays `left` when saved for its private channel (its `mode` and `ceiling` are edited, `home: true` answers 400); saved for a channel Slack now calls public, it is `ready` again. Owners, admins and the agent's admins; API keys are refused. Writes a `set_surface_binding` receipt.",
    auth: "session",
    body: "PutSlackBindingRequest",
    success: { status: 200, schema: "PutSlackBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["SLACK_NOT_INSTALLED", "REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack-bindings/{binding_id}/approve",
    operationId: "approveSlackBinding",
    tag: "Agents",
    summary: "Approve a private Slack channel",
    description:
      "A binding of a private channel starts as `pending_approval` and takes no input until an owner or admin approves it here: it becomes `ready` and `approved_at` is set, and a message sent before `approved_at` is not answered. `revision` is the revision the caller read; a binding that is not waiting (a `left` one included: the bot is not in the channel, and is invited again first, which makes it wait), or changed since, answers 409 REVISION_CONFLICT. The same approval again, after it landed, answers the binding as it is with a null `receipt_id`. Owners and admins only, not the agent's admins; API keys are refused. Writes a `resolve_surface_binding` receipt.",
    auth: "session",
    body: "ResolveSlackBindingRequest",
    success: { status: 200, schema: "ResolveSlackBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack-bindings/{binding_id}/reject",
    operationId: "rejectSlackBinding",
    tag: "Agents",
    summary: "Reject a private Slack channel",
    description:
      "Revokes a binding that waits for approval, so its channel slot is free again. The bot stays in the channel and takes no input; remove it in Slack to make it leave. `revision` is the revision the caller read; a binding that is not waiting (a `left` one included), or changed since, answers 409 REVISION_CONFLICT. The same rejection again answers the binding as it is with a null `receipt_id`. Owners and admins only; API keys are refused. Writes a `resolve_surface_binding` receipt.",
    auth: "session",
    body: "ResolveSlackBindingRequest",
    success: { status: 200, schema: "ResolveSlackBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack-channels",
    operationId: "lookupSlackChannels",
    tag: "Agents",
    summary: "Resolve up to 50 Slack channel IDs by name",
    description:
      "Accepts comma-separated IDs only, with no cursor or full scan. Reads conversations.info concurrently and caches each app and channel for 60 seconds, coalescing concurrent reads. IDs Slack reports as missing or inaccessible return state and name unknown. Transport failures and upstream errors answer 503 without caching; a revoked or invalid bot token answers 409 SLACK_NOT_INSTALLED. Slack rate limits answer 503 with Retry-After. Agent managers only.",
    auth: "session",
    query: "LookupSlackChannelsQuery",
    success: {
      status: 200,
      schema: "LookupSlackChannelsResponse",
      description: "Names for the requested IDs.",
      example: { items: [{ id: "C0DEPLOY1", name: "deploy", state: "known" }] },
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["SLACK_NOT_INSTALLED"] },
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/channels",
    operationId: "searchSlackChannels",
    tag: "Agents",
    summary: "Search the channels the agent's Slack bot can see",
    description:
      "Channels whose name starts with `q` (any case, a leading `#` ignored), by name, `limit` per page (default 20, at most 50): every public channel of the install and the private ones the bot is already in. `is_member` says whether the bot is in the channel. The server reads the app's whole list from Slack (`conversations.list` with the bot token) and keeps it for 60 seconds per app, up to 10,000 channels (`truncated: true` past that); a binding change in the same API process drops it sooner. Pass `next_cursor` back as `cursor` with the same `q` for the next page; once the list it pages through has been replaced the cursor answers 400 CURSOR_EXPIRED, and the search starts over. When Slack rate limits, the last list read is returned with `stale: true`, or 503 with Slack's `Retry-After` when there is none; Slack is not asked again before then. The agent needs an installed Slack app with a bot token (409 SLACK_NOT_INSTALLED). Owners, admins and the agent's admins.",
    auth: "session",
    query: "SearchSlackChannelsQuery",
    success: {
      status: 200,
      schema: "SearchSlackChannelsResponse",
      description: "One page of matching channels.",
      example: {
        items: [
          {
            id: "C0DEPLOY1",
            name: "deploy",
            is_private: false,
            is_member: true,
          },
          {
            id: "G0DESIGN1",
            name: "design",
            is_private: true,
            is_member: true,
          },
        ],
        next_cursor: "eyJzIjoiYWJjIiwibyI6MiwicSI6ImRlIn0",
        truncated: false,
        stale: false,
      },
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: {
      400: ["BAD_REQUEST", "CURSOR_EXPIRED"],
      409: ["SLACK_NOT_INSTALLED"],
    },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when Slack is rate limiting with no list read yet (`Retry-After` is Slack's), when Slack does not answer, or when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app/manifest",
    operationId: "getSlackAppManifest",
    tag: "Agents",
    summary: "Read the agent app manifest as YAML",
    description:
      "Builds the manifest from the agent and server configuration without reading secret values. Owners, admins, the agent's admins and the live members of its managing team, with a web session only.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppManifestResponse",
      description: "The generated manifest without secret values.",
      example: { manifest_yaml: "display_information:\n  name: Agent\n" },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app/settings",
    operationId: "getSlackAppSettings",
    tag: "Agents",
    summary: "Read whether the agent answers only when mentioned in Slack",
    description:
      "Returns `mention_only`: `true` (the initial value) answers only a mention, `false` also any person's top-level message without one. Either way, a reply in a thread already linked to the agent's session continues it without a mention. It covers every channel in use, connected before or after; DMs do not follow it. Owners, admins, the agent's admins and the live members of its managing team, with a web session only.",
    auth: "session",
    success: {
      status: 200,
      schema: "SlackAppSettings",
      description: "The saved setting.",
      example: { mention_only: true },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/slack/app/settings",
    operationId: "putSlackAppSettings",
    tag: "Agents",
    summary: "Save whether the agent answers only when mentioned in Slack",
    description:
      "Saves `mention_only` for every channel of the agent that is in use, the ones already connected included; the next message reads it. DMs do not follow it. Agent managers with a web session only.",
    auth: "session",
    body: "SlackAppSettings",
    requestExample: { mention_only: false },
    success: {
      status: 200,
      schema: "SlackAppSettings",
      description: "The saved setting.",
      example: { mention_only: true },
    },
    errors: [400, 401, 403, 404, 413, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github",
    operationId: "getAgentGitHub",
    tag: "Agents",
    summary: "The agent's GitHub switch, settings and what may be turned on",
    description:
      "`enabled` is the switch that applies at once (`PUT …/github/enabled`). `github` is the agent's own GitHub settings, or the active release's pin while the agent has none; null when neither exists, when `legacy_defaults` is what a first save starts from (no repository, push approval off, nothing optional; the release itself keeps asking a person before each push until settings are saved). `settings_revision` is the row's revision (null without a row) and `start_repository_id` a repository kept for compatibility: once the agent has a settings row, a session naming none starts without a repository whatever this holds, and attaches what the task needs. `push_attached` (`allow`, `ask` or `deny`) says whether a push to a repository the session attached needs a person: the row's value, `ask` for a row saved before the field existed, and `allow` while there is no row (what a first save writes). Settings are saved with `PUT …/github/settings`, never as a release. `options.repositories` lists the catalog's GitHub repositories with why one cannot be picked (`repository_not_allowed` by the workspace's repository ceiling; `repository_ceiling_unset` is true while the workspace has none yet, and the list is then judged against the default the first save writes, without writing it on this read), and `installed`: whether the author and the reviewer App are installed on each, as GitHub answers now (null when there is no such App or no answer). `options.features` says, per optional permission, why it cannot be turned on: `github_host_unsupported` (every chosen repository is on a GitHub Enterprise host), `over_workspace_ceiling`, `no_reviewer_app`, or `app_permission_missing` (the App's permissions as last read lack it; the token request decides). Whoever manages the agent reads it, and so do the live members of its managing team.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentGitHubResponse",
      description: "The switch, the pinned settings and the options.",
      example: {
        enabled: true,
        active_release_id: "rel_example",
        settings_revision: 3,
        start_repository_id: "werft-sandbox",
        push_attached: "allow",
        github: {
          repositories: ["werft-sandbox"],
          push_approval: true,
          features: {
            workflows: false,
            actions: true,
            checks: false,
            issues: false,
            review: false,
          },
          actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
        },
        legacy_defaults: null,
        options: {
          repository_ceiling_unset: false,
          repositories: [
            {
              id: "werft-sandbox",
              url: "https://github.com/example/werft-sandbox",
              available: true,
              reason: null,
              installed: { author: true, reviewer: null },
            },
          ],
          features: {
            workflows: { available: false, reason: "app_permission_missing" },
            actions: { available: true, reason: null },
            checks: { available: false, reason: "over_workspace_ceiling" },
            issues: { available: false, reason: "over_workspace_ceiling" },
            review: { available: false, reason: "no_reviewer_app" },
          },
        },
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github/repositories",
    operationId: "listAgentGitHubRepositories",
    tag: "Agents",
    summary: "A page of the author App's repositories, to pick for the agent",
    description:
      "The repositories one installation of the author App reaches, a page at a time, as `GET /v1/workspaces/{id}/github-repositories` pages them (its failures too), with `catalog_id` set on those a pick resolved already; `installations` lists only the author Apps'. With several author connections, `installation_id` is required (400 `installation_required`). Only when the workspace's `repository_ceiling` runs on every App repository (`github_app_repositories: installed`); otherwise `unavailable` is `ceiling_listed` (pick among `options.repositories` of `GET /v1/agents/{id}/github`), and the page is empty. Whoever manages the agent reads it.",
    auth: "session",
    query: "GitHubRepositoryPageQuery",
    success: {
      status: 200,
      schema: "ListAgentGitHubRepositoriesResponse",
      description: "The page.",
      example: {
        installations: [EXAMPLE_GITHUB_INSTALLATION_SUMMARY],
        installation_id: 4242,
        page: 1,
        per_page: 30,
        total_count: 1,
        repositories: [
          {
            github_repository_id: 123456789,
            full_name: "acme/app",
            default_branch: "main",
            private: true,
            catalog_id: null,
          },
        ],
        unavailable: null,
      },
    },
    errors: [400, 401, 403, 404, 409, 502],
    errorCodes: {
      409: ["INSTALLATION_SUSPENDED"],
      502: ["GITHUB_UNAVAILABLE"],
    },
  },
  {
    method: "post",
    path: "/v1/agents/{id}/github/repositories",
    operationId: "pickAgentGitHubRepository",
    tag: "Agents",
    summary: "Resolve an App repository to the catalog id the settings name",
    description:
      "Takes a repository from `GET …/github/repositories` and returns the catalog id to put in `settings.repositories` of the next `PUT /v1/agents/{id}/github/settings`; nothing about the agent's settings or releases changes. The server reads the repository by its GitHub id and checks that the named installation covers it, then takes its URL and default branch from GitHub. The same repository always resolves to the same id, by its GitHub id: the first pick writes a `resolve_repository` receipt (`receipt_id`), and so does a pick after a rename on GitHub, which moves the row to the new name and URL; other picks return null. A repository with no author pin yet is pinned to the connection whose App holds the installation (a `set_repository_github_app` receipt), and `connection_id` names the author connection it is pinned to; a pin made before stays. 400 `details.reason_code`: `repository_not_allowed` (the workspace's ceiling does not run on App repositories), `no_author_app`, `not_installed` (the author App has no such installation, or it does not cover the repository), or `name_held` (another row has that name: another GitHub repository's, whose pick after its rename frees the name, or one not yet tied to a GitHub id). GitHub not answering is 502 `GITHUB_UNAVAILABLE`, and an installation GitHub dropped while it was read is 404 `installation_not_found`; nothing stored changed. A signed-in manager of the agent; API keys are refused.",
    auth: "session",
    body: "PickAgentGitHubRepositoryRequest",
    requestExample: { installation_id: 4242, github_repository_id: 123456789 },
    success: {
      status: 200,
      schema: "PickAgentGitHubRepositoryResponse",
      description:
        "The catalog id, and the receipt when this pick added or renamed its row.",
      example: { catalog_id: "app", receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 502, 503],
    errorCodes: { 502: ["GITHUB_UNAVAILABLE"] },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/agents/{id}/github/settings",
    operationId: "putAgentGitHubSettings",
    tag: "Agents",
    summary: "Save the agent's GitHub settings",
    description:
      "Replaces the agent's whole settings row in one transaction and makes no release: a new session reads it at once, and a change that narrows reaches running sessions too. `expected_revision` is `settings_revision` as read (null when there was no row); another value answers 409 `REVISION_CONFLICT`. `push_attached` is optional: left out, a first save writes `allow` and a later save keeps the row's value. `updated_by` is always the caller, so the first save of an agent also fixes the rollback floor at the snapshot-reading image. Only repositories the save adds are checked against the catalog and the workspace's repository ceiling, and features it turns on against the feature ceiling (400 with `reason_code`). Writes a `set_agent_github` receipt with `result.change = \"settings\"` and the values before and after; `receipt_id` is null when a person's row already held them. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentGitHubSettingsRequest",
    requestExample: {
      expected_revision: 3,
      settings: {
        repositories: ["werft-sandbox"],
        push_approval: true,
        features: {
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
        },
        actions_allow: [{ workflow: "ci.yml" }],
      },
      start_repository_id: "werft-sandbox",
      push_attached: "allow",
    },
    success: {
      status: 200,
      schema: "PutAgentGitHubSettingsResponse",
      description: "Saved.",
      example: { settings_revision: 4, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/agents/{id}/github/repository-access",
    operationId: "putAgentGitHubRepositoryAccess",
    tag: "Agents",
    summary: "Turn one GitHub repository on or off for the agent",
    description:
      "One toggle, one change, no release: a new session reads it at once, and turning a repository off reaches running sessions too. `repository` is a `ref` from `GET …/github` (`selected_repositories`, `options.repositories`) to turn a repository the catalog holds on or off, or `installation_id` with `github_repository_id` from `GET …/github/repositories` to turn on one the catalog may not hold yet; a repository is turned off by its `ref` only. The catalog row (added, or moved to a new name after a rename on GitHub), the settings, the receipts and the author App pin are written in one transaction, so a refusal or a failure anywhere leaves none of them. The change is applied to the row as it stands, so toggles of other repositories are kept and the last one of a repository stays. `expected_revision` is optional: left out, nothing is compared; given (null when there was no row) and different, the answer is 409 `REVISION_CONFLICT` with `details.revision`, and the caller reads `GET …/github` again. Turning off the repository `start_repository_id` names clears `start_repository_id`. An agent with no settings row starts from its active release's GitHub pins, read under the agent's lock; with no active release, or pins this image cannot read, that is 409 `REVISION_CONFLICT` with `reason_code: settings_seed_unavailable`. 400 `reason_code`: `invalid_ref`, `repository_not_found`, `repository_not_allowed` (the workspace's repository ceiling; a repository picked from an installation also needs a ceiling that runs on the App's repositories), `app_required`, `name_held` (another row has that name), `no_author_app` or `not_installed` (as `POST …/github/repositories`). Writes a `set_agent_github` receipt with `result.change = \"repository\"` when the settings changed; `receipt_id` is null when the repository already was in that state. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentGitHubRepositoryAccessRequest",
    requestExample: {
      repository: { ref: "r1.d2Vyc3QtYXBw" },
      enabled: true,
    },
    success: {
      status: 200,
      schema: "PutAgentGitHubRepositoryAccessResponse",
      description: "The repository is in the requested state.",
      example: {
        settings_revision: 4,
        receipt_id: EXAMPLE_RECEIPT_ID,
        enabled: true,
        repository: {
          ref: "r1.d2Vyc3QtYXBw",
          repository: "octo/werft-app",
          private: null,
        },
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 502, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"], 502: ["GITHUB_UNAVAILABLE"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/mcp/settings",
    operationId: "getAgentMcpSettings",
    tag: "Agents",
    summary: "The agent's MCP server, tools and credential names",
    description:
      "`source` is `agent` when the agent has saved settings (`settings_revision` is their revision) and `release` while it has none: `settings` then holds what the active release's card and policy pins say, which is what a session of that release does today. `settings.allowed_tools` are full `mcp__<server>__<tool>` names and empty when `server` is null; `settings.credential_refs` are credential names, never values. `bound_credential_refs` lists those of `settings.credential_refs` that have a live binding on the agent; a name without one blocks a new session until it is bound. `available_servers` lists, sorted and by id only, the servers a save may choose for this agent's workspace (never the built-in `github`, never a server's address or credentials). Saved with `PUT …/mcp/settings`, never as a release. Whoever manages the agent reads it, and so do the live members of its managing team.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentMcpResponse",
      description: "The settings and the revision that guards them.",
      example: {
        source: "agent",
        settings: {
          server: "docs",
          allowed_tools: ["mcp__docs__read", "mcp__docs__search"],
          credential_refs: ["docs-key"],
        },
        settings_revision: 2,
        active_release_id: "rel_example",
        bound_credential_refs: ["docs-key"],
        available_servers: ["docs"],
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/mcp/settings",
    operationId: "putAgentMcpSettings",
    tag: "Agents",
    summary: "Save the agent's MCP settings",
    description:
      "Replaces the agent's whole settings row in one transaction and makes no release: a new session reads it at once, a change that narrows reaches running sessions too, and a change that widens only sessions that start after it. `expected_revision` is `settings_revision` as read (null when there was no row); another value answers 409 `REVISION_CONFLICT`. `updated_by` is always the caller, so the first person's save of an agent also fixes the rollback floor at the snapshot-reading image. A server the save adds must be in the catalog (400 `server_unknown`; `server_builtin` for the built-in one); every `allowed_tools` name must be `mcp__<server>__<tool>` of the chosen server (`tool_outside_server`; the name has no spaces or control characters and is at most 128 characters), a tool the save adds that the active release's profile blocks is refused (`mcp_tool_denied`; a tool the row already holds can still be narrowed away), with no server there are none (`server_required`), and the server's credential name must be in `credential_refs` (`server_credential_missing`). A repeated tool or credential name is refused (`duplicate`). Binding the credentials is not required to save. Writes a `set_agent_mcp` receipt with `result.change = \"settings\"` and the names before and after; `receipt_id` is null when a person's row already held them. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentMcpSettingsRequest",
    requestExample: {
      expected_revision: 2,
      settings: {
        server: "docs",
        allowed_tools: ["mcp__docs__read"],
        credential_refs: ["docs-key"],
      },
    },
    success: {
      status: 200,
      schema: "PutAgentMcpSettingsResponse",
      description: "Saved.",
      example: { settings_revision: 3, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/engine-settings",
    operationId: "getWorkspaceEngineSettings",
    tag: "Workspace settings",
    summary: "The workspace's saved engine rules",
    description:
      "The rules every agent of the workspace runs under: `settings.permissions` (`allow`, `ask`, `deny`: tool rules in the engine's spelling) and `settings.auto_mode` (`allow`, `soft_deny`, `hard_deny`, `environment`: sentences the auto-mode classifier reads). A list that is absent holds nothing. `settings_revision` is null while nothing is saved. `writes_open` says whether a save is accepted now; reading is always open. Any member of the workspace reads it, with a console session or with that member's personal API key; an agent's key and the operator key read nothing here.",
    scope: "read",
    success: {
      status: 200,
      schema: "WorkspaceEngineSettingsResponse",
      description: "The rules and the revision that guards them.",
      example: {
        settings: {
          permissions: { deny: ["Bash(rm:*)"] },
          auto_mode: {},
        },
        settings_revision: 2,
        writes_open: true,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/engine-settings",
    operationId: "putWorkspaceEngineSettings",
    tag: "Workspace settings",
    summary: "Save the workspace's engine rules",
    description:
      "Replaces the whole rule set in one transaction. `expected_revision` is `settings_revision` as read (null when nothing was saved); another value answers 409 `REVISION_CONFLICT`. The rules are checked against every installed tool catalog before anything is locked: a rule the engine would drop without a word is 400 with the parser's `reason_code` (`unknown_tool`, `too_many_rules`, `settings_too_large`, `mcp_rule_verdict`, ...), and `engine_settings_catalog_ambiguous` when two catalogs would store a rule differently. While the installation's gate is shut the answer is 403 `engine_settings_writes_closed`; rules already saved keep applying. Restrictions (`deny`, `ask`, `soft_deny`, `hard_deny`) add to every agent's own; grants (`allow`, `environment`) reach an agent only where the agent's own list holds the same entry. Writes a `set_workspace_engine_settings` receipt with the rule counts and sizes before and after, never a rule's text; `receipt_id` is null when the workspace already held these rules. Workspace owners and admins with a web session only; API keys are refused.",
    auth: "session",
    body: "PutEngineSettingsRequest",
    requestExample: {
      expected_revision: 2,
      settings: {
        permissions: { deny: ["Bash(rm:*)"] },
        auto_mode: {},
      },
    },
    success: {
      status: 200,
      schema: "PutEngineSettingsResponse",
      description: "Saved.",
      example: { settings_revision: 3, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/engine-settings",
    operationId: "getAgentEngineSettings",
    tag: "Agents",
    summary: "The agent's saved engine rules next to the workspace's",
    description:
      "`settings` are the agent's own rules and `settings_revision` guards them (null while none are saved). `workspace` repeats the workspace's rules, which also apply, read only here. `inherited` counts the restrictions the agent took over from its profile (`entries`, `rules`); the rules themselves are an operator's and are not shown. `reach` says what the allow lists do together: `agent_allow_without_effect` names the agent's `allow`/`environment` entries the workspace does not share, which do nothing because a grant needs both sides, and `workspace_allow_inactive` is true when the workspace allows something the agent's own list leaves empty. `writes_open` says whether a save is accepted now. Whoever manages the agent reads it, and so do the live members of its managing team, with a console session or with their personal API key; an agent's own key does not.",
    scope: "read",
    success: {
      status: 200,
      schema: "AgentEngineSettingsResponse",
      description: "The agent's rules, the workspace's and how they combine.",
      example: {
        settings: { permissions: { ask: ["WebFetch"] }, auto_mode: {} },
        settings_revision: 1,
        workspace: {
          settings: { permissions: { deny: ["Bash(rm:*)"] }, auto_mode: {} },
          settings_revision: 2,
        },
        inherited: { entries: 0, rules: 0 },
        reach: {
          agent_allow_without_effect: {
            permissions: [],
            auto_mode_allow: [],
            auto_mode_environment: [],
          },
          workspace_allow_inactive: false,
        },
        writes_open: true,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/engine-settings",
    operationId: "putAgentEngineSettings",
    tag: "Agents",
    summary: "Save the agent's engine rules",
    description:
      "Replaces the agent's own rule set in one transaction and makes no release: a session that starts afterwards reads it, and a session already running keeps the rules it started with unless a later save only narrows them. `expected_revision` and the checks are those of the workspace's save (409 `REVISION_CONFLICT`; 400 with the parser's `reason_code` or `engine_settings_catalog_ambiguous`; 403 `engine_settings_writes_closed` while the gate is shut). The restrictions the agent inherited from its profile are not part of this request and are left as they are. Writes a `set_agent_engine_settings` receipt with the rule counts and sizes before and after, never a rule's text; `receipt_id` is null when the agent already held these rules. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutEngineSettingsRequest",
    requestExample: {
      expected_revision: 1,
      settings: { permissions: { ask: ["WebFetch"] }, auto_mode: {} },
    },
    success: {
      status: 200,
      schema: "PutEngineSettingsResponse",
      description: "Saved.",
      example: { settings_revision: 2, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github/pull-request",
    operationId: "getAgentPullRequestSettings",
    tag: "Agents",
    summary: "How the agent's pull request bodies differ from the workspace's",
    description:
      "`pull_request` holds `formatting` (`inherit` follows the workspace; `on` or `off` overrides it), `template` (markdown up to 16 KiB that stands in for the workspace's `default_template`; null uses the workspace's) and `template_name` (which file of a repository's `.github/PULL_REQUEST_TEMPLATE/` directory to use when it holds several; matched to the names found there, never used as a path). An agent with nothing saved reads as `inherit`, no template, no name, with `pull_request_revision` 0. Kept apart from the agent's GitHub settings: saving it does not make the agent's sessions follow those instead of their release. Whoever manages the agent reads it, and so do the live members of its managing team.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentPullRequestResponse",
      description: "The agent's values and the revision that guards them.",
      example: {
        pull_request: {
          formatting: "inherit",
          template: null,
          template_name: "feature.md",
        },
        pull_request_revision: 2,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/github/pull-request",
    operationId: "putAgentPullRequestSettings",
    tag: "Agents",
    summary: "Change how the agent's pull request bodies are laid out",
    description:
      "Replaces the three values. `revision` is `pull_request_revision` as last read (0 when none was saved); a stale one is 409 `REVISION_CONFLICT` and nothing changes. A template the platform will not lay text around is 400 with `reason_code` `template_too_large`, `template_not_utf8` or `template_unsupported`. A change reaches pull requests the agent's sessions open or update afterwards; text already on GitHub is not rewritten. Writes a `set_agent_pull_request_settings` receipt with the values before and after (a template as its size and hash, never its text); `receipt_id` is null when nothing changed. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentPullRequestSettingsRequest",
    requestExample: {
      pull_request: {
        formatting: "inherit",
        template: null,
        template_name: "feature.md",
      },
      revision: 0,
    },
    success: {
      status: 200,
      schema: "PutAgentPullRequestSettingsResponse",
      description: "Stored; the values and their new revision.",
      example: {
        pull_request: {
          formatting: "inherit",
          template: null,
          template_name: "feature.md",
        },
        pull_request_revision: 1,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/agents/{id}/github/enabled",
    operationId: "putAgentGitHubEnabled",
    tag: "Agents",
    summary: "Turn the agent's GitHub use on or off",
    description:
      "Applies at once, without a release: off refuses every GitHub token for the agent's sessions from the next request on, running ones included (403 `GITHUB_REFUSED` `github_disabled`). Writes a `set_agent_github` receipt when the value changes; `receipt_id` is null when it already held. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentGitHubEnabledRequest",
    requestExample: { enabled: false },
    success: {
      status: 200,
      schema: "PutAgentGitHubEnabledResponse",
      description: "Saved.",
      example: { enabled: false, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github/activity",
    operationId: "getAgentGitHubActivity",
    tag: "Agents",
    summary: "The agent's latest GitHub receipts",
    description:
      "Up to 20 receipts, newest first: `set_agent_github`, `set_agent_mcp` (a save of the agent's MCP settings, with the names before and after and no values), the `create_agent_release` and `activate_agent` receipts that changed the GitHub settings (`result.github_changed`), and for the agent's sessions `mint_github_token` (a refusal is `failed` with `result.reason_code`), `dispatch_workflow`, `rerun_workflow` and `review_pull_request`. Found by target, not by actor, so a release a person made is listed. Session receipts come only from sessions the caller can see, filtered before the 20 are cut: an agent manager is not shown a private session nobody shared with them. Whoever manages the agent reads it, and so do the live members of its managing team.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentGitHubActivityResponse",
      description: "The receipts.",
      example: { items: [] },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app",
    operationId: "getSlackApp",
    tag: "Agents",
    summary: "The agent's Slack app, if the platform made one",
    description:
      "The agent's live Slack app (`creating`, `created` or `deleting`), or null when it has none. Secrets appear only as whether each is stored; `secrets.slack_bot_token.configured` says whether Slack handed over a bot token; an install refused after the code exchange keeps it, so the agent's `slack_bot` identity is what says the app is installed. The install link comes from `POST /v1/agents/{id}/slack/install/start`. `warnings` says why every Slack mention and DM would be refused with a notice in the thread: `no_active_release` before an activation, `profile_unavailable` (with the `profile_id`) while the catalog no longer has the active release's profile, defines it otherwise than it was released, or an owner blocked it, and `repository_required` (with the `profile_id`) while a session cannot start: the agent has no settings row and its release names no repository its profile needs, or names one the profile or the workspace's repository ceiling does not allow, or the agent's GitHub settings cannot be read. Connecting is not blocked. `config_token_issuer_changed` (with the app's maker as `previous_user_id` and the token's issuer as `user_id`) says the App Configuration Token now belongs to another Slack user than the one who made this app, who may not be able to manage it or install it. `config_token` is the workspace's App Configuration Token state (`unset`, `active`, `needs_reentry`), readable here by the agent's admins too: only `active` can create the app, and only an owner or admin can set it. Owners, admins, the agent's admins and the live members of its managing team; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppResponse",
      description: "The agent's app, or null.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        event_url:
          "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        events: {
          state: "pending",
          checked_at: "2026-10-28T00:00:00.000Z",
          url: "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        },
        warnings: [],
        config_token: "active",
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/app/events/recheck",
    operationId: "recheckSlackAppEvents",
    tag: "Agents",
    // Sending the same manifest again is harmless.
    idempotent: false,
    summary: "Send the agent app's Request URL to Slack again",
    description:
      "Sends the app's whole manifest again with its Request URL (`apps.manifest.update`), as the install does, so Slack checks the URL anew. Slack's check arrives as a signed `url_verification`, which the events route answers with its challenge and nothing else; the app then reads `events.state: verified`. An app already verified for the same URL stays verified; a changed URL reads `pending` until Slack checks it. `events.url` is the Request URL last sent to Slack, null before any. Owners, admins and the agent's admins from a signed-in console; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppResponse",
      description: "The agent's app after the manifest was sent.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        event_url:
          "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        events: {
          state: "verified",
          checked_at: "2026-10-28T00:00:00.000Z",
          url: "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        },
        warnings: [],
        config_token: "active",
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also without a master key (PLATFORM_SECRET_KEY), without an https events address (`CONSOLE_ORIGIN`, or `SLACK_EVENTS_PUBLIC_URL` when events enter apart from the console), or when Slack refuses or loses the manifest update.",
    },
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/app",
    operationId: "createSlackApp",
    tag: "Agents",
    summary: "Create the agent's Slack app",
    description:
      "Creates one Slack app for the agent with the workspace's App Configuration Token (`apps.manifest.create`): the agent's name, its bot, the agent view and the bot scopes, with no event subscriptions yet. The app is recorded as `creating` before Slack is asked; its signing and client secrets are stored by the server under the app and never returned. Asking again for an agent that has its app returns the same app with `created: false`. If Slack's answer was lost the app stays `creating` and the next request answers 409 SLACK_APP_CREATING; once `uncertain`, check api.slack.com/apps, delete any app made then, and retry with `replace_uncertain: true`. `warnings` says when the config token now belongs to another Slack user than the one who made the workspace's previous app (`config_token_issuer_changed`), and, as on GET, when the active release cannot start a session (`profile_unavailable`, `repository_required`); none stops the request. The agent needs an active release. Installing it into Slack starts at `POST /v1/agents/{id}/slack/install/start`. Owners, admins and the agent's admins from a signed-in console; API keys are refused.",
    auth: "session",
    body: "CreateSlackAppRequest",
    requestExample: { replace_uncertain: false },
    success: {
      status: 200,
      schema: "CreateSlackAppResponse",
      description:
        "The agent's app, whether this request created it, and any warnings.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        created: true,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "AGENT_NOT_ACTIVE",
        "CONFIG_TOKEN_INVALID",
        "SLACK_APP_CREATING",
        "REVISION_CONFLICT",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT: "Here: the agent's app is being deleted.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY) or `CONSOLE_ORIGIN`, when Slack refused the manifest (`error.details.slack_error`; nothing was created) or could not be reached.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/install/start",
    operationId: "startSlackInstall",
    tag: "Agents",
    summary: "Get a single-use link that installs the agent's Slack app",
    description: `Returns Slack's consent URL for the agent's app with a new OAuth \`state\`, valid ${SLACK_INSTALL_STATE_TTL_SECONDS / 60} minutes; every call makes another. The state is bound to the caller, the workspace, the agent and the app, and only that caller can complete it (\`POST /v1/slack/install/complete\`). The app must be \`created\`: none answers 404, one still being created 409 SLACK_APP_CREATING, one being deleted 409 REVISION_CONFLICT. When the config token belongs to the Slack user who made the app, Slack is first asked whether the app still exists (\`apps.manifest.export\`): when Slack says it does not, the answer is 409 SLACK_APP_GONE; when the check fails any other way, or the token is another Slack user's (GET warns with \`config_token_issuer_changed\`), the link is made anyway. The Slack team it must be installed in is the one the workspace's App Configuration Token belongs to (409 CONFIG_TOKEN_INVALID when none is set). Owners, admins and the agent's admins from a signed-in console; API keys are refused.`,
    auth: "session",
    success: {
      status: 200,
      schema: "StartSlackInstallResponse",
      description: "Where the browser goes next, and when the link expires.",
      example: {
        authorize_url: `${EXAMPLE_SLACK_AUTHORIZE_URL}&state=<single-use>`,
        expires_at: "2026-10-24T09:10:00Z",
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: {
      409: [
        "SLACK_APP_CREATING",
        "SLACK_APP_GONE",
        "REVISION_CONFLICT",
        "CONFIG_TOKEN_INVALID",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT: "Here: the agent's app is being deleted.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/slack/install/complete",
    operationId: "completeSlackInstall",
    tag: "Agents",
    summary: "Finish installing an agent's Slack app with what Slack returned",
    description:
      "The console's callback page sends the `state` and the `code` (or Slack's `error`) from Slack's redirect, with the agent it is for. The state is spent first, whatever happens next: unknown, spent, expired, or issued to another caller, workspace, agent or app answers 409 SLACK_INSTALL_STATE_INVALID with `error.details.reason_code`. An `error` from Slack (e.g. `access_denied`) answers 409 SLACK_INSTALL_DENIED. The code is exchanged with `oauth.v2.access`; unless the answer names the agent's app, the workspace's Slack team, no enterprise install and every bot scope, nothing is stored (409 SLACK_INSTALL_REJECTED). Then the bot token is sealed under the app (never returned), the install is verified with the token itself (`auth.test` and `bots.info`), the agent's identity is linked, and the steps after an install run; `finalized: false` says those failed and the install stands. Installing again with a new link replaces the bot token and keeps the one install. Every answer carries `Referrer-Policy: no-referrer`. Owners, admins and the agent's admins from a signed-in console; API keys are refused. A new identity writes a `link_agent_identity` receipt.",
    auth: "session",
    body: "CompleteSlackInstallRequest",
    requestExample: {
      agent_id: EXAMPLE_AGENT_ID,
      state: "state-from-the-redirect",
      code: "code-from-the-redirect",
    },
    success: {
      status: 200,
      schema: "CompleteSlackInstallResponse",
      description:
        "The app, its verified install, the agent's identity and whether the steps after the install ran.",
      example: {
        slack_app: {
          ...EXAMPLE_SLACK_APP,
          secrets: {
            ...EXAMPLE_SLACK_APP.secrets,
            slack_bot_token: {
              configured: true,
              last4: "a1b2",
              updated_at: "2026-10-24T09:05:00Z",
              updated_by: null,
            },
          },
        },
        installation: {
          id: "3c5e7a9b-1d2f-4a6b-8c0d-2e4f6a8b0c1d",
          app_id: EXAMPLE_SLACK_APP.app_id,
          team_id: "T0A1B2C3D",
          bot_user_id: "U0B1C2D3E",
          status: "verified",
        },
        agent_identity: {
          id: "5e7a9c1b-3d4f-4b6c-8d0e-4f6a8b0c2d3e",
          agent_id: EXAMPLE_AGENT_ID,
          provider: "slack_bot",
          app_id: EXAMPLE_SLACK_APP.app_id,
          team_id: "T0A1B2C3D",
          bot_user_id: "U0B1C2D3E",
          credential_ref: `slack_app:${EXAMPLE_SLACK_APP.id}/slack_bot_token`,
          status: "active",
          revision: 1,
          created_by: "7a9c1e3b-5d6f-4c8d-9e0f-6a8b0c2d4e5f",
          created_at: "2026-10-24T09:05:00Z",
          revoked_at: null,
        },
        receipt_id: "9c1e3a5b-7d8f-4e0a-8b1c-8b0c2d4e6f7a",
        finalized: true,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_INSTALL_STATE_INVALID",
        "SLACK_INSTALL_DENIED",
        "SLACK_INSTALL_REJECTED",
        "SLACK_INSTALL_CONFLICT",
        "AGENT_IDENTITY_TAKEN",
        "CREDENTIAL_REF_IN_USE",
        "REVISION_CONFLICT",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Here: the agent's app changed, or the install was revoked, while it was being installed; start again.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; start again.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/slack/events/{agent_id}",
    operationId: "receiveSlackEvent",
    tag: "Agents",
    summary: "Slack's Events API request URL for one agent's app",
    description:
      "Called by Slack, not by people: each agent app's event subscription points here (Finalize registers it when an https events address is known: `CONSOLE_ORIGIN`, or `SLACK_EVENTS_PUBLIC_URL` when events enter apart from the console). The body is read up to 256 KiB (413 above that), then checked in this order: the `v0` signature (`X-Slack-Signature`) over the raw bytes with the app's signing secret, the `X-Slack-Request-Timestamp` within 300 seconds, then the JSON. An unknown agent, an agent without a created app, an app without a signing secret, a wrong, missing or stale signature all answer the same 401. A signed `url_verification` answers its `challenge`. An `event_callback` is stored once per `(team_id, event_id)`, so Slack's retries (`X-Slack-Retry-Num`) answer 200 without a second row; one for another app or team than the agent's install, from a bot, or of a message subtype other than `thread_broadcast`, is stored as dropped with its reason. `app_uninstalled` and `tokens_revoked` mark the install revoked and revoke the agent's identity on it, so the console shows the app as needing a reinstall; a repeat or an event sent before a reinstall changes nothing. Any other envelope type answers 200 and is ignored. A failed write answers 5xx so Slack sends the event again. Rate limited per agent and overall before any database read (429).",
    auth: "public",
    body: "SlackEventEnvelope",
    requestExample: {
      token: "legacy-verification-token",
      team_id: "T0A1B2C3D",
      api_app_id: EXAMPLE_SLACK_APP.app_id,
      event: {
        type: "app_mention",
        user: "U0PERSON1",
        text: "<@U0B1C2D3E> summarize this thread",
        channel: "C0CHANNEL1",
        ts: "1761300000.000100",
      },
      type: "event_callback",
      event_id: "Ev0A1B2C3D4E",
      event_time: 1761300000,
    },
    success: {
      status: 200,
      schema: "SlackEventsResponse",
      description:
        '`{"challenge": ...}` for a url_verification, `{"ok": true}` for everything else that was signed.',
      example: { ok: true },
    },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/slack/interactions/{agent_id}",
    operationId: "receiveSlackInteraction",
    tag: "Agents",
    summary: "Slack's interactivity request URL for one agent's app",
    description:
      'Called by Slack, not by people: each agent app\'s interactivity points here, beside its events route (Finalize registers both when an https events address is known, as for the events route). It takes the buttons and the modal of the messages the agent posts in a thread when its session waits on a person: allow or deny a tool permission, answer a question, approve or reject a push request. The form body is read up to 256 KiB (413 above that) and checked as events are: the `v0` signature over the raw bytes with the app\'s signing secret and the timestamp within 300 seconds, else the same 401. The `payload` field is Slack\'s JSON. Each press is judged for the Slack user who pressed it, through their linked account, as the same `session.approve` decision the web makes; a refusal, or a request already answered, is told to that person alone and nothing is answered twice. A request settled here updates its message in place with who settled it and how. A `block_actions` press answers `{"ok": true}`; a submitted question modal answers `{"response_action": "clear"}`, or `errors` naming the blocks to fix. Rate limited per agent and overall before any database read (429).',
    auth: "public",
    body: "SlackInteractionForm",
    form: true,
    requestExample: {
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: EXAMPLE_SLACK_APP.app_id,
        team: { id: "T0A1B2C3D" },
        user: { id: "U0PERSON1" },
        channel: { id: "C0CHANNEL1" },
        message: { ts: "1761300000.000200", thread_ts: "1761300000.000100" },
        trigger_id: "1761300000.1234.abcdef",
        actions: [
          {
            action_id: "permission.allow",
            value: JSON.stringify({
              s: "019a0000-0000-7000-8000-0000000000d1",
              r: "toolu_01",
            }),
          },
        ],
      }),
    },
    success: {
      status: 200,
      schema: "SlackInteractionResponse",
      description:
        '`{"ok": true}` for a button press, `{"response_action": "clear"}` or `{"response_action": "errors", ...}` for a submitted modal.',
      example: { ok: true },
    },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/api-keys",
    operationId: "createApiKey",
    tag: "API keys",
    summary: "Issue a personal key or an agent key",
    description:
      "A personal key is the caller's own; an agent key names its agent in `agent_id` and takes an owner, an admin, or that agent's admin. No key reaches a whole workspace: an agent key without `agent_id` is a 400. `name` (1-64 characters once trimmed) is optional. `scopes` may not exceed what the caller holds now (403 SCOPE_NOT_GRANTABLE); within that, either kind may hold any scope, `sessions:approve` included. A personal or agent key holding `sessions:approve` still never approves a session it started itself. An API key never issues one. The secret is returned once; only its sha256 is stored. Writes a `create_api_key` receipt.",
    auth: "session",
    body: "CreateApiKeyRequest",
    success: { status: 201, schema: "CreateApiKeyResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "SCOPE_NOT_GRANTABLE"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/api-keys",
    operationId: "listApiKeys",
    tag: "API keys",
    summary: "The caller's personal keys and the agent keys they manage",
    description:
      "Owners and admins see every agent key; an agent's admin sees that agent's keys. Who sees which agent keys is read from the caller's role on every page, so a page read after a role change follows the new role. Newest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. Secrets are never returned.",
    auth: "session",
    query: "ListApiKeysQuery",
    success: { status: 200, schema: "ListApiKeysResponse" },
    errors: [400, 401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/api-keys/{id}",
    operationId: "revokeApiKey",
    tag: "API keys",
    summary: "Revoke a key",
    description:
      "Takes the right issuing that kind of key takes. Revoking a key already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_api_key` receipt.",
    auth: "session",
    success: { status: 200, schema: "RevokeApiKeyResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams",
    operationId: "createTeam",
    tag: "Teams",
    summary: "Create a team",
    description:
      "Owners and admins (`team.manage`). A live team's name is unique in its workspace (409 ALREADY_EXISTS). Writes a `create_team` receipt.",
    auth: "session",
    body: "CreateTeamRequest",
    requestExample: { name: EXAMPLE_TEAM.name },
    success: {
      status: 201,
      schema: "TeamChangeResponse",
      description:
        "The team, created with no members; `receipt_id` names its `create_team` receipt.",
      example: {
        team: { ...EXAMPLE_TEAM, member_count: 0, revision: 1 },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/teams",
    operationId: "listTeams",
    tag: "Teams",
    summary: "The workspace's teams, by name",
    description: `Owners and admins. Archived teams are left out. \`q\` keeps the teams whose name contains it, ignoring case. ${TEAM_PAGES}`,
    auth: "session",
    query: "ListTeamsQuery",
    success: {
      status: 200,
      schema: "ListTeamsResponse",
      description: "A page of the workspace's live teams.",
      example: { items: [EXAMPLE_TEAM], next_cursor: null },
    },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/my-teams",
    operationId: "listMyTeams",
    tag: "Teams",
    summary: "The teams the caller belongs to",
    description: `Any signed-in person, as of this request: each team's id and name and the caller's \`role\` in it (\`lead\` or \`member\`), never who else is in it. ${TEAM_PAGES}`,
    auth: "session",
    query: "ListMyTeamsQuery",
    success: {
      status: 200,
      schema: "ListMyTeamsResponse",
      description: "The caller's live teams, by name.",
      example: {
        items: [
          {
            id: EXAMPLE_TEAM_ID,
            name: EXAMPLE_TEAM.name,
            role: "lead",
          },
        ],
        next_cursor: null,
      },
    },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/teams/{team_id}",
    operationId: "getTeam",
    tag: "Teams",
    summary: "A team and its members",
    description:
      "An owner or an admin reads any team. Anyone else reads only a team they are in now, read only: changing it stays with owners and admins. Any other team is 403.",
    auth: "session",
    success: {
      status: 200,
      schema: "TeamDetail",
      description: "The team and the people in it now.",
      example: {
        ...EXAMPLE_TEAM,
        members: [
          {
            user_id: EXAMPLE_USER_ID,
            email: "ada@example.com",
            display_name: "Ada Owner",
            role: "lead",
            added_by: EXAMPLE_USER_ID,
            added_at: "2026-10-23T09:00:00Z",
            disabled_at: null,
          },
          {
            user_id: EXAMPLE_TEAM_MEMBER_ID,
            email: "grace@example.com",
            display_name: null,
            role: "member",
            added_by: EXAMPLE_USER_ID,
            added_at: "2026-10-24T09:00:00Z",
            disabled_at: "2026-10-25T09:00:00Z",
          },
        ],
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/teams/{team_id}",
    operationId: "updateTeam",
    tag: "Teams",
    summary: "Rename a team",
    description:
      "Writes a `rename_team` receipt unless the name is unchanged (`receipt_id` null).",
    auth: "session",
    body: "UpdateTeamRequest",
    requestExample: { name: "research leads" },
    success: {
      status: 200,
      schema: "TeamChangeResponse",
      description: "The team after the rename.",
      example: {
        team: { ...EXAMPLE_TEAM, name: "research leads", revision: 4 },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}",
    operationId: "deleteTeam",
    tag: "Teams",
    summary: "Delete a team",
    description:
      "Every agent the team administered loses it from the next request on; its members keep whatever they hold on their own. A team that is the managing team of a live agent is not deleted: 409 TEAM_MANAGES_AGENTS names those agents in `details.agent_ids`; give them another managing team first. Writes a `delete_team` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteTeamResponse",
      description:
        "The team is archived: from now on it answers 404 and lists leave it out. `receipt_id` names its `delete_team` receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["TEAM_MANAGES_AGENTS"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams/{team_id}/members",
    operationId: "addTeamMember",
    tag: "Teams",
    summary: "Add a member of the workspace to a team",
    description:
      "No invite and no acceptance: the person is a member of the team at once. A disabled member is not found. Writes an `add_team_member` receipt naming the person, unless they already were in (`receipt_id` null).",
    auth: "session",
    body: "AddTeamMemberRequest",
    requestExample: { user_id: EXAMPLE_TEAM_MEMBER_ID },
    success: {
      status: 200,
      schema: "TeamChangeResponse",
      description: "The team with the person in it.",
      example: { team: EXAMPLE_TEAM, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}/members/{user_id}",
    operationId: "removeTeamMember",
    tag: "Teams",
    summary: "Take a member out of a team",
    description:
      "What the person held through the team ends from their next request. A disabled member is not changed: 409 MEMBER_DISABLED, nothing written; reactivate them first. Writes a `remove_team_member` receipt naming the person, unless they were not in (`receipt_id` null).",
    auth: "session",
    success: {
      status: 200,
      schema: "TeamChangeResponse",
      description: "The team without the person.",
      example: {
        team: {
          ...EXAMPLE_TEAM,
          name: "research leads",
          member_count: 1,
          revision: 5,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["MEMBER_DISABLED"] },
    idempotent: false,
  },
  {
    method: "patch",
    path: "/v1/teams/{team_id}/members/{user_id}",
    operationId: "setTeamMemberRole",
    tag: "Teams",
    summary: "Make a team member a lead or a member",
    description:
      "Owners and admins. A `lead` administers every agent whose managing team this is, from their next request; a `member` works with those agents and does not administer them. People join a team as `member`. A person not in the team is 404; a disabled member is 409 MEMBER_DISABLED with nothing written. Writes a `set_team_member_role` receipt naming the person, unless the role is unchanged (`receipt_id` null).",
    auth: "session",
    body: "SetTeamMemberRoleRequest",
    requestExample: { role: "lead" },
    success: {
      status: 200,
      schema: "TeamChangeResponse",
      description: "The team after the change.",
      example: { team: EXAMPLE_TEAM, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["MEMBER_DISABLED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/admins",
    operationId: "listAgentAdmins",
    tag: "Agents",
    summary: "The people and teams who administer an agent",
    description:
      "Owners, admins, the agent's own admins and the live members of its managing team (`agent.settings_read`).",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentAdmins",
      description: "The people and the teams named the agent's admins.",
      example: EXAMPLE_AGENT_ADMINS,
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/admins",
    operationId: "addAgentAdmin",
    tag: "Agents",
    summary: "Name a person or a team an agent's admin",
    description:
      "Owners, admins and the agent's own admins name a person. A team's members administer the agent while they are in it, so naming a team needs `team.manage` (owners and admins): anyone else gets 403 FORBIDDEN (`details.reason_code` `role`). A role lost during the request is read again when the team is saved: 403 `team_not_allowed` while the caller still administers the agent, `role` once they no longer do. Taking a team off stays with the agent's admins; admin teams added before stay. Writes an `add_agent_admin` receipt unless they already were one (`receipt_id` null).",
    auth: "session",
    body: "AddAgentAdminRequest",
    requestExample: { team_id: EXAMPLE_TEAM_ID },
    success: {
      status: 200,
      schema: "AgentAdminChangeResponse",
      description: "The agent's admins after the change.",
      example: { admins: EXAMPLE_AGENT_ADMINS, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/admins/{kind}/{subject_id}",
    operationId: "removeAgentAdmin",
    tag: "Agents",
    summary: "Stop a person or a team administering an agent",
    description:
      "`kind` is `users` or `teams`. Writes a `remove_agent_admin` receipt unless they were not one (`receipt_id` null).",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentAdminChangeResponse",
      description: "The agent's admins after the change.",
      example: {
        admins: { ...EXAMPLE_AGENT_ADMINS, teams: [] },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/agents/{id}/managing-team",
    operationId: "setAgentManagingTeam",
    tag: "Agents",
    summary: "Set an agent's managing team",
    description:
      "The managing team's leads administer the agent; its other members do not. Owners, admins and the agent's own admins. An owner or admin names any live team; anyone else only a team they are in (403 FORBIDDEN, `details.reason_code` `team_not_allowed`). A team that is not in the workspace or is deleted is 404 for an owner or admin. `team_id` cannot be null: every agent has a managing team, and this changes which one. The former team's leads lose the agent from their next request. Writes a `set_agent_managing_team` receipt unless the team is unchanged (`receipt_id` null).",
    auth: "session",
    body: "SetAgentManagingTeamRequest",
    requestExample: { team_id: EXAMPLE_TEAM_ID },
    success: {
      status: 200,
      schema: "SetAgentManagingTeamResponse",
      description: "The agent with its managing team.",
      example: { agent: EXAMPLE_AGENT, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/usage",
    operationId: "getAgentUsage",
    tag: "Agents",
    summary: "Who may use an agent",
    description:
      "`scope` is `workspace` (every member of the workspace) or `private` (the members of `teams`). Owners, admins and the agent's own admins read it, as they edit it; never an API key. `revision` is the `If-Match` of the next edit; it moves with every change, and with the archive of a team the agent lists. Reading it changes no session: this is the setting, not a decision.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentUsage",
      description: "The agent's usage setting.",
      example: {
        scope: "private",
        teams: [{ id: EXAMPLE_TEAM_ID, name: "Platform" }],
        revision: 2,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/usage",
    operationId: "putAgentUsage",
    tag: "Agents",
    summary: "Replace who may use an agent",
    description:
      "Owners, admins and the agent's own admins; never an API key. The whole setting is replaced and `If-Match: <revision>` is required, so two edits cannot overwrite each other: the later one answers 412. `private` names at least one team and `workspace` none (400). An owner or admin names any live team; anyone else adds only a team they are in (403 FORBIDDEN, `details.reason_code` `team_not_allowed`), and removing a team needs only this right. A team that is not in the workspace or is deleted is 404. Archiving a team removes it from every list and moves those agents' `revision`; an agent left `private` with no team admits no one but the people who manage it. Writes a `set_agent_usage` receipt with the setting before and after unless nothing changed (`receipt_id` null, `revision` kept).",
    auth: "session",
    body: "PutAgentUsageRequest",
    requestExample: {
      scope: "private",
      teams: [{ id: EXAMPLE_TEAM_ID }],
    },
    success: {
      status: 200,
      schema: "PutAgentUsageResponse",
      description: "The setting now held, and its new `revision`.",
      example: {
        usage: {
          scope: "private",
          teams: [{ id: EXAMPLE_TEAM_ID, name: "Platform" }],
          revision: 3,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 412, 413, 428, 503],
    errorCodes: {
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "revision",
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/caller-limits",
    operationId: "getAgentCallerLimits",
    tag: "Agents",
    summary: "What callers may do through an agent",
    description:
      "One rule per caller target: the whole `workspace`, a `team` or a Slack `channel`. A rule's `tools_deny` and `credentials_deny` name what the caller may not use; `repositories` and `mcp_servers` name all the caller may use, `null` meaning no limit and `[]` none. Owners, admins and the agent's own admins read it, as they edit it; never an API key. `revision` is the `If-Match` of the next edit; it moves with every change, and with the archive of a team the agent has a rule for. Reading it changes no session: these are stored rules, not a decision.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentCallerLimits",
      description: "The agent's caller limit rules.",
      example: {
        rules: [
          {
            target: { kind: "team", id: EXAMPLE_TEAM_ID },
            tools_deny: ["shell"],
            repositories: ["platform"],
            mcp_servers: null,
            credentials_deny: [],
          },
        ],
        revision: 2,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/caller-limits",
    operationId: "putAgentCallerLimits",
    tag: "Agents",
    summary: "Replace what callers may do through an agent",
    description:
      "Owners, admins and the agent's own admins; never an API key. The whole set is replaced and `If-Match: <revision>` is required, so two edits cannot overwrite each other: the later one answers 412. A target is a `workspace`, a `team` or a Slack `channel`, once each; a person is not a target here (400). Tool, MCP server and credential names are not checked. A repository id this edit adds to a target must be in the catalog (400, `details.reason_code` `repository_not_in_catalog`, `details.repository_ids`); an id the target already holds stays, whatever the catalog says now, and counts as no allowance. An owner or admin names any live team; anyone else adds a rule only for a team they are in (403 FORBIDDEN, `details.reason_code` `team_not_allowed`), and removing a rule needs only this right. A team that is not in the workspace or is deleted is 404. Archiving a team deletes its rules and moves the `revision` of the agents that had one. This changes no session by itself. Writes a `set_agent_caller_limits` receipt with the rules before and after unless nothing changed (`receipt_id` null, `revision` kept).",
    auth: "session",
    body: "PutAgentCallerLimitsRequest",
    requestExample: {
      rules: [
        {
          target: { kind: "team", id: EXAMPLE_TEAM_ID },
          tools_deny: ["shell"],
          repositories: ["platform"],
          mcp_servers: null,
          credentials_deny: [],
        },
      ],
    },
    success: {
      status: 200,
      schema: "PutAgentCallerLimitsResponse",
      description: "The rules now held, and their new `revision`.",
      example: {
        limits: {
          rules: [
            {
              target: { kind: "team", id: EXAMPLE_TEAM_ID },
              tools_deny: ["shell"],
              repositories: ["platform"],
              mcp_servers: null,
              credentials_deny: [],
            },
          ],
          revision: 3,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 412, 413, 428, 503],
    errorCodes: {
      412: ["VERSION_MISMATCH"],
      428: ["PRECONDITION_REQUIRED"],
    },
    ifMatch: "revision",
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/administered-agents",
    operationId: "listAdministeredAgents",
    tag: "Agents",
    summary: "The agents the caller administers",
    description:
      "Directly or through a team, as of this request: what an agent's admin needs to issue that agent's own key.",
    auth: "session",
    success: { status: 200, schema: "ListAdministeredAgentsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/usable-agents",
    operationId: "listUsableAgents",
    tag: "Agents",
    summary: "The agents the caller could start a session with now",
    description:
      "Every agent `POST /v1/sessions` would accept a start on for this caller at this request, oldest first, at most 200: the agent is `active` with an `active_release_id`, the caller may use it (open to the workspace; or a private agent whose teams the caller is in, or that the caller administers or manages, or a workspace owner or admin), the release's runtime profile is still in the catalog and unchanged, and every credential the release names is bound. Where the workspace limits agents to those inside them (axis A is not `use`), only agents the caller is inside are listed. A key bound to an agent lists that agent alone when it could start there, and a service key bound to none lists the agents open to the workspace. A private agent the caller may not use is not in the list, and nothing in the answer tells that it exists. An agent whose active release needs a credential that the caller's caller limits (`GET /v1/agents/{id}/caller-limits`: the workspace's rule, or that of a team the caller is in) deny in `credentials_deny` is not listed either, since every start would be refused; a limit on repositories never removes an agent, for a session without a repository still starts. Needs `sessions:write`. `active_release_id` is what to send as `agent_release_id`.",
    scope: "write",
    success: {
      status: 200,
      schema: "ListUsableAgentsResponse",
      description: "The agents a start would accept, oldest first.",
      example: {
        items: [
          {
            id: EXAMPLE_AGENT_ID,
            slug: "finance",
            name: "Finance analyst",
            description: "Reads the quarterly reports and flags outliers.",
            managing_team_name: "Finance",
            active_release_id: "rel_example",
          },
        ],
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/profiles",
    operationId: "listProfiles",
    tag: "Agents",
    summary: "The runtime profiles this workspace can run",
    description:
      "Lists the profiles a session's `profile_id` or a release's `runtime_profile_id` may name, by `id`: the profiles (`source: operator`, each with an `installation` object): the installation-wide ones and the caller's workspace's own, each with the models it offers, its tools and permission mode. The older workspace versions (ids starting `ws_`) are not listed; what runs on them keeps its release. A profile saved from now on carries no `repository_mode`; an older one still does. Every profile is listed with its state (`installation.state`); only `usable` takes a new release or session. A profile's provider endpoint and credential are not included.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListProfilesResponse",
      description:
        "The operator's profiles ordered by `id`, then the workspace's.",
      example: {
        items: [
          {
            id: "claude-coding-real",
            source: "operator",
            model: "claude-sonnet-5",
            models: ["claude-sonnet-5", "claude-haiku-5"],
            tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
            permission_mode: "acceptEdits",
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.319",
            billing: "metered",
            repository_mode: "required",
          },
          INSTALLATION_PROFILE_EXAMPLE,
          WORKSPACE_PROFILE_EXAMPLE,
        ],
      },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/workspace-profiles",
    operationId: "createWorkspaceProfile",
    tag: "Agents",
    summary: "Save a new version of a workspace profile",
    description:
      "Owners and admins (`workspace.manage`), signed in. Narrows the operator profile `base_profile_id`: `models` and `tools` are subsets of the base's, and `permission_mode` the base's or one that leaves more to a person. Anything wider is 400 with `details.field`. Each save makes the next version of `name` with a new id (`ws_<workspace slug>_<name>_v<n>`); earlier versions, and what already runs on them, stay as they were. Two saves of one name at once: the second is 409 REVISION_CONFLICT, and saving again makes the version after. Instead of `tools`, `deny` names the catalog tools to block on top of the base's: the base's tools less `deny` are saved, and a deny that leaves out a tool the base blocks is 400 `base_denies`; the other `deny` and `accept_added_tools` refusals are those of `POST /v1/installation-profiles`, weighed against the latest version of `name`. A version keeps every `mcp__` block of the one before; `unblock_mcp_tools` lifts a held one (refusals as for `POST /v1/installation-profiles`) and needs `previous_id`, the version the form read: another latest version is 409 REVISION_CONFLICT (`details.reason_code: stale_previous`, `details.latest_id`). Writes a `create_workspace_profile` receipt.",
    auth: "session",
    body: "CreateWorkspaceProfileRequest",
    requestExample: {
      name: "strict-review",
      base_profile_id: "claude-coding-real",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read", "Glob", "Grep"],
      permission_mode: "default",
    },
    success: {
      status: 201,
      schema: "WorkspaceProfileChangeResponse",
      description: "The version saved, and its receipt.",
      example: {
        profile: WORKSPACE_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e1",
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspace-profiles/{profile_id}/retire",
    operationId: "retireWorkspaceProfile",
    tag: "Agents",
    summary: "Retire a version of a workspace profile",
    description:
      "Owners and admins (`workspace.manage`), signed in. A retired version takes no new release and no new session of a new release; releases and sessions already on it keep running. Retiring one already retired changes nothing and answers a null `receipt_id`; otherwise writes a `retire_workspace_profile` receipt. Another workspace's version is 404.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The version as retired.",
      example: {
        profile: {
          ...WORKSPACE_PROFILE_EXAMPLE,
          workspace: {
            ...WORKSPACE_PROFILE_EXAMPLE.workspace,
            state: "retired",
            retired_at: "2026-10-28T01:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e2",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/achievement-categories",
    operationId: "listAchievementCategories",
    tag: "Workspace settings",
    summary: "List the workspace's achievement categories",
    description:
      "Every category of the caller's workspace, archived ones included (`archived_at`), by `position`. A category groups achievement rules; its name is not copied anywhere, so renaming it renames it for past achievements too. Every member reads it, and so does a member's personal key (`workspace.read`); an agent's key is 403.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListAchievementCategoriesResponse",
      description: "The categories, by `position` then creation.",
      example: { items: [ACHIEVEMENT_CATEGORY_EXAMPLE] },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/achievement-categories",
    operationId: "createAchievementCategory",
    tag: "Workspace settings",
    summary: "Make an achievement category",
    description: `${ACHIEVEMENT_MANAGERS} The name (1 to 32 characters) is unique among the workspace's categories that are not archived (409 ALREADY_EXISTS, \`details.reason_code: name_taken\`). The new category goes after the last one. Writes a \`create_achievement_category\` receipt.`,
    auth: "session",
    body: "CreateAchievementCategoryRequest",
    requestExample: { name: "Delivery" },
    success: {
      status: 201,
      schema: "AchievementCategoryChangeResponse",
      description: "The category made, and its receipt.",
      example: {
        category: ACHIEVEMENT_CATEGORY_EXAMPLE,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "patch",
    path: "/v1/achievement-categories/{id}",
    operationId: "updateAchievementCategory",
    tag: "Workspace settings",
    summary: "Rename or reorder an achievement category",
    description: `${ACHIEVEMENT_MANAGERS} Changes \`name\`, \`position\` or both. A name another category that is not archived holds is 409 ALREADY_EXISTS (\`details.reason_code: name_taken\`). Writes an \`update_achievement_category\` receipt unless nothing changed (\`receipt_id\` null). Another workspace's category is 404.`,
    auth: "session",
    body: "UpdateAchievementCategoryRequest",
    requestExample: { name: "Delivery", position: 1 },
    success: {
      status: 200,
      schema: "AchievementCategoryChangeResponse",
      description: "The category as changed.",
      example: {
        category: { ...ACHIEVEMENT_CATEGORY_EXAMPLE, position: 1 },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievement-categories/{id}/archive",
    operationId: "archiveAchievementCategory",
    tag: "Workspace settings",
    summary: "Archive an achievement category",
    description: `${ACHIEVEMENT_MANAGERS} A category with a rule in use (its latest version, not disabled) is 409 REVISION_CONFLICT with \`details.reason_code: category_in_use\`. Archiving one already archived changes nothing and answers a null \`receipt_id\`; otherwise writes an \`archive_achievement_category\` receipt. Another workspace's category is 404.`,
    auth: "session",
    success: {
      status: 200,
      schema: "AchievementCategoryChangeResponse",
      description: "The category as archived.",
      example: {
        category: {
          ...ACHIEVEMENT_CATEGORY_EXAMPLE,
          archived_at: "2026-11-02T02:00:00.000Z",
          archived_by: EXAMPLE_USER_ID,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/achievement-types",
    operationId: "listAchievementTypes",
    tag: "Workspace settings",
    summary: "List the workspace's achievement types",
    description:
      "Every type of the caller's workspace, archived ones included: the built-in `pull_request`, `code_review` and `document` (`builtin: true`, `created_by` null) first, then the ones people made. A type is what a rule counts, and names the kind of evidence it is counted from. Every member reads it, and so does a member's personal key (`workspace.read`); an agent's key is 403.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListAchievementTypesResponse",
      description: "The types, built-in first, then by creation.",
      example: { items: [ACHIEVEMENT_TYPE_EXAMPLE] },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/achievement-types",
    operationId: "createAchievementType",
    tag: "Workspace settings",
    summary: "Make an achievement type",
    description: `${ACHIEVEMENT_MANAGERS} \`key\` matches \`[a-z][a-z0-9_]{1,40}\` and is unique in the workspace, archived types included (409 ALREADY_EXISTS, \`details.reason_code: key_taken\`); \`key\` and \`evidence_kind\` never change afterwards. A workspace holds at most 50 types that are not archived (409 REVISION_CONFLICT, \`details.reason_code: limit_reached\`). Writes a \`create_achievement_type\` receipt.`,
    auth: "session",
    body: "CreateAchievementTypeRequest",
    requestExample: {
      key: "design_doc",
      name: "Design doc",
      evidence_kind: "out_file",
    },
    success: {
      status: 201,
      schema: "AchievementTypeChangeResponse",
      description: "The type made, and its receipt.",
      example: {
        type: ACHIEVEMENT_TYPE_EXAMPLE,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS", "REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "patch",
    path: "/v1/achievement-types/{id}",
    operationId: "updateAchievementType",
    tag: "Workspace settings",
    summary: "Rename an achievement type",
    description: `${ACHIEVEMENT_MANAGERS} Only \`name\` changes; a body naming \`key\` or \`evidence_kind\` is 400. To count under another key or evidence kind, make a new type and move the rule to it in a new version. Writes an \`update_achievement_type\` receipt unless the name is unchanged (\`receipt_id\` null). Another workspace's type is 404.`,
    auth: "session",
    body: "UpdateAchievementTypeRequest",
    requestExample: { name: "Design document" },
    success: {
      status: 200,
      schema: "AchievementTypeChangeResponse",
      description: "The type as renamed.",
      example: {
        type: { ...ACHIEVEMENT_TYPE_EXAMPLE, name: "Design document" },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievement-types/{id}/archive",
    operationId: "archiveAchievementType",
    tag: "Workspace settings",
    summary: "Archive an achievement type",
    description: `${ACHIEVEMENT_MANAGERS} A built-in type is never archived (409 REVISION_CONFLICT, \`details.reason_code: builtin\`), nor is one a rule in use counts (\`details.reason_code: type_in_use\`). Archiving one already archived changes nothing and answers a null \`receipt_id\`; otherwise writes an \`archive_achievement_type\` receipt. Another workspace's type is 404.`,
    auth: "session",
    success: {
      status: 200,
      schema: "AchievementTypeChangeResponse",
      description: "The type as archived.",
      example: {
        type: {
          ...ACHIEVEMENT_TYPE_EXAMPLE,
          archived_at: "2026-11-02T02:00:00.000Z",
          archived_by: EXAMPLE_USER_ID,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/achievement-rules",
    operationId: "listAchievementRules",
    tag: "Workspace settings",
    summary: "List the workspace's achievement rules",
    description:
      "The latest version of every rule of the caller's workspace, disabled ones included (`disabled_at`), grouped by category in the categories' order and by title within one. A rule is one title, one type and one definition; `judge: always` counts the type's evidence as it appears, `luna` asks the judge whether the definition holds. `agent_ids` is null: every agent. Every member reads it, and so does a member's personal key (`workspace.read`); an agent's key is 403.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListAchievementRulesResponse",
      description: "The latest versions.",
      example: { items: [ACHIEVEMENT_RULE_EXAMPLE] },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/achievement-rules",
    operationId: "createAchievementRule",
    tag: "Workspace settings",
    summary: "Make an achievement rule",
    description: `${ACHIEVEMENT_MANAGERS} Version 1 of a new rule. \`category_id\` and \`type_id\` name a category and a type of the workspace that are not archived (400, \`details.reason_code: unknown_category\` or \`unknown_type\`); \`agent_ids\` takes only null. A type is counted by one rule in use at a time: a type another rule in use counts is 409 REVISION_CONFLICT with \`details.reason_code: type_in_use\`. A workspace has at most 30 rules in use (\`details.reason_code: limit_reached\`). Writes a \`create_achievement_rule\` receipt naming the rule's id, family and version, never its definition.`,
    auth: "session",
    body: "AchievementRuleRequest",
    requestExample: ACHIEVEMENT_RULE_REQUEST_EXAMPLE,
    success: {
      status: 201,
      schema: "AchievementRuleChangeResponse",
      description: "Version 1, and its receipt.",
      example: {
        rule: ACHIEVEMENT_RULE_EXAMPLE,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievement-rules/{family_id}/versions",
    operationId: "createAchievementRuleVersion",
    tag: "Workspace settings",
    summary: "Edit an achievement rule as its next version",
    description: `${ACHIEVEMENT_MANAGERS} The body is the whole rule, as for a new one. A rule's rows never change: this makes version + 1 under a new id and sets the previous version's \`superseded_by\` to it; achievements already counted keep pointing at the version they were judged by. A disabled rule's new version is disabled too. 400 and 409 \`type_in_use\` as for a new rule; two edits at once are saved one after the other, each as its own version. Writes an \`update_achievement_rule\` receipt with the new and previous version ids, never the definition. Another workspace's rule is 404.`,
    auth: "session",
    body: "AchievementRuleRequest",
    requestExample: {
      ...ACHIEVEMENT_RULE_REQUEST_EXAMPLE,
      title: "Design doc merged",
    },
    success: {
      status: 201,
      schema: "AchievementRuleChangeResponse",
      description: "The new version, and its receipt.",
      example: {
        rule: {
          ...ACHIEVEMENT_RULE_EXAMPLE,
          id: "9f5c6a7b-8d9e-4f0a-8b1c-3d4e5f6a7b82",
          version: 2,
          title: "Design doc merged",
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievement-rules/{family_id}/disable",
    operationId: "disableAchievementRule",
    tag: "Workspace settings",
    summary: "Stop using an achievement rule",
    description: `${ACHIEVEMENT_MANAGERS} Disables the rule's latest version: it counts nothing from now on, and its type is free for another rule. Disabling one already disabled changes nothing and answers a null \`receipt_id\`; otherwise writes a \`disable_achievement_rule\` receipt. Another workspace's rule is 404.`,
    auth: "session",
    success: {
      status: 200,
      schema: "AchievementRuleChangeResponse",
      description: "The latest version, disabled.",
      example: {
        rule: {
          ...ACHIEVEMENT_RULE_EXAMPLE,
          disabled_at: "2026-11-02T02:00:00.000Z",
          disabled_by: EXAMPLE_USER_ID,
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/achievement-rules/{family_id}/enable",
    operationId: "enableAchievementRule",
    tag: "Workspace settings",
    summary: "Use a disabled achievement rule again",
    description: `${ACHIEVEMENT_MANAGERS} Enables the rule's latest version. If another rule in use counts its type now, 409 REVISION_CONFLICT with \`details.reason_code: type_in_use\`; at 30 rules in use, \`limit_reached\`; a category or type archived since is 400 (\`unknown_category\`, \`unknown_type\`). Enabling one already in use changes nothing and answers a null \`receipt_id\`; otherwise writes an \`enable_achievement_rule\` receipt. Another workspace's rule is 404.`,
    auth: "session",
    success: {
      status: 200,
      schema: "AchievementRuleChangeResponse",
      description: "The latest version, in use.",
      example: {
        rule: ACHIEVEMENT_RULE_EXAMPLE,
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/achievement-judge",
    operationId: "getAchievementJudge",
    tag: "Workspace settings",
    summary: "Read how the workspace's achievement judge runs",
    description:
      "`workspace.settings.achievement_judge` of the caller's workspace, every field filled with its default when never set. `connection_id` null leaves `luna` rules unjudged; `always` rules count regardless. Another workspace is 404. Every member reads it, and so does a member's personal key (`workspace.read`); an agent's key is 403.",
    scope: "read",
    success: {
      status: 200,
      schema: "AchievementJudgeResponse",
      description: "The settings.",
      example: { achievement_judge: ACHIEVEMENT_JUDGE_EXAMPLE },
    },
    errors: [401, 404, 503],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/achievement-judge",
    operationId: "putAchievementJudge",
    tag: "Workspace settings",
    summary: "Change how the workspace's achievement judge runs",
    description: `${ACHIEVEMENT_MANAGERS} Replaces the settings; a field left out takes its default. \`threshold\` is between 0 and 1, \`every_n_turns\` null or 5 to 100, \`transcript\` \`none\` or \`recent\`. Writes a \`set_achievement_judge\` receipt with the settings saved. Another workspace is 404.`,
    auth: "session",
    body: "AchievementJudgeRequest",
    requestExample: { ...ACHIEVEMENT_JUDGE_EXAMPLE, every_n_turns: 10 },
    success: {
      status: 200,
      schema: "AchievementJudgeChangeResponse",
      description: "The settings saved, and the receipt.",
      example: {
        achievement_judge: { ...ACHIEVEMENT_JUDGE_EXAMPLE, every_n_turns: 10 },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation-profiles/options",
    operationId: "getInstallationProfileOptions",
    tag: "Agents",
    summary: "What a new installation ceiling may name",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. The installation's connections by id, `kind` and `billing` (never an endpoint or a credential reference), the installed runtimes with the permission modes each accepts, the catalog repositories, the built-in tool catalogs a `deny` names (one entry per runtime version spelling, SDK and engine build), and whether `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS` lets a ceiling run `bypassPermissions` here.",
    auth: "session",
    success: {
      status: 200,
      schema: "InstallationProfileOptionsResponse",
      description: "What a new ceiling may name on this installation.",
      example: {
        connections: [
          { id: "anthropic-main", kind: "anthropic", billing: "metered" },
        ],
        runtimes: [
          {
            runtime_kind: "claude_agent_sdk",
            permission_modes: [
              "default",
              "acceptEdits",
              "dontAsk",
              "plan",
              "bypassPermissions",
              "auto",
            ],
          },
        ],
        repositories: [{ id: "sample-app" }],
        tool_catalogs: [
          {
            id: "claude_agent_sdk@0.3.319+claude-code@2.1.319",
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.319",
            tools: [
              { name: "Read", boundary: "local" },
              { name: "Bash", boundary: "local" },
              { name: "WebFetch", boundary: "egress" },
              { name: "WebSearch", boundary: "provider" },
            ],
          },
        ],
        unattended_allowed: false,
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/installation-profiles",
    operationId: "createInstallationProfile",
    tag: "Agents",
    summary: "Save a new version of a profile",
    description:
      "The one way to define a profile (`profile.define`: the workspace owner or an admin), signed in; an API key is 403 whatever its scopes. The owner sends `connection_id`, `runtime_kind` and `runtime_version` (400 `missing_field` without them) and saves an installation-wide profile `op_<name>_v<n>`, whose provider the server copies in from the connection. An admin saves a profile of their own workspace that narrows a version they may see: `derived_from` names it for a first version, a later one names `previous_id` and keeps its source. The server copies the runtime, connection, billing and title model from the source, so an admin sending `connection_id`, `runtime_kind`, `runtime_version`, `title_model` or `project_settings` is 400 `source_field`, and a model, tool or mode wider than the source's is 400 `widens_base`; a source that is unknown, another workspace's or not usable is 400 `unknown_base`, `retired` or another state. A workspace profile's `name` is its display name; the server keeps it under a key it makes (`wl_<uuid>`) and `installation.name` answers the display name. A new profile whose name the workspace already sees is 409 `name_taken`. A new version of an existing profile sends its latest id as `previous_id`; anything else is 409 REVISION_CONFLICT (`details.reason_code: stale_previous`, `details.latest_id`), as is the second of two saves at once. A version that runs the same as the latest (the same models, tools, mode, provider and settings, whatever the `deny` spelling) writes nothing and answers with that latest version and a null `receipt_id` (the status stays 201: tell it from a new version by `receipt_id`); a retired or blocked latest takes a new version instead. A first owner version may name the profile it replaces in `previous_id` (400 `unknown_previous` when there is none). 400 `details.reason_code`: `unknown_connection`, `runtime_not_installed`, `unattended_not_allowed` (`bypassPermissions` while `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS` is not `true`), `model_not_in_models` or `invalid_profile`, each with `details.field`. 409 `details.reason_code: id_taken` when the id is already an imported profile's. A profile names no repository: the request has no repository fields, and the repositories a session reaches come from the agent's GitHub settings. Its built-in tools are named one way: `tools`, kept as given, or `deny`, the tools of the runtime version's catalog (`tool_catalogs` in `GET /v1/installation-profiles/options`) to block, the rest saved as `tools`; `deny: []` blocks none. `deny` may also name `mcp__<server>__<tool>` tools of the MCP servers the installation lists, matched exactly; they are kept beside the catalog's, listed as `mcp_deny` (the response `deny` stays the catalog's), and a next version keeps those of the one before. A version derived from a profile that blocks such names must name every one of them in `deny` (400 `base_mcp_deny_dropped`). 400 on `deny` (`details.field: deny`): `no_tool_catalog` (no catalog lists `runtime_version`), `unknown_tool`, `tool_pattern` (`Bash(rm:*)`: whole built-in tool names only), `mcp_tool_name` (not `mcp__<server>__<tool>`, at most 128 characters, no spaces or control characters), `github_server` (the built-in server's tools follow the agent's GitHub settings) or `unknown_mcp_server` (new name of a server the installation does not list); `accept_added_tools` takes catalog tools only (`mcp_tool`). A next version lifts a held `mcp__` block only by naming it in `unblock_mcp_tools` (400 `details.field: unblock_mcp_tools`: `mcp_unblock_unknown` when the previous version does not hold it, `mcp_unblock_conflict` when `deny` names it too, `mcp_unblock_no_previous` for a first version, `base_mcp_deny_dropped` when the base blocks it). With `previous_id`, a catalog tool that version never weighed (an allow list weighed only what it allowed) runs only when named in `accept_added_tools`, else 400 `added_tool_not_accepted`. Writes a `create_installation_profile` receipt naming the `deny` and `tool_catalog_id` saved.",
    auth: "session",
    body: "CreateInstallationProfileRequest",
    requestExample: {
      name: "coding",
      connection_id: "anthropic-main",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.319",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-haiku-5"],
      title_model: "claude-haiku-5",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "acceptEdits",
      project_settings: { claude_md: true },
      previous_id: "op_coding_v1",
    },
    success: {
      status: 201,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling saved, and its receipt.",
      example: {
        profile: INSTALLATION_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e3",
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/retire",
    operationId: "retireInstallationProfile",
    tag: "Agents",
    summary: "Retire an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. Any ceiling, imported or saved in the console. A retired ceiling takes no new release, no session without a release and no new workspace profile over it, and a workspace profile over it reads `base_retired`; releases already made on either, and their sessions, keep running. Retiring one already retired changes nothing and answers a null `receipt_id`; otherwise writes a `retire_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as retired.",
      example: {
        profile: {
          ...INSTALLATION_PROFILE_EXAMPLE,
          installation: {
            ...INSTALLATION_PROFILE_EXAMPLE.installation,
            state: "retired",
            retired_by: "019a0000-0000-7000-8000-0000000000b1",
            retired_at: "2026-10-28T02:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e4",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/block",
    operationId: "blockInstallationProfile",
    tag: "Agents",
    summary: "Block an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. Stops everything on one ceiling, imported or saved in the console, within a second on every replica: it reads `blocked` and the workspace profiles over it `base_blocked`; new releases, sessions (with a release or without) and workspace profiles on either are refused; a session waiting for its next turn fails at its next claim (`catalog_mismatch`, its input kept); a running turn loses its provider and repository access at the egress proxy's next regrant. Unblocking lets it run again but revives no failed session. Blocking one already blocked changes nothing and answers a null `receipt_id`; otherwise writes a `block_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as blocked.",
      example: {
        profile: {
          ...INSTALLATION_PROFILE_EXAMPLE,
          installation: {
            ...INSTALLATION_PROFILE_EXAMPLE.installation,
            state: "blocked",
            blocked_by: "019a0000-0000-7000-8000-0000000000b1",
            blocked_at: "2026-10-28T03:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e5",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/unblock",
    operationId: "unblockInstallationProfile",
    tag: "Agents",
    summary: "Unblock an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. The ceiling returns to the state it would have without the block (`usable`, or `retired` when it was retired); sessions failed while it was blocked stay failed. Unblocking one not blocked changes nothing and answers a null `receipt_id`; otherwise writes an `unblock_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as unblocked.",
      example: {
        profile: INSTALLATION_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e6",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/rollout/retry",
    operationId: "retryProfileRollout",
    tag: "Agents",
    summary: "Retry one agent of a profile rollout",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. A new version of a profile moves the agents that follow it onto the version; one the move failed for stays on its release, with the reason in `installation.rollout.failed_agents` of `GET /v1/profiles` and in `profile_rollout` of the agent. A failed agent is never tried again by itself; this call is the one way to do it. The agent is judged afresh: its current release, whether it still follows, and the profile's newest version. `retried: false` when none of its steps for this version was failed (retried already, say).",
    auth: "session",
    body: "RetryProfileRolloutRequest",
    requestExample: { agent_id: "019a0000-0000-7000-8000-0000000000a1" },
    success: {
      status: 200,
      schema: "RetryProfileRolloutResponse",
      description: "Whether a failed step was put back to wait.",
      example: { retried: true },
    },
    errors: [400, 401, 403, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation/settings/export",
    operationId: "exportInstallationSettings",
    tag: "Agents",
    summary: "The installation's settings as one document, without a value",
    description:
      "The operator (`installation.settings.manage`, the workspace owner), signed in; an API key is 403 whatever its scopes. The provider connections, repositories and remote MCP servers the database holds, each entry in the shape the document holds it; disabled and removed rows are left out, so this is the active settings to copy, not a backup. An env or Secrets Manager reference comes back as its name (`value_env`, `secret_id`); a value the database stores as `stored: true` and its `last4`, never the value. Execution ceilings are not in it. `digest` is the SHA-256 of the document's canonical JSON, `last4` included. Changes nothing.",
    auth: "session",
    success: {
      status: 200,
      schema: "ExportSettingsResponse",
      description: "The document and its digest.",
      example: {
        document: SETTINGS_DOCUMENT_EXAMPLE,
        digest: `sha256:${"0".repeat(64)}`,
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/installation/settings/import",
    operationId: "importInstallationSettings",
    tag: "Agents",
    summary: "Add the entries of a settings document the installation lacks",
    description:
      "The operator (`installation.settings.manage`, the workspace owner), signed in; an API key is 403 whatever its scopes. Adds each entry whose id no row holds, in one transaction, and writes an `import_connection`, `import_repository` or `import_mcp_server` receipt for each. An id held with the same content is `unchanged` (`inactive` when that row is disabled or removed: it stays so), and nothing is overwritten: an id held with other content, a GitHub App repository another id already holds, or a new stored entry whose id already has a value is 409 REVISION_CONFLICT (`details.reason_code: settings_conflict`, `details.entries`) and nothing changes. An entry bringing an env or Secrets Manager reference the installation does not hold yet is 400 `external_reference` (`details.entries`), nothing changed: only the operator's `settings import` CLI brings those in. A `stored: true` entry always means its own row's value and runs once the value is set (`needs_value`). A wrong outline (`version`, the top-level keys) is 400 with `details.issues`; an entry the settings rules refuse is 400 `invalid_document`. `dry_run=true` answers the same without writing.",
    auth: "session",
    query: "ImportSettingsQuery",
    body: "SettingsDocument",
    requestExample: SETTINGS_DOCUMENT_EXAMPLE,
    success: {
      status: 200,
      schema: "ImportSettingsResponse",
      description: "What was added, and what was there already.",
      example: {
        outcome: "applied",
        added: ["connection:anthropic-console", "repository:docs-site"],
        unchanged: ["connection:anthropic-main"],
        inactive: [],
        needs_value: ["connection:anthropic-console"],
        receipt_ids: [
          "019a0000-0000-7000-8000-0000000000f1",
          "019a0000-0000-7000-8000-0000000000f2",
        ],
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation/settings/connections",
    operationId: "listSettingsConnections",
    tag: "Agents",
    summary: "The provider connections, from the file and the console",
    description: `${SETTINGS_OWNER} ${SETTINGS_LIST}`,
    auth: "session",
    success: {
      status: 200,
      schema: "ListSettingsConnectionsResponse",
      description: "Every connection, by id.",
      example: {
        items: [SETTINGS_CONNECTION_EXAMPLE],
        credential_hosts: ["api.anthropic.com:443"],
        endpoint_defaults: { anthropic: "https://api.anthropic.com" },
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections",
    operationId: "createSettingsConnection",
    tag: "Agents",
    summary: "Make a provider connection with a key typed in",
    description: `${SETTINGS_OWNER} ${SETTINGS_CREATE} An empty \`endpoint\` is stored as the kind's default from \`endpoint_defaults\`; a kind with none answers \`400\` \`invalid_entry\`. Writes a \`create_connection\` receipt.`,
    auth: "session",
    body: "CreateSettingsConnectionRequest",
    requestExample: {
      id: "anthropic-console",
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth_kind: "api_key",
      value: "example-key",
    },
    success: {
      status: 201,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-console"),
    },
    errors: [400, 401, 403, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation/settings/connections/{id}/impact",
    operationId: "getSettingsConnectionImpact",
    tag: "Agents",
    summary: "What disabling a connection would leave without a model",
    description: `${SETTINGS_OWNER} Counts, read when the confirmation opens: the current profile versions with no other enabled connection that fits once this one is gone (the whole installation, any workspace's derived version included), the active agents whose active release runs one of them, the sessions not yet failed or stopped that run one of them, and whether a workspace's achievement judge setting names the connection. Counts only, no names. Changes nothing; disabling is never blocked by it. \`404\` for an id the console does not hold.`,
    auth: "session",
    success: {
      status: 200,
      schema: "SettingsConnectionImpactResponse",
      description: "The counts for the connection.",
      example: {
        id: "anthropic-console",
        profile_count: 2,
        agent_count: 3,
        session_count: 1,
        judge_used: false,
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections/{id}/credential",
    operationId: "setSettingsConnectionCredential",
    tag: "Agents",
    summary: "Replace a connection's stored key",
    description: `${SETTINGS_OWNER} ${SETTINGS_CREDENTIAL}`,
    auth: "session",
    body: "SetSettingsCredentialRequest",
    requestExample: { value: "example-key" },
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-console"),
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections/{id}/convert",
    operationId: "convertSettingsConnection",
    tag: "Agents",
    summary: "Move a connection's key from the deployment to a stored value",
    description: `${SETTINGS_OWNER} ${SETTINGS_CONVERT}`,
    auth: "session",
    body: "SetSettingsCredentialRequest",
    requestExample: { value: "example-key" },
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-main"),
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections/{id}/auto-mode",
    operationId: "setSettingsConnectionAutoMode",
    tag: "Agents",
    summary:
      "Record whether a connection's models run the auto-mode classifier",
    description: `${SETTINGS_OWNER} Records the operator's judgement for one connection: \`supported\`, \`unsupported\` or \`unknown\` (the default). Only \`supported\` lets an agent whose mode is default, acceptEdits, dontAsk or plan run as \`auto\` on this connection, from the next claim of each session; running sessions keep their current run. Changes that field only: the connection's definition, and so every fingerprint made over it, stays. A disabled connection is 409 \`disabled\`. Writes a \`set_connection_auto_mode\` receipt.`,
    auth: "session",
    body: "SetConnectionAutoModeRequest",
    requestExample: { auto_mode: "supported" },
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-main"),
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections/{id}/disable",
    operationId: "disableSettingsConnection",
    tag: "Agents",
    summary: "Disable a provider connection",
    description: `${SETTINGS_OWNER} ${SETTINGS_DISABLE_CONNECTION} Writes a \`disable_connection\` receipt.`,
    auth: "session",
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-console"),
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/connections/{id}/enable",
    operationId: "enableSettingsConnection",
    tag: "Agents",
    summary: "Enable a disabled provider connection again",
    description: `${SETTINGS_OWNER} ${SETTINGS_ENABLE_CONNECTION}`,
    auth: "session",
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("anthropic-console"),
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation/settings/mcp-servers",
    operationId: "listSettingsMcpServers",
    tag: "Agents",
    summary: "The remote MCP servers, from the file and the console",
    description: `${SETTINGS_OWNER} ${SETTINGS_LIST} A server's tools are named \`mcp__<id>__<tool>\` and are known only once a session reaches it.`,
    auth: "session",
    success: {
      status: 200,
      schema: "ListSettingsMcpServersResponse",
      description: "Every remote MCP server, by id.",
      example: { items: [SETTINGS_MCP_EXAMPLE] },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/installation/settings/mcp-servers",
    operationId: "createSettingsMcpServer",
    tag: "Agents",
    summary: "Make a remote MCP server with a bearer typed in",
    description: `${SETTINGS_OWNER} ${SETTINGS_CREATE} \`github\` is the built-in server's name. Writes a \`create_mcp_server\` receipt.`,
    auth: "session",
    body: "CreateSettingsMcpServerRequest",
    requestExample: {
      id: "docs",
      url: "https://mcp.example.com/mcp",
      credential_ref: "docs_mcp",
      workspaces: ["acme"],
      value: "example-bearer",
    },
    success: {
      status: 201,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("docs"),
    },
    errors: [400, 401, 403, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "patch",
    path: "/v1/installation/settings/mcp-servers/{id}",
    operationId: "setSettingsMcpServer",
    tag: "Agents",
    summary: "Change which workspaces may use an MCP server",
    description: `${SETTINGS_OWNER} The one field changed in place: the workspaces (by slug) are not part of a session's MCP binding. Its URL and credential name never change. A server whose bearer comes from the operator's deployment is 409 \`not_stored\`; a disabled one 409 \`disabled\`. Writes a \`set_mcp_server_workspaces\` receipt.`,
    auth: "session",
    body: "SetSettingsMcpServerRequest",
    requestExample: { workspaces: ["acme", "acme-labs"] },
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("docs"),
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/mcp-servers/{id}/credential",
    operationId: "setSettingsMcpServerCredential",
    tag: "Agents",
    summary: "Replace an MCP server's stored bearer",
    description: `${SETTINGS_OWNER} ${SETTINGS_CREDENTIAL}`,
    auth: "session",
    body: "SetSettingsCredentialRequest",
    requestExample: { value: "example-bearer" },
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("docs"),
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation/settings/mcp-servers/{id}/disable",
    operationId: "disableSettingsMcpServer",
    tag: "Agents",
    summary: "Disable a remote MCP server for good",
    description: `${SETTINGS_OWNER} ${SETTINGS_DISABLE} Writes a \`disable_mcp_server\` receipt.`,
    auth: "session",
    success: {
      status: 200,
      schema: "SettingsChangeResponse",
      description: "The entry's id and the change's receipt.",
      example: SETTINGS_CHANGE_EXAMPLE("docs"),
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/limits",
    operationId: "getInstallationLimits",
    tag: "Limits & receipts",
    summary: "Installation limits and installation-wide usage",
    description:
      "Reads the limits this installation runs under (execution slots, queued input per session, storage, turn length, per-session cost and token limits, provider retries) and the usage against the installation-wide ones, summed over every owner. Use it to explain `STORAGE_LIMIT_EXCEEDED`, a full input queue, or sessions waiting in `queued` for a slot. `usage.outputs` is the bytes of session outputs kept in the object store, shown beside storage and never enforced.\n\nWithout `scope`, or with `scope=installation`, only the workspace owner, signed in, reads it: any other member and every API key get 403.\n\n`scope=me` gives any signed-in member the per-session limits alone (`queued_input_limit_per_session`, `max_turn_seconds`, `session_cost_limit_usd`, `session_token_limit`), with no `usage`; an API key gets 403. It changes nothing.",
    scope: "read",
    query: "LimitsQuery",
    success: {
      status: 200,
      schema: "LimitsResponse",
      description: "The limits and usage as of `refreshed_at`.",
      example: {
        scope: "installation",
        refreshed_at: "2026-10-11T08:15:43Z",
        limits: {
          execution_slot_limit: 4,
          queued_input_limit_per_session: 20,
          storage_limit_bytes: 1073741824,
          max_turn_seconds: 3600,
          session_cost_limit_usd: "20",
          session_token_limit: null,
          provider_max_retries: 2,
        },
        usage: {
          execution_slots_used: 1,
          queued_input_count: 3,
          storage: {
            used_bytes: 524288,
            accounted_content: ["input_messages"],
            updated_at: "2026-10-11T08:14:00Z",
          },
          outputs: {
            used_bytes: 3145728,
            updated_at: "2026-10-11T08:12:30Z",
            complete: true,
          },
          archived_events: {
            used_bytes: 18712,
            updated_at: "2026-10-05T05:00:12Z",
          },
        },
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/summary",
    operationId: "getUsageSummary",
    tag: "Limits & receipts",
    summary: "Cost, tokens and run time of the sessions created in a period",
    description:
      "Adds up the sessions created in `[since, until)`: how many, their estimated provider cost, their tokens, and how long their turns ran. `since` and `until` take a date (`2026-10-01`, that day's 00:00 UTC) or a timestamp with an offset, which is moved to UTC; without `until` the period ends when the figures are read, so `since` must then be in the past.\n\n- `scope=me`: the sessions the caller started. A personal API key counts as the person who created it; a key nobody created counts the sessions it started itself. Sessions shared with the caller are not added. A key bound to an agent gets 403, as it does from `GET /v1/sessions`.\n- `scope=installation`: every session of every owner. Only the workspace owner, signed in, reads it: any other member and every API key get 403.\n- `scope=agent` with `agent_id`: the sessions started from any release of that agent, whoever started them. The workspace's owner and admins and the agent's admins read it; anyone else, and every API key, gets 403, and an agent of another workspace, or none, is 404 for everyone. `agent_id` is required with it and refused with any other scope, and `group_by` is refused with it.\n\n`cost_usd` is the sum of `cost.amount_usd` from `GET /v1/sessions/{id}/usage` over the same sessions: an estimate, not a bill. `cost_complete: false` means one of them has a turn still open or one that ended without reporting its cost, so the true total is unknown. `run_seconds` is wall-clock turn time, waiting for an answer included; an open turn counts up to `refreshed_at`. Sessions from before tokens were metered count 0 tokens.\n\n`group_by=agent`, `group_by=user` or `group_by=profile` adds `groups`: the same sessions, each once, under its agent, the user holding it or the session's current profile (`sessions.profile_id`; a session that changed profile counts whole under the one it has now), largest cost first, read in the same statement as the totals. The groups' `session_count`, `cost_usd` and `run_seconds` add up to the totals (`run_seconds` is the floor of the running total minus the floor of the one before it, so two groups of 1.5 seconds read 1 and 2), and `cost_complete` is false when any group's is. `id` is the agent id, user id or profile id; it is null for sessions without an agent or a profile, or started by a key no person created. `name` is the agent's name, the user's display name (never an email) or, as profiles have no display name, the profile id; under `scope=me` a user other than the caller is null. Without `group_by` there is no `groups`. It changes nothing.",
    scope: "read",
    query: "UsageSummaryQuery",
    success: {
      status: 200,
      schema: "UsageSummaryResponse",
      description: "The figures as of `refreshed_at`.",
      example: {
        scope: "me",
        period: {
          since: "2026-10-01T00:00:00.000Z",
          until: "2026-10-11T08:15:43.000Z",
        },
        refreshed_at: "2026-10-11T08:15:43.000Z",
        session_count: 12,
        cost_usd: "3.218400",
        cost_complete: false,
        token_count: 1824500,
        run_seconds: 5410,
        basis: {
          sessions: "created_in_period",
          cost: "provider_usage_estimate",
          run_time: "turn_wall_clock",
        },
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/usage/outcomes",
    operationId: "getUsageOutcomes",
    tag: "Limits & receipts",
    summary:
      "What the sessions created in a period cost and the pull requests they made",
    description:
      "The sessions `GET /v1/usage/summary` would count for the same `scope`, `since`, `until` and `agent_id`, read by the same callers (403 and 404 alike), with the pull requests they opened (`GET /v1/sessions/{id}/outcomes`). Outcomes are counted per session before the sessions are summed, so a session's cost adds once however many pull requests it opened, and a session without one still adds its cost: `session_count` and `cost_usd` are the summary's.\n\n`pr_count`, `merged_pr_count` and `closed_pr_count` count the pull requests by their state as last read; `sessions_with_pr` and `sessions_with_merged_pr` count sessions. `cost_per_merged_pr_usd` is every session's cost over `merged_pr_count` (null with none merged), since the sessions without one were spent to get them too; `cost_of_merged_sessions_usd` is only the sessions with a merged pull request. The period cuts on when each session was created, so a pull request merged after the period still counts in it, and reading the same period later can show more merged. An `unmetered` session costs 0; read `token_count` alongside.\n\n`group_by=agent` adds `groups`, the same figures per agent, largest cost first; `id` and `name` are null for sessions without an agent. It is refused with `scope=agent`. It changes nothing.",
    scope: "read",
    query: "UsageOutcomesQuery",
    success: {
      status: 200,
      schema: "UsageOutcomesResponse",
      description: "The figures as of `refreshed_at`.",
      example: {
        scope: "agent",
        period: {
          since: "2026-10-01T00:00:00.000Z",
          until: "2026-10-31T00:00:00.000Z",
        },
        refreshed_at: "2026-10-31T00:00:02.000Z",
        session_count: 9,
        cost_usd: "4.120000",
        cost_complete: true,
        token_count: 2104300,
        sessions_with_pr: 3,
        sessions_with_merged_pr: 2,
        pr_count: 4,
        merged_pr_count: 2,
        closed_pr_count: 1,
        cost_of_merged_sessions_usd: "1.380000",
        cost_per_merged_pr_usd: "2.060000",
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/usage/achievements",
    operationId: "getUsageAchievements",
    tag: "Limits & receipts",
    summary:
      "What the sessions created in a period cost and the achievements they earned",
    description:
      "The sessions `GET /v1/usage/summary` would count for the same `scope`, `since`, `until` and `agent_id`, read by the same callers (403 and 404 alike), with the achievements the workspace's achievement rules counted for them (`GET /v1/sessions/{id}/achievements`). With `scope=installation` or `me`, `agent_id` narrows the sessions to that agent's. `session_count` and `cost_usd` are the summary's; each session's cost adds once however many achievements it has.\n\n`achievement_count` counts the achievements in force whose review state is `auto` or `confirmed`; `needs_review_count` and `rejected_count` count the others. `cost_per_achievement_usd` is every session's cost, those without an achievement included, over `achievement_count` (null with none). `judge_cost_usd`, `judge_calls` and `judgment_count` are the judge's spend on the same sessions, apart from the sessions' cost; `judgment_count` counts the judgments that called the judge.\n\n`type_id` and `category_id` narrow the achievements, never the sessions, their cost or the judge's cost. `by_category`, `by_type` and `by_rule` list the rows with an achievement counted or waiting for review, a category or type under its current name and a rule family once, under its latest version's category, title and `version` and with every version's achievements; `by_agent` lists every agent with a session in the period; `recent` the latest 20 achievements in force, rejected ones included. An achievement of a session the caller may not read (one in another owner, one not shared with the caller, or a `workspace`-scoped session of an agent whose managing team the caller is outside while `agent_outsider_session_visibility` is `managing_team`) is left out of `recent`, since a conversation's achievement carries its session's title and link; the counts still include it. The period cuts on when each session was created. It changes nothing.",
    scope: "read",
    query: "UsageAchievementsQuery",
    success: {
      status: 200,
      schema: "UsageAchievementsResponse",
      description: "The figures as of `refreshed_at`.",
      example: {
        scope: "installation",
        period: {
          since: "2026-10-01T00:00:00.000Z",
          until: "2026-10-31T00:00:00.000Z",
        },
        refreshed_at: "2026-10-31T00:00:02.000Z",
        session_count: 9,
        sessions_with_achievement_count: 2,
        cost_usd: "4.120000",
        cost_complete: true,
        achievement_count: 2,
        needs_review_count: 0,
        rejected_count: 0,
        judgment_count: 1,
        judge_calls: 2,
        judge_cost_usd: "0.000310",
        cost_per_achievement_usd: "2.060000",
        by_category: [
          {
            id: "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
            name: "Development",
            achievement_count: 2,
            needs_review_count: 0,
          },
        ],
        by_type: [
          {
            id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
            key: "pull_request",
            name: "GitHub PR",
            achievement_count: 2,
            needs_review_count: 0,
          },
        ],
        by_rule: [
          {
            id: "2f3e4d5c-6b7a-4980-8b1c-2d3e4f5a6b7c",
            family_id: "2f3e4d5c-6b7a-4980-8b1c-2d3e4f5a6b7c",
            version: 1,
            title: "Merged pull request",
            category_id: "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
            category_name: "Development",
            type_id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
            type_key: "pull_request",
            achievement_count: 2,
            needs_review_count: 0,
          },
        ],
        by_agent: [
          {
            id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
            name: "backend-fixer",
            session_count: 9,
            cost_usd: "4.120000",
            achievement_count: 2,
            cost_per_achievement_usd: "2.060000",
          },
        ],
        recent: [
          {
            id: "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e",
            created_at: "2026-10-30T11:03:00.000Z",
            session_id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
            session_title: "Orders are charged twice when payment fails",
            rule_id: "2f3e4d5c-6b7a-4980-8b1c-2d3e4f5a6b7c",
            rule_title: "Merged pull request",
            title: "acme/shop#412",
            link: "https://github.com/acme/shop/pull/412",
            evidence_kind: "github_pull_request",
            judge: "luna",
            review_state: "auto",
          },
        ],
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/usage/series",
    operationId: "getUsageSeries",
    tag: "Limits & receipts",
    summary: "The usage summary of a period, one bucket per UTC day",
    description:
      "Splits `GET /v1/usage/summary` by the UTC day each session was created on: one bucket per day the period `[since, until)` touches, oldest first, days without sessions included. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days. `bucket` is `day`, the only size.\n\nThe buckets of one response add up to the summary of the same period: `session_count`, `cost_usd` and `token_count` sum, and `cost_complete` is false on a day whose sessions include one the summary would mark incomplete. `run_seconds` is the floor of the running total of turn time minus the floor of the one before it, so two days of 0.6 seconds read 0 and 1, as the summary reads 1. A long session's cost and time count on the day it started. It changes nothing.",
    scope: "read",
    query: "UsageSeriesQuery",
    success: {
      status: 200,
      schema: "UsageSeriesResponse",
      description: "The buckets as of `refreshed_at`.",
      example: {
        period: {
          since: "2026-10-09T00:00:00.000Z",
          until: "2026-10-11T08:15:43.000Z",
        },
        refreshed_at: "2026-10-11T08:15:43.000Z",
        buckets: [
          {
            date: "2026-10-09",
            session_count: 5,
            cost_usd: "1.204100",
            cost_complete: true,
            token_count: 702300,
            run_seconds: 2210,
          },
          {
            date: "2026-10-10",
            session_count: 0,
            cost_usd: "0",
            cost_complete: true,
            token_count: 0,
            run_seconds: 0,
          },
          {
            date: "2026-10-11",
            session_count: 2,
            cost_usd: "0.381000",
            cost_complete: false,
            token_count: 154200,
            run_seconds: 640,
          },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/breakdown",
    operationId: "getUsageBreakdown",
    tag: "Limits & receipts",
    summary: "The usage summary of a period by model or by agent",
    description:
      "Groups the sessions `GET /v1/usage/summary` adds up by the model their metered calls named (`by=model`) or by their agent (`by=agent`), largest cost first, with the input, output, cache read and cache write tokens of those calls. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days.\n\n`token_count` is the four token columns' sum; the 1-hour cache writes are inside `cache_creation_input_tokens`. `totals` is the summary of the same period: its `session_count`, `token_count` and `cost_usd` equal it.\n\n- `by=agent`: each session counts once under its agent (`key` is the agent id, `label` its name), so the rows add up to `totals` in every column. Sessions without an agent are the row whose `key` and `label` are null.\n- `by=model`: a session counts under every model it called, so the rows' `session_count` may add up to more than the totals'. A session's cost its metered calls do not explain, such as an engine's turn totals from before proxy metering, is the row whose `key` and `label` are null, with no tokens.\n\nIt changes nothing.",
    scope: "read",
    query: "UsageBreakdownQuery",
    success: {
      status: 200,
      schema: "UsageBreakdownResponse",
      description: "The groups and their totals; this example is `by=model`.",
      example: {
        rows: [
          {
            key: "claude-opus-5-5",
            label: "claude-opus-5-5",
            session_count: 9,
            input_tokens: 182000,
            output_tokens: 64000,
            cache_read_input_tokens: 1210000,
            cache_creation_input_tokens: 96000,
            token_count: 1552000,
            cost_usd: "2.811000",
          },
          {
            key: null,
            label: null,
            session_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            token_count: 0,
            cost_usd: "0.407400",
          },
        ],
        totals: {
          session_count: 10,
          input_tokens: 182000,
          output_tokens: 64000,
          cache_read_input_tokens: 1210000,
          cache_creation_input_tokens: 96000,
          token_count: 1552000,
          cost_usd: "3.218400",
        },
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/tools",
    operationId: "getUsageTools",
    tag: "Limits & receipts",
    summary: "Calls, failures and time per tool in a period",
    description:
      "Counts the tool calls whose `tool_use` event was stored in `[since, until)`, per tool name, the most-called first and at most 200 names. `scope`, `since` and `until` work as in `GET /v1/usage/summary`; `agent_id` narrows to the sessions pinned to a release of that agent. Subagent calls count too.\n\nA call is timed from its `tool_use` to the `tool_result` paired with it in the same session and attempt by `tool_use_id`. A call with no result yet, or with either event's time missing, counts in `calls` but in no `_ms` figure. `failed` counts results with `is_error: true`; a result without `is_error` is a success, and one whose `is_error` is not a boolean is neither. `median_ms` is read from a histogram: the middle call's time, or the mean of the two middle calls' for an even count, each read within 5% or 1 ms, except that a call of about 65 minutes or more reads as about 65 minutes, so a median that takes in such a call reads low. It is never above `max_ms`. Over whole UTC days `max_ms` is the largest time a call has had: if an earlier result later replaces a call's time, it does not come down there. Figures come from a table the reconciler fills on each pass, so a call shows up within one pass of being stored, usually seconds. Each finding names a row of `tools`: `most_time` the largest `total_ms`, `fails_often` the highest `failed / calls`, `slowest` the largest `median_ms`; a kind no tool qualifies for is left out. `description` is the line an MCP server gave its tool when a session in the same scope started, the newest such session's, redacted, on one line and at most 200 characters; built-in tools, and tools no session in scope described, have `null`. The response names tools and figures only, never a session. It changes nothing.",
    scope: "read",
    query: "UsageToolsQuery",
    success: {
      status: 200,
      schema: "UsageToolsResponse",
      description: "The tools called in the period.",
      example: {
        tools: [
          {
            name: "Bash",
            calls: 1840,
            failed: 21,
            total_ms: 13320000,
            median_ms: 3100,
            max_ms: 298000,
            description: null,
          },
          {
            name: "mcp__linear__get_issue",
            calls: 702,
            failed: 12,
            total_ms: 1620000,
            median_ms: 900,
            max_ms: 14200,
            description: "Retrieve detailed information about an issue by ID",
          },
        ],
        findings: [
          { kind: "most_time", name: "Bash" },
          { kind: "fails_often", name: "mcp__linear__get_issue" },
          { kind: "slowest", name: "Bash" },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/tools/{name}/calls",
    operationId: "getUsageToolCalls",
    tag: "Limits & receipts",
    summary: "Recent or slowest calls of one tool, and its calls per day",
    description:
      "Lists the calls of the tool `name` whose `tool_use` event was stored in `[since, until)`, with the scopes, period and `agent_id` of `GET /v1/usage/tools`; the period spans at most 366 days. `sort=recent` (the default) lists the latest `occurred_at` first, `sort=slowest` the longest `duration_ms` first with untimed calls last; ties go to the later event. Read the next page with `next_cursor`, which is null on the last page; a cursor from the other sort is 400.\n\n`session_id` and `title` are null for a session the caller may not read (one in another owner, one not shared with the caller, or a `workspace`-scoped session of an agent whose managing team the caller is outside while `agent_outsider_session_visibility` is `managing_team`); the call's time, duration, outcome and agent still show. `agent` is null for a session made without an agent. `outcome` is `unknown` while no result is paired or when the result's `is_error` is not a boolean; `duration_ms` is null without a paired result or with either time missing, and set even when `outcome` is `unknown`. `per_day` counts the tool's calls on every UTC date the period touches, zeros included. Calls show up within one reconciler pass of being stored. It changes nothing.",
    scope: "read",
    query: "UsageToolCallsQuery",
    success: {
      status: 200,
      schema: "UsageToolCallsResponse",
      description: "One page of the tool's calls.",
      example: {
        calls: [
          {
            session_id: EXAMPLE_SESSION_ID,
            title: "Fix the flaky login test",
            agent: "Reviewer",
            occurred_at: "2026-10-24T09:14:03.120Z",
            duration_ms: 3120,
            outcome: "ok",
          },
          {
            session_id: null,
            title: null,
            agent: null,
            occurred_at: "2026-10-24T09:12:41.004Z",
            duration_ms: null,
            outcome: "unknown",
          },
        ],
        next_cursor:
          "eyJzb3J0IjoicmVjZW50IiwiYXQiOiIyMDI2LTEwLTI0IDA5OjEyOjQxLjAwNCswMCIsImlkIjo0MjEsIm9yZCI6MX0",
        per_day: [
          { date: "2026-10-23", calls: 0 },
          { date: "2026-10-24", calls: 2 },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/receipts/{id}",
    operationId: "getReceipt",
    tag: "Limits & receipts",
    summary: "Current outcome of an accepted command",
    description:
      "Reads the current outcome of a command by the `receipt_id` its response returned: `accepted` while it is in progress, then `succeeded`, `failed` (with `error`) or `unknown` (nobody can say; `error` explains). Poll until it leaves `accepted`. `result` depends on `operation`:\n\n- `create_session`, `append_message`: the acceptance response exactly as first returned, never rewritten. The turn's outcome is read from `GET /v1/sessions/{session_id}/turns/{turn_id}` using `target_ref`.\n- `interrupt`: `{turn_id, terminal, no_op}` once settled.\n- `pause`, `resume`: `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n- `close`: `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`; `checkpoint_revision` is null only for a session that never ran a turn.\n- `terminate`: `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`.\n- `recovery_decision`: `{resulting_admission_state, checkpoint_revision, resumable}`.\n- `answer`: null; only `status` and `error` change.\n- `request_push`, `resolve_push`, `push`: `{push_request_id, action, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`; `verdict` is `allow` or `refuse`, a refused attempt is `failed` with the reason in `refusal` and `error`, and fields the attempt never read are null. `actor` names who made it. Receipts written before the rename say `decide_push`, `decision`, `already_decided` and `PUSH_REQUEST_DECIDED` instead.\n- `open_pull_request`, `update_pull_request`, `comment_pull_request`: `{push_request_id, verdict, refusal, repository_id, number, url, head, base, created}`, and for a comment also `{comment_id, comment_url, marker}`, and for an open or update whose body came from structured fields also `template` (`{commit, path?, blob_sha?, skipped?}`: the default branch's commit read, the template used or the reason one was passed over; never its text); `created` is false when the call answered an open pull request, edited the marked comment, or (always, for `update_pull_request`) changed the title or body of the pull request with the built-in `github` MCP server's `update_pull_request`.\n- `close_pull_request`, `reopen_pull_request`: the same fields plus `{state, changed}`, written when the session's agent closes or reopens the pull request of its push request with the built-in `github` MCP server's tools of those names; `state` is the pull request's state after the call and `changed` is false when it was already in that state. A merged pull request is refused with `pull_request_merged` (`PULL_REQUEST_MERGED`).\n- `merge_pull_request`: the same fields as `close_pull_request` plus `{merged, changed, head_sha, merge_commit_sha, method}`, written when the session's agent squash-merges the pull request of its push request with the built-in `github` MCP server's `merge_pull_request`; `method` is `squash`, or null when the pull request was already merged on the pushed commit (`changed` false). A refusal is `failed` with `reason_code` `merge_off` (the workspace has not allowed merging; `GITHUB_REFUSED`) before GitHub is called, or `merge_blocked` (`PULL_REQUEST_MERGE_BLOCKED`), `head_moved` or `pull_request_closed` (`PULL_REQUEST_CLOSED`). A receipt refused with `merge_off` names no connection, App or role.\n- `attach_repository`: `{session_id, attempt_id, agent_id, agent_release_id, repository_id, branch, commit, failure, reason_code}`, written when the session's agent attaches a repository with the built-in `github` MCP server's `attach_repository`. It is `accepted` until the worker reports the fetch, then `succeeded` with `commit` or `failed` with `failure` (`fetch_timeout`, `fetch_too_large`, `fetch_failed`). A refused call is `failed` at once with `reason_code` `repository_not_allowed` (not on the release's list, not allowed for the profile, or the agent's GitHub off; `error.code` `GITHUB_REFUSED`), `allowed_in_newer_release` (off the session's release but allowed by the agent's active release: the session keeps the release it started with, and a new session can attach it; `GITHUB_REFUSED`) or `attempt_ended` (`STALE_EPOCH`). `agent_release_id` is the release whose list allowed it.\n- `set_slack_secret`, `delete_slack_secret`: `{purpose, last4}`; the value itself is never in a receipt.\n- `set_github_app`, `delete_github_app`: `{app_id}`; the private key is never in a receipt.\n\nAny credential of the same owner can read a receipt, except that a receipt about a session needs that session to be visible to the caller, and one that changed an agent's settings (`target_ref.resource` an agent or one of its Slack bindings, other than a refused `create_session`) is read only by those who read the agent's settings: its workspace's owners and admins, its admins, the live members of its managing team, and their personal keys; anyone else gets 403. A receipt that names an agent or a release of one (`agent_id`, `agent_ids`, `release_id`, `agent_release_id`, or the agent as `target_ref` or `actor.agent_id`) is shown only with those ids to a reader who may use that agent (`GET /v1/usable-agents`); for anyone else a private agent's ids are left out (a list loses them, a single field is `null`) and a receipt whose target is that agent or one of its releases answers 404, as a receipt that does not exist does. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "Receipt",
      description: "The receipt as it stands now.",
      example: {
        id: EXAMPLE_RECEIPT_ID,
        operation: "pause",
        target_ref: {
          session_id: EXAMPLE_SESSION_ID,
          turn_id: null,
          request_id: null,
        },
        status: "succeeded",
        result: {
          resulting_admission_state: "paused",
          checkpoint_revision: 3,
          queued_turn_count: 1,
        },
        error: null,
        created_at: "2026-10-11T08:20:00Z",
        updated_at: "2026-10-11T08:20:09Z",
      },
    },
    errors: [401, 404, 503],
  },
] as const satisfies readonly RouteDeclaration[];

export const OPENAPI_COMPONENT_SCHEMAS: Record<ComponentName, z.ZodType> = {
  ...requestComponents,
  ...responseComponents,
};

export type ApiOperationId =
  (typeof API_ROUTE_DECLARATIONS)[number]["operationId"];

/**
 * The session scope each operation demands, as the API enforces it before
 * reading a body or a resource. Routes without a scope are the
 * probes, the public auth routes and cookie-only logout.
 */
export const DOCUMENTED_ROUTE_SCOPES: ReadonlyArray<{
  method: Uppercase<RouteDeclaration["method"]>;
  path: string;
  scope: SessionScope;
  checkedBy: "api" | "service";
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  const scope = scopeOf(route);
  return scope
    ? [
        {
          method: route.method.toUpperCase() as Uppercase<
            RouteDeclaration["method"]
          >,
          path: route.path,
          scope,
          checkedBy: route.scopeCheckedBy ?? "api",
        },
      ]
    : [];
});

export const API_ROUTE_SCOPES = DOCUMENTED_ROUTE_SCOPES.filter(
  (route) => route.checkedBy === "api",
).map(({ method, path, scope }) => ({ method, path, scope }));

type JsonSchema = Record<string, unknown>;

function scopeOf(route: RouteDeclaration): SessionScope | undefined {
  return route.scope ? `sessions:${route.scope}` : undefined;
}

function securityFor(route: RouteDeclaration): Array<Record<string, string[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "session") return [{ cookieSession: [] }];
  const scope = scopeOf(route);
  return scope ? [{ bearerApiKey: [scope] }, { cookieSession: [scope] }] : [];
}

function takesIdempotencyKey(route: RouteDeclaration): boolean {
  return route.method !== "get" && route.idempotent !== false;
}

function errorContext(route: RouteDeclaration): ErrorContext {
  return {
    scope: scopeOf(route),
    auth: route.auth ?? "any",
    csrf:
      route.csrf === "always"
        ? "always"
        : takesCookieMutation(route)
          ? "cookie"
          : "none",
    idempotencyKey: takesIdempotencyKey(route),
    lastEventId: route.lastEventId === true,
    body: route.body !== undefined,
    message:
      route.body !== undefined &&
      "message" in requestShape(OPENAPI_COMPONENT_SCHEMAS[route.body]),
    query: route.query !== undefined,
  };
}

function requestShape(schema: z.ZodType): Record<string, unknown> {
  return schema instanceof z.ZodObject ? schema.shape : {};
}

// The /v1 middleware refuses a cookie-authenticated mutation without the
// CSRF header (403), so every such operation documents both; bearer calls
// never send it, hence `required: false`.
function takesCookieMutation(route: RouteDeclaration): boolean {
  return (
    route.method !== "get" &&
    securityFor(route).some((scheme) => "cookieSession" in scheme)
  );
}

function ref(name: ComponentName) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(name: ComponentName, example?: unknown) {
  return {
    "application/json": {
      schema: ref(name),
      ...(example === undefined ? {} : { example }),
    },
  };
}

function errorCodesFor(
  route: RouteDeclaration,
  status: number,
): readonly ApiErrorCode[] {
  const codes = route.errorCodes?.[status] ?? COMMON_ERROR_CODES[status];
  if (!codes || codes.length === 0) {
    throw new Error(
      `No ApiErrorResponse.code values registered for ${route.method.toUpperCase()} ${route.path} ${status}`,
    );
  }
  return codes;
}

// Retry-After rides on every 429 and on a storage 503 (app.ts), not on the
// readiness probe's NOT_READY.
function responseHeaders(retryAfter = false) {
  return {
    "X-Request-Id": { $ref: "#/components/headers/RequestId" },
    ...(retryAfter
      ? { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }
      : {}),
  };
}

function errorContent(codes: readonly ApiErrorCode[]) {
  return {
    "application/json": {
      schema: {
        allOf: [
          ref("ApiErrorResponse"),
          {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  code: { type: "string", enum: codes },
                },
              },
            },
          },
        ],
      },
    },
  };
}

/**
 * What a path parameter names, by the segment before it and its name. The
 * contracts' params schemas carry no descriptions, so the reference would
 * otherwise show a bare `id` on 30 agent operations alike.
 */
const PATH_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "achievement-categories/{id}": "The achievement category's id.",
  "achievement-rules/{family_id}":
    "The rule family's id: every version of one rule shares it.",
  "achievement-types/{id}": "The achievement type's id.",
  "achievements/{id}": "The achievement's id.",
  "admins/{kind}":
    "`users` for an admin who is a member, `teams` for one that is a team.",
  "agents/{id}": "The agent's id.",
  "api-keys/{id}": "The API key's id.",
  "app-pins/{role}": "The GitHub App role the pin is for.",
  "apps/{app_id}": "The Slack app's id.",
  "connections/{id}": "The model connection's id.",
  "credential-bindings/{binding_id}": "The credential binding's id.",
  "events/{agent_id}": "The agent whose Slack app sends the events.",
  "github-apps/{connectionId}": "The GitHub App connection's id.",
  "github-apps/{role}":
    "A GitHub App role, or the id of one connection of a role.",
  "github-repositories/{repositoryId}":
    "The repository's id in the workspace's repository catalog.",
  "identities/{identity_id}": "The agent identity's id.",
  "installation-profiles/{profile_id}": "The installation profile's id.",
  "interactions/{agent_id}":
    "The agent whose Slack app sends the interactions.",
  "invites/{id}": "The invite's id.",
  "linked-accounts/{id}": "The linked account's id.",
  "mcp-servers/{id}": "The MCP server's id.",
  "members/{userId}": "The member's user id.",
  "members/{user_id}": "The member's user id.",
  "outputs/{path}":
    "The `path` the outputs list gives, percent-encoded as one segment (`out/report.md` is `out%2Freport.md`).",
  "pull-requests/{number}": "The pull request's number on its repository.",
  "push-requests/{push_request_id}": "The push request's id.",
  "receipts/{id}": "The receipt's id.",
  "secrets/{purpose}": "Which of the Slack app's secrets.",
  "sessions/{id}": "The session's id.",
  "slack-bindings/{binding_id}": "The Slack binding's id.",
  "teams/{team_id}": "The team's id.",
  "tools/{name}": "The tool's name as its `tool_use` event recorded it.",
  "turns/{turn_id}": "The turn's id.",
  "users/{user_id}": "The user's id.",
  "variables/{name}": "The variable's name.",
  "workflow-runs/{run_id}": "The GitHub Actions workflow run's id.",
  "workspace-profiles/{profile_id}": "The workspace profile's id.",
  "workspaces/{id}": "The workspace's id.",
  "{kind}/{subject_id}": "The member's user id or the team's id, by `kind`.",
};

function pathParameterDescription(path: string, name: string) {
  const segments = path.split("/");
  const at = segments.indexOf(`{${name}}`);
  return PATH_PARAMETER_DESCRIPTIONS[`${segments[at - 1]}/{${name}}`];
}

const USAGE_PERIOD_START =
  "Start of the period, inclusive: a date (`2026-10-01`, that day's 00:00 UTC) or a timestamp with an offset, moved to UTC.";
const USAGE_PERIOD_END =
  "End of the period, exclusive, in the same forms as `since`. Without it the period ends when the figures are read.";
const USAGE_SCOPE =
  "Whose sessions to count. The description says who may read each scope.";

/**
 * What a query parameter does, for those whose schema says nothing. A
 * `METHOD path name` key is for one operation; a bare name for every other.
 */
const QUERY_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  cursor: "The `next_cursor` of the page before; omit it for the first page.",
  limit: "How many items a page holds at most.",
  since: USAGE_PERIOD_START,
  until: USAGE_PERIOD_END,
  scope: USAGE_SCOPE,
  agent_id: "Counts only the sessions of this agent, any of its releases.",
  "GET /v1/limits scope":
    "`installation` (the default) for the limits and the installation-wide usage, `me` for the per-session limits alone.",
  "GET /v1/usage/summary agent_id":
    "With `scope=agent`, the agent whose sessions to count; refused with any other scope.",
  "GET /v1/usage/outcomes agent_id":
    "With `scope=agent`, the agent whose sessions to count; refused with any other scope.",
  "GET /v1/usage/summary group_by":
    "Adds `groups`: the same sessions under their agent, the user holding them or their current profile.",
  "GET /v1/usage/outcomes group_by":
    "`agent` adds `groups`, the same figures per agent.",
  "GET /v1/agents/{id}/slack-channels ids":
    "The Slack channel ids to look up, comma-separated, at most 50.",
  type_id: "Counts only the achievements of this achievement type.",
  category_id: "Counts only the achievements of this category.",
  bucket: "The size of one bucket; `day` is the only one.",
  by: "Groups by the model the metered calls named, or by agent.",
  sort: "`recent` lists the latest call first, `slowest` the longest first.",
  installation_id:
    "The GitHub App installation to list. Required while the role has several connections.",
  page: "The page of GitHub's listing, from 1.",
  per_page: "How many repositories GitHub puts on a page.",
  include: "`summary` adds to each agent what its card shows.",
  dry_run:
    "`true` checks the document and answers as an import would, writing nothing.",
  schedule:
    "`true` holds the call until a push that is not finished yet is pushed, instead of refusing it.",
};

function queryParameters(schema: JsonSchema, operation: string) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const description =
      property.description === undefined
        ? (QUERY_PARAMETER_DESCRIPTIONS[`${operation} ${name}`] ??
          QUERY_PARAMETER_DESCRIPTIONS[name])
        : undefined;
    return {
      name,
      in: "query",
      required: required.has(name),
      ...(description === undefined ? {} : { description }),
      schema: property,
    };
  });
}

function paramsSchemaFor(path: string): z.ZodObject {
  if (path === "/v1/receipts/{id}") return receiptIdParamsSchema;
  if (path.startsWith("/v1/agents/{id}/admins/")) return agentAdminParamsSchema;
  if (path.includes("{binding_id}")) return credentialBindingParamsSchema;
  if (path.startsWith("/v1/workspace/variables/{name}"))
    return workspaceVariableParamsSchema;
  if (path === "/v1/agents/{id}/variables/{name}")
    return agentVariableParamsSchema;
  if (path === "/v1/agents/{id}/identities/{identity_id}")
    return agentIdentityParamsSchema;
  if (path.startsWith("/v1/agents/{id}")) return agentIdParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}/members/"))
    return teamMemberParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}")) return teamIdParamsSchema;
  if (path.startsWith("/v1/workspace-profiles/{profile_id}"))
    return workspaceProfileIdParamsSchema;
  if (path.startsWith("/v1/installation/settings/")) {
    return settingsIdParamsSchema;
  }
  if (path.startsWith("/v1/achievement-categories/{id}"))
    return achievementCategoryParamsSchema;
  if (path === "/v1/achievements/{id}/review") return achievementParamsSchema;
  if (path.startsWith("/v1/achievement-types/{id}"))
    return achievementTypeParamsSchema;
  if (path.startsWith("/v1/achievement-rules/{family_id}"))
    return achievementRuleFamilyParamsSchema;
  if (path.startsWith("/v1/installation-profiles/{profile_id}"))
    return installationProfileIdParamsSchema;
  if (path.startsWith("/v1/workspaces/{id}/members/{userId}"))
    return memberParamsSchema;
  if (path.includes("{app_id}/secrets/{purpose}"))
    return slackAppSecretParamsSchema;
  if (path.includes("{app_id}")) return slackAppParamsSchema;
  if (path === "/v1/invites/{id}") return inviteIdParamsSchema;
  if (path === "/v1/api-keys/{id}") return apiKeyIdParamsSchema;
  if (path.startsWith("/v1/members/{user_id}")) return memberUserParamsSchema;
  if (path.startsWith("/v1/users/{user_id}")) return memberUserParamsSchema;
  if (path === "/v1/workspaces/{id}/github-apps/{role}") {
    return githubAppRoleParamsSchema;
  }
  if (
    path ===
    "/v1/workspaces/{id}/github-apps/{connectionId}/installations/start"
  ) {
    return githubConnectionParamsSchema;
  }
  if (
    path === "/v1/workspaces/{id}/github-repositories/{repositoryId}" ||
    path === "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins"
  ) {
    return githubRepositoryParamsSchema;
  }
  if (
    path ===
    "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins/{role}"
  ) {
    return githubRepositoryAppPinParamsSchema;
  }
  if (path.startsWith("/v1/workspaces/{id}")) return workspaceParamsSchema;
  if (path.includes("{turn_id}")) return turnIdParamsSchema;
  if (path.includes("{push_request_id}")) return pushRequestParamsSchema;
  if (path.includes("{run_id}")) return workflowRunParamsSchema;
  if (path === "/v1/sessions/{id}/github/pull-requests/{number}/reviews") {
    return pullRequestReviewParamsSchema;
  }
  if (path === "/v1/sessions/{id}/outputs/{path}") {
    return sessionOutputParamsSchema;
  }
  if (
    path.startsWith("/v1/sessions/{id}") ||
    path.startsWith("/v1/admin/sessions/{id}")
  ) {
    return sessionIdParamsSchema;
  }
  if (path.startsWith("/v1/linked-accounts/{id}"))
    return linkedAccountParamsSchema;
  if (path === "/v1/slack/events/{agent_id}") return slackEventsParamsSchema;
  if (path === "/v1/slack/interactions/{agent_id}") {
    return slackInteractionsParamsSchema;
  }
  if (path === "/v1/usage/tools/{name}/calls") {
    return usageToolCallsParamsSchema;
  }
  throw new Error(`No params schema registered for ${path}`);
}

function pathParameters(path: string) {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
  if (names.length === 0) return [];
  const schema = paramsSchemaFor(path);
  const properties = (
    z.toJSONSchema(schema as z.ZodType, { io: "input" }) as JsonSchema
  ).properties as Record<string, JsonSchema>;
  return names.map((name) => {
    const property = properties[name as string];
    if (!property) throw new Error(`No params schema for ${name} in ${path}`);
    const description =
      property.description === undefined
        ? pathParameterDescription(path, name as string)
        : undefined;
    return {
      name,
      in: "path",
      required: true,
      ...(description === undefined ? {} : { description }),
      schema: property,
    };
  });
}

function buildSchemas(): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  for (const [io, components] of [
    ["input", requestComponents],
    ["output", responseComponents],
  ] as const) {
    const registry = z.registry<{ id: string }>();
    for (const [id, schema] of Object.entries(components)) {
      registry.add(schema, { id });
    }
    const generated = z.toJSONSchema(registry, {
      io,
      uri: (id) => `#/components/schemas/${id}`,
      unrepresentable: "throw",
    }).schemas as Record<string, JsonSchema>;
    for (const [id, generatedSchema] of Object.entries(generated)) {
      const { $schema: _schema, $id: _id, ...schema } = generatedSchema;
      schemas[id] = schema;
    }
  }
  return schemas;
}

const schemas = buildSchemas();

export type ApiRouteConfig = RouteConfig & {
  path: string;
  getRoutingPath(): string;
};

function createApiRouteConfig(route: RouteDeclaration): ApiRouteConfig {
  const parameters: unknown[] = pathParameters(route.path);
  if (route.query) {
    const querySchema = schemas[route.query];
    if (!querySchema) throw new Error(`Missing query schema ${route.query}`);
    parameters.push(
      ...queryParameters(
        querySchema,
        `${route.method.toUpperCase()} ${route.path}`,
      ),
    );
  }
  if (takesIdempotencyKey(route)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: IDEMPOTENCY_KEY_DESCRIPTION,
      schema: { type: "string", minLength: 1, maxLength: 255 },
    });
  }
  if (route.ifMatch !== undefined) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: route.ifNoneMatch !== true,
      description: `The \`${route.ifMatch}\` last read, as a number (an entity tag's quotes are allowed). A different one answers \`412 VERSION_MISMATCH\`; none answers \`428 PRECONDITION_REQUIRED\`.${route.ifNoneMatch ? " Send it to change a variable that exists, `If-None-Match: *` to create one; never both." : ""}`,
      schema: { type: "string", minLength: 1 },
    });
  }
  if (route.ifNoneMatch) {
    parameters.push({
      name: "If-None-Match",
      in: "header",
      required: false,
      description:
        "The literal `*`, to create a variable that must not exist yet. One that exists answers `412 VERSION_MISMATCH`.",
      schema: { type: "string", enum: ["*"] },
    });
  }
  if (route.lastEventId) {
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      required: false,
      description: LAST_EVENT_ID_DESCRIPTION,
      schema: { type: "string", minLength: 1 },
    });
  }
  const csrf = route.csrf === "always" || takesCookieMutation(route);
  if (csrf) {
    parameters.push({
      name: "X-Requested-With",
      in: "header",
      required: route.csrf === "always",
      description:
        route.csrf === "always"
          ? "Always required: the literal `werft-web`."
          : "Required with a cookie session: the literal `werft-web`.",
      schema: { type: "string", enum: ["werft-web"] },
    });
  }
  const success = route.success;
  const responses: Record<string, unknown> = {
    [success.status]:
      success.status === 204
        ? {
            description: success.description ?? "No content",
            headers: responseHeaders(),
          }
        : "download" in success
          ? {
              description: success.description,
              headers: {
                ...responseHeaders(),
                "Content-Disposition": {
                  description:
                    "Always `attachment`, with the file's name as `filename*` (RFC 6266, UTF-8) and an ASCII `filename` fallback.",
                  schema: { type: "string" },
                },
                "Content-Length": {
                  description: "The file's size in bytes.",
                  schema: { type: "integer" },
                },
              },
              content: {
                "application/octet-stream": {
                  schema: {
                    type: "string",
                    contentMediaType: "application/octet-stream",
                  },
                },
              },
            }
          : {
              description:
                success.description ??
                (success.sse ? "Event stream" : "Success"),
              headers: responseHeaders(),
              content: success.sse
                ? {
                    "text/event-stream": {
                      schema: ref(success.schema),
                      ...(success.example === undefined
                        ? {}
                        : { example: success.example }),
                    },
                  }
                : jsonContent(success.schema, success.example),
            },
  };
  if (route.alsoSucceeds !== undefined) {
    responses[route.alsoSucceeds.status] = {
      description: route.alsoSucceeds.description,
      headers: responseHeaders(),
      content: jsonContent(
        route.alsoSucceeds.schema,
        route.alsoSucceeds.example,
      ),
    };
  }
  const errors = new Set<number>(route.errors);
  if (csrf || route.scope) errors.add(403);
  if (route.method !== "get") errors.add(408);
  const context = errorContext(route);
  for (const status of [...errors].sort((a, b) => a - b)) {
    const codes = errorCodesFor(route, status);
    responses[status] = {
      description: errorResponseDescription(codes, context, route.errorNotes),
      headers: responseHeaders(
        status === 429 ||
          (status === 503 && codes.includes("BACKEND_UNAVAILABLE")),
      ),
      content: errorContent(codes),
    };
  }
  responses[500] = { $ref: "#/components/responses/InternalError" };

  return createRoute({
    method: route.method,
    path: route.path,
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    description: [
      route.description,
      accessNote(errorContext(route), route.method),
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(route.scope ? { "x-scope": scopeOf(route) } : {}),
    security: securityFor(route),
    parameters,
    ...(route.body
      ? {
          request: {
            body: {
              required: true,
              content: route.form
                ? {
                    "application/x-www-form-urlencoded": {
                      schema: ref(route.body),
                      ...(route.requestExample === undefined
                        ? {}
                        : { example: route.requestExample }),
                    },
                  }
                : jsonContent(route.body, route.requestExample),
            },
          },
        }
      : {}),
    responses,
  } as RouteConfig & { path: string }) as ApiRouteConfig;
}

const routeConfigs = new Map<ApiOperationId, ApiRouteConfig>(
  API_ROUTE_DECLARATIONS.map((route) => [
    route.operationId,
    createApiRouteConfig(route),
  ]),
);

export function apiRouteConfig(
  operationId: ApiOperationId,
  basePath = "",
): ApiRouteConfig {
  const route = routeConfigs.get(operationId);
  if (!route) throw new Error(`Unknown API operation ${operationId}`);
  if (!basePath) return route;
  if (route.path !== basePath && !route.path.startsWith(`${basePath}/`)) {
    throw new Error(`${route.path} is not under ${basePath}`);
  }
  const path = route.path.slice(basePath.length) || "/";
  return createRoute({ ...route, path }) as ApiRouteConfig;
}

export function buildOpenApiDocument() {
  const registry = new OpenAPIHono();
  for (const route of API_ROUTE_DECLARATIONS) {
    registry.openapi(
      apiRouteConfig(route.operationId) as never,
      (() => new Response()) as never,
    );
  }
  const generated = registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Werft API",
      version: OPENAPI_VERSION,
      description: API_INFO_DESCRIPTION,
    },
  });

  return {
    openapi: generated.openapi,
    info: generated.info,
    tags: OPENAPI_TAGS,
    "x-tagGroups": OPENAPI_TAG_GROUPS,
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: SECURITY_SCHEME_DESCRIPTIONS.bearerApiKey,
        },
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: WEB_SESSION_COOKIE_NAME,
          description: SECURITY_SCHEME_DESCRIPTIONS.cookieSession,
        },
      },
      headers: RESPONSE_HEADERS,
      schemas,
      responses: {
        InternalError: {
          description:
            "- `INTERNAL_ERROR`: An unexpected server failure. Report it with the `X-Request-Id`.",
          headers: responseHeaders(),
          content: errorContent(["INTERNAL_ERROR"]),
        },
      },
    },
    paths: generated.paths ?? {},
  };
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
