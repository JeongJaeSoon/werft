export const errorsKo = {
  "error.BAD_REQUEST": "입력을 확인하고 다시 보내세요.",
  "error.UNAUTHORIZED": "이메일 또는 비밀번호가 맞지 않습니다.",
  "error.SCOPE_NOT_GRANTABLE":
    "내가 가진 것보다 많은 권한을 키에 줄 수 없습니다.",
  "error.FORBIDDEN": "권한이 없습니다 — 소유자나 관리자에게 요청하세요.",
  "error.BOOTSTRAP_DONE": "이미 소유자가 있습니다. 로그인해 주세요.",
  "error.RATE_LIMITED": "시도가 너무 많습니다 — 잠시 뒤 다시 시도하세요.",
  "error.BACKEND_UNAVAILABLE":
    "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
  "error.NETWORK_ERROR":
    "서버에 연결하지 못했습니다 — 네트워크 연결을 확인하세요.",
  "error.LOGIN_LINK_REQUIRED":
    "이미 이 이메일로 만든 계정이 있습니다 — 비밀번호로 로그인하세요.",
  "error.UNKNOWN": "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  "error.NOT_FOUND": "더 이상 없는 항목입니다 — 목록을 다시 불러오세요.",
  "error.PAYLOAD_TOO_LARGE": "입력이 너무 깁니다 — 줄여서 다시 보내세요.",
  "error.INVITE_EXPIRED": "만료됐거나 회수된 초대입니다.",
  "error.INVITE_USED": "이미 쓰인 초대입니다.",
  "error.LAST_OWNER":
    "마지막 소유자는 역할을 바꾸거나 비활성화할 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요.",
  "error.SELF_PROTECTED":
    "자기 역할이나 접근은 직접 바꿀 수 없습니다 — 다른 소유자나 관리자에게 요청하세요.",
  "error.MEMBER_DISABLED":
    "비활성화된 구성원의 역할은 바꿀 수 없습니다 — 먼저 다시 활성화하세요.",
  "error.ACCOUNT_DISABLED":
    "계정이 정지된 사람입니다 — 계정 정지를 먼저 풀어야 역할을 바꾸거나 다시 활성화할 수 있습니다.",
  "error.OWNER_PROTECTED":
    "소유자 역할을 주거나 소유자의 역할·접근(비활성화·정지·다시 활성화)을 바꾸는 일은 소유자만 할 수 있습니다 — 소유자에게 요청하세요.",
  "error.UNSUPPORTED_CAPABILITY":
    "카드 모델이 이 프로필의 모델과 다르거나, 프로필이 허용하지 않는 도구가 있거나, 없는 프로필입니다.",
  "error.REVISION_CONFLICT":
    "다른 곳에서 먼저 바꿨습니다 — 다시 불러온 뒤 시도하세요.",
  "error.PROFILE_DIGEST_MISMATCH":
    "릴리스를 만든 뒤 프로필 설정이 바뀌었습니다 — 새 릴리스를 만드세요.",
  "error.PROFILE_BLOCKED":
    "운영자가 이 프로필이나 그 바탕 프로필을 차단했습니다 — 차단이 풀릴 때까지 새 릴리스와 세션에 쓸 수 없습니다.",
  "error.ALREADY_EXISTS": "같은 식별자(slug)가 이미 있습니다.",
  "error.SLACK_LINK_NOT_CONFIGURED":
    "Slack 계정 연결을 아직 쓸 수 없습니다 — 워크스페이스 관리자에게 연동 › Slack 설정을 요청하세요.",
  "error.GITHUB_LINK_NOT_CONFIGURED":
    "GitHub 계정 연결을 아직 쓸 수 없습니다 — 워크스페이스 관리자에게 연동 › GitHub의 사용자 연결 설정을 요청하세요.",
  "error.SLACK_APP_CREATING":
    "Slack 앱을 만드는 중입니다 — 잠시 뒤 다시 시도하세요.",
  "error.GITHUB_UNAVAILABLE":
    "GitHub에서 App의 설치나 저장소를 받지 못했습니다 — 잠시 뒤 다시 시도하세요. 계속되면 App 키를 확인하세요.",
  "error.INSTALLATION_SUSPENDED":
    "이 설치가 GitHub에서 중지됐습니다 — 그 계정의 GitHub 설치 설정에서 다시 켜세요.",
  // Only the read-only demo build answers this (src/demo/fetch.ts).
  "error.DEMO_READ_ONLY": "데모에서는 저장되지 않습니다.",
};

