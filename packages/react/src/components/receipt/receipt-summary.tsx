import type {
  Receipt,
  ReceiptOperation,
  ReceiptStatus,
  ReceiptTarget,
} from "@werft-ai/contracts";
import { cn, formatTimestamp } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { Locale } from "../../messages/index.ts";
import { guidanceFor } from "../feedback/error-guidance.ts";
import { StatusLabel } from "../status/status-label.tsx";

export const RECEIPT_OPERATION_LABEL: Record<ReceiptOperation, string> = {
  create_session: "세션 시작",
  append_message: "메시지 전송",
  answer: "답변 제출",
  interrupt: "중단 요청",
  pause: "일시정지 요청",
  close: "보관 요청",
  terminate: "종료 요청",
  resume: "재개 요청",
  recovery_decision: "복구 결정",
  change_profile: "프로필 변경",
  revoke_execution: "실행 권한 회수",
  issue_password_reset: "비밀번호 재설정 링크 발급",
  reset_password: "비밀번호 재설정",
  recover_owner: "owner 복구",
  takeover: "세션 인수",
  link_account: "Slack 계정 연결",
  unlink_account: "Slack 계정 연결 해제",
  invite_member: "초대 발급",
  accept_invite: "초대 수락",
  revoke_invite: "초대 회수",
  change_member_role: "역할 변경",
  disable_member: "멤버 비활성화",
  enable_member: "멤버 재활성화",
  disable_user: "계정 정지",
  enable_user: "계정 정지 해제",
  create_agent: "에이전트 생성",
  update_agent: "에이전트 수정",
  create_agent_release: "에이전트 release 생성",
  activate_agent: "에이전트 활성화",
  create_api_key: "API key 발급",
  revoke_api_key: "API key 폐기",
  create_team: "팀 생성",
  rename_team: "팀 이름 변경",
  delete_team: "팀 삭제",
  add_team_member: "팀에 추가됨",
  remove_team_member: "팀에서 빠짐",
  set_team_member_role: "팀 역할 변경",
  set_agent_managing_team: "담당 팀 지정",
  set_agent_usage: "에이전트 사용 범위 변경",
  set_agent_access_settings: "에이전트 접근 설정 변경",
  add_agent_admin: "에이전트 관리자 지정",
  remove_agent_admin: "에이전트 관리자 해제",
  bind_credential: "자격 연결",
  unbind_credential: "자격 연결 해제",
  link_agent_identity: "에이전트 Slack 앱 연결",
  revoke_agent_identity: "에이전트 Slack 앱 연결 회수",
  set_surface_binding: "에이전트 Slack 채널 설정",
  request_surface_binding: "비공개 Slack 채널 승인 요청",
  resolve_surface_binding: "비공개 Slack 채널 승인 결정",
  share_session: "공유 범위 변경",
  request_push: "push 요청",
  decide_push: "push 승인·거부",
  resolve_push: "push 승인·거부",
  push: "push",
  open_pull_request: "PR 열기",
  update_pull_request: "PR 수정",
  comment_pull_request: "PR 코멘트",
  close_pull_request: "PR 닫기",
  reopen_pull_request: "PR 다시 열기",
  merge_pull_request: "PR 머지",
  call_mcp: "원격 MCP 호출",
  create_workspace_profile: "워크스페이스 프로필 새 버전 저장",
  retire_workspace_profile: "워크스페이스 프로필 사용 중지",
  create_installation_profile: "설치 프로필 새 버전 저장",
  retire_installation_profile: "설치 프로필 사용 중지",
  block_installation_profile: "설치 프로필 차단",
  unblock_installation_profile: "설치 프로필 차단 해제",
  create_achievement_category: "성과 구분 만들기",
  update_achievement_category: "성과 구분 변경",
  archive_achievement_category: "성과 구분 보관",
  create_achievement_type: "성과 type 만들기",
  update_achievement_type: "성과 type 이름 변경",
  archive_achievement_type: "성과 type 보관",
  create_achievement_rule: "성과 규칙 만들기",
  update_achievement_rule: "성과 규칙 새 버전 저장",
  disable_achievement_rule: "성과 규칙 사용 중지",
  enable_achievement_rule: "성과 규칙 다시 사용",
  set_achievement_judge: "성과 판정 설정 변경",
  rejudge_session: "성과 다시 판정",
  review_achievement: "성과 확인·거절",
  set_env_variable: "변수 저장",
  delete_env_variable: "변수 삭제",
  set_env_variable_grants: "변수를 쓸 에이전트 변경",
  resolve_session_env: "세션에 변수 전달",
  reject_session_env: "세션 변수 전달 거절",
  resolve_session_engine_settings: "세션에 적용한 저장 규칙 평가",
  set_workspace_engine_settings: "워크스페이스 엔진 규칙 변경",
  set_agent_engine_settings: "에이전트 엔진 규칙 변경",
  register_extension: "확장 번들 등록",
  approve_extension: "확장 번들 검토 결과 변경",
  attach_extension: "확장 번들 연결",
  detach_extension: "확장 번들 연결 해제",
  set_github_app: "GitHub App 등록",
  delete_github_app: "GitHub App 삭제",
  mint_github_token: "GitHub 토큰 발급",
  set_github_ceiling: "에이전트 GitHub 권한 상한 변경",
  set_github_pull_request_settings: "PR 서식 설정 변경",
  set_agent_pull_request_settings: "에이전트 PR 서식 설정 변경",
  add_repository: "저장소 추가",
  resolve_repository: "저장소 고르기",
  set_repository_branch: "저장소 기본 브랜치 변경",
  set_repository_github_app: "저장소 GitHub App 고정",
  remove_repository: "저장소 제거",
  import_repository: "저장소 가져오기",
  import_connection: "모델 연결 가져오기",
  import_mcp_server: "MCP 서버 가져오기",
  create_connection: "모델 연결 만들기",
  create_mcp_server: "MCP 서버 만들기",
  set_settings_credential: "설정 자격 증명 값 바꾸기",
  set_connection_auto_mode: "모델 연결 자동 모드 판정",
  disable_connection: "모델 연결 사용 중지",
  enable_connection: "모델 연결 다시 사용",
  disable_mcp_server: "MCP 서버 사용 중지",
  set_mcp_server_workspaces: "MCP 서버 워크스페이스 변경",
  set_agent_github: "에이전트 GitHub 사용 변경",
  set_agent_mcp: "에이전트 MCP 설정 변경",
  review_pull_request: "PR 리뷰",
  dispatch_workflow: "워크플로 실행",
  rerun_workflow: "워크플로 재실행",
  attach_repository: "저장소 붙이기",
  set_github_packages_token: "GitHub Packages 토큰 등록",
  delete_github_packages_token: "GitHub Packages 토큰 삭제",
  set_github_packages_allowlist: "GitHub Packages 허용 목록 변경",
  fetch_github_package: "GitHub Packages 패키지 받기",
  set_slack_secret: "Slack 비밀값 설정",
  delete_slack_secret: "Slack 비밀값 삭제",
};