export const errorsEn: Record<keyof typeof errorsKo, string> = {
  "error.BAD_REQUEST": "Check what you entered and try again.",
  "error.UNAUTHORIZED": "The email or password is wrong.",
  "error.SCOPE_NOT_GRANTABLE": "A key cannot have permissions you do not have.",
  "error.FORBIDDEN": "Not allowed — ask an owner or admin.",
  "error.BOOTSTRAP_DONE": "An owner already exists. Please log in.",
  "error.RATE_LIMITED": "Too many attempts — try again shortly.",
  "error.BACKEND_UNAVAILABLE": "The server is unavailable — try again shortly.",
  "error.NETWORK_ERROR": "Could not reach the server — check your connection.",
  "error.LOGIN_LINK_REQUIRED":
    "An account with this email already exists — log in with its password.",
  "error.UNKNOWN": "Something went wrong — try again shortly.",
  "error.NOT_FOUND": "It no longer exists — reload the list.",
  "error.PAYLOAD_TOO_LARGE":
    "The input is too long — shorten it and try again.",
  "error.INVITE_EXPIRED": "This invite has expired or was revoked.",
  "error.INVITE_USED": "This invite has already been used.",
  "error.LAST_OWNER":
    "The last owner cannot change their role or be disabled — make someone else an owner first.",
  "error.SELF_PROTECTED":
    "You cannot change your own role or access — ask another owner or admin.",
  "error.MEMBER_DISABLED":
    "A disabled member's role cannot change — enable them first.",
  "error.ACCOUNT_DISABLED":
    "This person's account is suspended — lift the suspension before changing their role or enabling them.",
  "error.OWNER_PROTECTED":
    "Only an owner can grant the owner role or change an owner's role or access (disable, suspend, re-enable) — ask an owner.",
  "error.UNSUPPORTED_CAPABILITY":
    "The card's model is not this profile's model, the card uses a tool the profile does not allow, or the profile does not exist.",
  "error.REVISION_CONFLICT":
    "Someone changed this first — reload and try again.",
  "error.PROFILE_DIGEST_MISMATCH":
    "The profile changed after this release was created — create a new release.",
  "error.PROFILE_BLOCKED":
    "The operator blocked this profile or the profile it is based on — no new release or session can use it until it is unblocked.",
  "error.ALREADY_EXISTS": "That identifier (slug) is already taken.",
  "error.SLACK_LINK_NOT_CONFIGURED":
    "Slack account linking isn't available yet — ask a workspace admin to set up Slack in Integrations.",
  "error.GITHUB_LINK_NOT_CONFIGURED":
    "GitHub account linking isn't available yet — ask a workspace admin to set up user linking in Integrations › GitHub.",
  "error.SLACK_APP_CREATING":
    "The Slack app is being created — try again shortly.",
  "error.GITHUB_UNAVAILABLE":
    "GitHub did not return the App's installations or repositories — try again shortly. If it keeps failing, check the App's key.",
  "error.INSTALLATION_SUSPENDED":
    "This installation is suspended on GitHub — resume it in that account's GitHub installation settings.",
  "error.DEMO_READ_ONLY": "Changes are not saved in this demo.",
};