export type ReceiptTimestamps = Pick<Receipt, "created_at" | "updated_at">;
export type ReceiptError = Receipt["error"];

export interface ReceiptSummaryProps {
  readonly operation: ReceiptOperation;
  readonly status: ReceiptStatus;
  readonly target: ReceiptTarget;
  readonly timestamps: ReceiptTimestamps;
  readonly error?: ReceiptError | undefined;
  /** Trailing slot: `ReceiptLink`, a retry button, whatever the screen owns. */
  readonly action?: ReactNode | undefined;
  readonly className?: string | undefined;
  /** The language of the error guidance. */
  readonly locale?: Locale | undefined;
}

/**
 * Draws the receipt the server returned. It never infers a status: 접수(accepted)
 * is not completion, and `unknown` stays `unknown` (§1, §4.1).
 */
export function ReceiptSummary({
  operation,
  status,
  target,
  timestamps,
  error,
  action,
  className,
  locale = "ko",
}: ReceiptSummaryProps): JSX.Element {
  const guidance = guidanceFor(error?.code, locale);

  return (
    <div className={cn("werft-receipt", className)} data-status={status}>
      <div className="werft-receipt__head">
        <span className="werft-receipt__operation">
          {Object.hasOwn(RECEIPT_OPERATION_LABEL, operation)
            ? RECEIPT_OPERATION_LABEL[operation]
            : operation}
        </span>
        <StatusLabel axis="receipt" state={status} />
      </div>

      <dl className="werft-receipt__target">
        {"session_id" in target ? (
          <>
            <div className="werft-receipt__field">
              <dt>세션</dt>
              <dd className="werft-receipt__id">{target.session_id}</dd>
            </div>
            {target.turn_id ? (
              <div className="werft-receipt__field">
                <dt>턴</dt>
                <dd className="werft-receipt__id">{target.turn_id}</dd>
              </div>
            ) : null}
            {target.request_id ? (
              <div className="werft-receipt__field">
                <dt>요청</dt>
                <dd className="werft-receipt__id">{target.request_id}</dd>
              </div>
            ) : null}
          </>
        ) : "user_id" in target ? (
          <div className="werft-receipt__field">
            <dt>사용자</dt>
            <dd className="werft-receipt__id">{target.user_id}</dd>
          </div>
        ) : (
          // A mutation outside a session names its resource instead.
          // The kind shows raw until a screen actually renders one of these —
          // the ticket that adds that route owns the Korean label for it.
          <div className="werft-receipt__field">
            <dt>대상</dt>
            <dd className="werft-receipt__id">
              {target.resource.kind} · {target.resource.id}
            </dd>
          </div>
        )}
      </dl>

      {error ? (
        <p className="werft-receipt__error">
          <span className="werft-receipt__guidance">{guidance}</span>
          <span className="werft-receipt__detail">
            {error.code} · {error.message}
          </span>
        </p>
      ) : null}

      <div className="werft-receipt__foot">
        <span className="werft-receipt__times">
          접수{" "}
          <time dateTime={timestamps.created_at}>
            {formatTimestamp(timestamps.created_at)}
          </time>
          {timestamps.updated_at !== timestamps.created_at ? (
            <>
              {" · 갱신 "}
              <time dateTime={timestamps.updated_at}>
                {formatTimestamp(timestamps.updated_at)}
              </time>
            </>
          ) : null}
        </span>
        {action}
      </div>
    </div>
  );
}