export const errorsJa: Record<keyof typeof errorsKo, string> = {
  "error.BAD_REQUEST": "入力内容を確認して、もう一度お試しください。",
  "error.UNAUTHORIZED": "メールアドレスまたはパスワードが正しくありません。",
  "error.SCOPE_NOT_GRANTABLE":
    "自分が持っていない権限をキーに付与することはできません。",
  "error.FORBIDDEN":
    "権限がありません。オーナーまたは管理者に依頼してください。",
  "error.BOOTSTRAP_DONE": "オーナーはすでに存在します。ログインしてください。",
  "error.RATE_LIMITED":
    "試行回数が多すぎます。しばらくしてからもう一度お試しください。",
  "error.BACKEND_UNAVAILABLE":
    "サーバーを利用できません。しばらくしてからもう一度お試しください。",
  "error.NETWORK_ERROR":
    "サーバーに接続できませんでした。ネットワーク接続を確認してください。",
  "error.LOGIN_LINK_REQUIRED":
    "このメールアドレスのアカウントはすでに存在します。そのアカウントのパスワードでログインしてください。",
  "error.UNKNOWN":
    "問題が発生しました。しばらくしてからもう一度お試しください。",
  "error.NOT_FOUND": "すでに存在しません。一覧を再読み込みしてください。",
  "error.PAYLOAD_TOO_LARGE":
    "入力内容が長すぎます。短くしてからもう一度お試しください。",
  "error.INVITE_EXPIRED": "この招待は期限切れか、取り消されています。",
  "error.INVITE_USED": "この招待はすでに使用されています。",
  "error.LAST_OWNER":
    "最後のオーナーは、ロールの変更も無効化もできません。先にほかの人をオーナーにしてください。",
  "error.SELF_PROTECTED":
    "自分のロールやアクセスは自分で変更できません。ほかのオーナーか管理者に依頼してください。",
  "error.MEMBER_DISABLED":
    "無効化されたメンバーのロールは変更できません。先に再有効化してください。",
  "error.ACCOUNT_DISABLED":
    "このユーザーのアカウントは停止中です。ロールの変更や再有効化の前に、アカウントの停止を解除してください。",
  "error.OWNER_PROTECTED":
    "オーナーのロールの付与や、オーナーのロール・アクセス（無効化・停止・再有効化）の変更ができるのはオーナーのみです。オーナーに依頼してください。",
  "error.UNSUPPORTED_CAPABILITY":
    "カードのモデルがこのプロファイルのモデルと異なるか、プロファイルで許可されていないツールをカードが使っているか、プロファイルが存在しません。",
  "error.REVISION_CONFLICT":
    "ほかの人が先に変更しました。再読み込みしてから、もう一度お試しください。",
  "error.PROFILE_DIGEST_MISMATCH":
    "このリリースの作成後にプロファイルが変更されました。新しいリリースを作成してください。",
  "error.PROFILE_BLOCKED":
    "運用担当者がこのプロファイルか、そのもとになっているプロファイルをブロックしました。解除されるまで、新しいリリースとセッションでは使えません。",
  "error.ALREADY_EXISTS": "この識別子（slug）はすでに使われています。",
  "error.SLACK_LINK_NOT_CONFIGURED":
    "Slack アカウント連携はまだ使えません。ワークスペースの管理者に 連携 › Slack の設定を依頼してください。",
  "error.GITHUB_LINK_NOT_CONFIGURED":
    "GitHub アカウント連携はまだ使えません。ワークスペースの管理者に 連携 › GitHub のユーザー連携の設定を依頼してください。",
  "error.SLACK_APP_CREATING":
    "Slack アプリを作成中です。しばらくしてから、もう一度お試しください。",
  "error.GITHUB_UNAVAILABLE":
    "GitHub から App のインストールやリポジトリを受け取れませんでした。しばらくしてから、もう一度お試しください。続く場合は App のキーを確認してください。",
  "error.INSTALLATION_SUSPENDED":
    "このインストールは GitHub で停止されています。そのアカウントの GitHub インストール設定で再開してください。",
  "error.DEMO_READ_ONLY": "このデモでは変更は保存されません。",
};
