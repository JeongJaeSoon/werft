export const authKo = {
  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.submit": "로그인",
  "login.submitting": "로그인하는 중…",
  "login.bootstrapPrompt":
    "첫 소유자는 설치 때 출력된 bootstrap 토큰으로 한 번만 만들 수 있습니다.",
  "login.bootstrapLink": "첫 소유자 만들기",
  "login.notice.bootstrapDone":
    "이미 소유자가 있습니다. 그 계정으로 로그인하세요.",
  "login.notice.loggedOut": "로그아웃했습니다.",
  "login.notice.created":
    "소유자를 만들었습니다. 방금 정한 비밀번호로 로그인하세요.",

  "login.or": "또는",
  "login.alternatives": "다른 로그인 방법",
  "login.provider.submit": "{name} 계정으로 로그인",
  "login.provider.starting": "로그인 화면으로 이동하는 중…",
  "login.provider.title": "SSO 로그인",
  "login.provider.rejected":
    "이 계정으로 로그인하지 못했습니다 — 초대받은 이메일 주소의 계정인지 확인하고 다시 시도하세요.",
  "login.provider.forbidden":
    "이 계정으로는 로그인할 수 없습니다 — 워크스페이스가 허용한 도메인의 계정을 쓰세요.",
  "login.provider.cancelled": "로그인을 마치지 못했습니다 — 다시 시도하세요.",
  "login.provider.backToLogin": "로그인 화면으로",
  "login.provider.unavailable":
    "이 로그인 방법은 지금 쓸 수 없습니다 — 로그인 화면에서 다른 방법을 고르세요.",

  "bootstrap.title": "첫 소유자 만들기",
  "bootstrap.intro":
    "이 설치를 처음 설정할 때 첫 소유자와 워크스페이스를 만드는 화면입니다. 설치 때 출력된 bootstrap 토큰이 필요하고, 이미 소유자가 있으면 만들어지지 않습니다.",
  "bootstrap.token": "Bootstrap 토큰",
  "bootstrap.email": "소유자 이메일",
  "bootstrap.displayName": "이름",
  "bootstrap.password": "비밀번호",
  "bootstrap.passwordHint": "{min}자 이상",
  "bootstrap.workspaceName": "워크스페이스 이름",
  "bootstrap.workspaceSlug": "워크스페이스 식별자 (slug)",
  "bootstrap.workspaceSlugHint":
    "워크스페이스를 서로 구분하는 이름이라 다른 워크스페이스와 겹칠 수 없고, 나중에 바꿀 수 없습니다. 영문 소문자, 숫자, 하이픈(-)",
  "bootstrap.submit": "소유자 만들기",
  "bootstrap.submitting": "만드는 중…",
  "bootstrap.tokenInvalid":
    "Bootstrap 토큰이 맞지 않습니다 — 설치 때 출력된 값을 그대로 넣으세요.",
  "bootstrap.loginLink": "이미 소유자가 있다면 로그인",
  "bootstrap.ownerExistsLogin": "로그인하기",

  "invite.title": "초대 수락",
  "invite.intro":
    "초대를 수락하면 워크스페이스에 들어갑니다. 이 이메일로 이미 계정이 있으면 그 비밀번호를, 처음이면 새로 쓸 비밀번호를 넣으세요.",
  "invite.password": "비밀번호",
  "invite.passwordHint": "{min}자 이상. 기존 계정이면 지금 쓰는 비밀번호",
  "invite.displayName": "이름",
  "invite.displayNameHint":
    "처음 가입할 때만 씁니다. 비우면 이메일 앞부분을 씁니다",
  "invite.submit": "초대 수락",
  "invite.submitting": "수락하는 중…",
  "invite.wrongPassword":
    "비밀번호가 맞지 않습니다. 이 이메일로 이미 계정이 있으면 그 계정의 비밀번호를 넣으세요. Google로만 로그인해 온 계정은 비밀번호가 없어 여기서 수락할 수 없습니다 — 소유자나 관리자에게 다시 활성화해 달라고 요청하세요.",
  "invite.expired.title": "쓸 수 없는 초대입니다",
  "invite.expired.body":
    "만료됐거나 회수된 초대입니다. 초대한 사람에게 새 링크를 요청하세요.",
  "invite.used.title": "이미 수락한 초대입니다",
  "invite.used.body":
    "이 초대는 이미 쓰였습니다. 수락한 계정으로 로그인하세요.",
  "invite.used.login": "로그인 화면으로",
  "invite.member.title": "이미 이 워크스페이스의 구성원입니다",
  "invite.member.body":
    "{email} 계정으로 {workspace}에 로그인되어 있어 초대를 수락할 필요가 없습니다.",
  "invite.member.home": "워크스페이스로 가기",
  "invite.member.switch": "로그아웃하고 다른 계정으로 수락",
  "invite.steps": "초대 수락 단계",
  "invite.step.account": "계정 확인",
  "invite.step.password": "비밀번호 입력",
  "invite.account.question": "초대받은 이메일로 쓰는 계정이 있나요?",
  "invite.account.existing": "네, 계정이 있습니다",
  "invite.account.new": "아니요, 처음입니다",
  "invite.passwordTitle.existing": "기존 계정으로 수락",
  "invite.passwordTitle.new": "새 계정으로 수락",
  "invite.back": "이전",
  "invite.invalid.title": "초대 링크가 올바르지 않습니다",
  "invite.invalid.body":
    "링크가 잘렸거나 바뀐 것 같습니다. 받은 링크 전체를 그대로 다시 여세요.",
};

export const authEn: Record<keyof typeof authKo, string> = {
  "login.title": "Log in",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Log in",
  "login.submitting": "Logging in…",
  "login.bootstrapPrompt":
    "The first owner is created once, with the bootstrap token printed during installation.",
  "login.bootstrapLink": "Create the first owner",
  "login.notice.bootstrapDone":
    "An owner already exists. Log in with that account.",
  "login.notice.loggedOut": "You are logged out.",
  "login.notice.created":
    "The owner is ready. Log in with the password you just set.",

  "login.or": "or",
  "login.alternatives": "Other ways to log in",
  "login.provider.submit": "Sign in with {name}",
  "login.provider.starting": "Going to the sign-in page…",
  "login.provider.title": "SSO login",
  "login.provider.rejected":
    "Could not log in with this account — make sure it uses the email address you were invited with, then try again.",
  "login.provider.forbidden":
    "This account cannot log in here — use an account from a domain this workspace allows.",
  "login.provider.cancelled": "The login was not completed — try again.",
  "login.provider.backToLogin": "Back to log in",
  "login.provider.unavailable":
    "This way to log in is not available right now — pick another one on the login page.",

  "bootstrap.title": "Create the first owner",
  "bootstrap.intro":
    "Use this screen when you first set up this installation, to create the first owner and the workspace. You need the bootstrap token printed during installation. If an owner already exists, nothing is created.",
  "bootstrap.token": "Bootstrap token",
  "bootstrap.email": "Owner email",
  "bootstrap.displayName": "Name",
  "bootstrap.password": "Password",
  "bootstrap.passwordHint": "At least {min} characters",
  "bootstrap.workspaceName": "Workspace name",
  "bootstrap.workspaceSlug": "Workspace identifier (slug)",
  "bootstrap.workspaceSlugHint":
    "Tells workspaces apart, so no other workspace can use it, and it cannot be changed later. Lowercase letters, digits and hyphens (-)",
  "bootstrap.submit": "Create owner",
  "bootstrap.submitting": "Creating…",
  "bootstrap.tokenInvalid":
    "The bootstrap token is wrong — paste the value printed at install.",
  "bootstrap.loginLink": "Already have an owner? Log in",
  "bootstrap.ownerExistsLogin": "Log in",

  "invite.title": "Accept invite",
  "invite.intro":
    "Accepting adds you to the workspace. If this email already has an account, enter its password; otherwise choose a new one.",
  "invite.password": "Password",
  "invite.passwordHint":
    "At least {min} characters. Your current password if you already have an account",
  "invite.displayName": "Name",
  "invite.displayNameHint":
    "Only used for a new account. If left empty, the part of the email before @ is used",
  "invite.submit": "Accept invite",
  "invite.submitting": "Accepting…",
  "invite.wrongPassword":
    "The password does not match. If this email already has an account, enter that account's password. An account that only signs in with Google has no password and cannot accept here — ask an owner or admin to re-enable it.",
  "invite.expired.title": "This invite cannot be used",
  "invite.expired.body":
    "It expired or was revoked. Ask whoever invited you for a new link.",
  "invite.used.title": "This invite was already accepted",
  "invite.used.body":
    "It has already been used. Log in with the account that accepted it.",
  "invite.used.login": "Log in",
  "invite.member.title": "You are already a member of this workspace",
  "invite.member.body":
    "You are logged in to {workspace} as {email}, so there is nothing to accept.",
  "invite.member.home": "Go to the workspace",
  "invite.member.switch": "Log out and accept with another account",
  "invite.steps": "Invite steps",
  "invite.step.account": "Account",
  "invite.step.password": "Password",
  "invite.account.question":
    "Do you already have an account with the invited email?",
  "invite.account.existing": "Yes, I have an account",
  "invite.passwordTitle.existing": "Accept with your account",
  "invite.passwordTitle.new": "Accept with a new account",
  "invite.account.new": "No, I am new here",
  "invite.back": "Back",
  "invite.invalid.title": "This invite link is not valid",
  "invite.invalid.body":
    "It looks cut short or changed. Open the full link you received again.",
};

export const authJa: Record<keyof typeof authKo, string> = {
  "login.title": "ログイン",
  "login.email": "メールアドレス",
  "login.password": "パスワード",
  "login.submit": "ログイン",
  "login.submitting": "ログイン中…",
  "login.bootstrapPrompt":
    "最初のオーナーは、インストール時に出力された bootstrap トークンで一度だけ作成できます。",
  "login.bootstrapLink": "最初のオーナーを作成",
  "login.notice.bootstrapDone":
    "オーナーはすでに存在します。そのアカウントでログインしてください。",
  "login.notice.loggedOut": "ログアウトしました。",
  "login.notice.created":
    "オーナーを作成しました。設定したパスワードでログインしてください。",

  "login.or": "または",
  "login.alternatives": "その他のログイン方法",
  "login.provider.submit": "{name} でログイン",
  "login.provider.starting": "ログインページに移動しています…",
  "login.provider.title": "SSO ログイン",
  "login.provider.rejected":
    "このアカウントでログインできませんでした。招待されたメールアドレスのアカウントか確認して、もう一度お試しください。",
  "login.provider.forbidden":
    "このアカウントではログインできません。ワークスペースで許可されたドメインのアカウントを使ってください。",
  "login.provider.cancelled":
    "ログインが完了しませんでした。もう一度お試しください。",
  "login.provider.backToLogin": "ログイン画面へ",
  "login.provider.unavailable":
    "このログイン方法は現在利用できません。ログイン画面で別の方法を選んでください。",

  "bootstrap.title": "最初のオーナーを作成",
  "bootstrap.intro":
    "このインストールの初期設定で、最初のオーナーとワークスペースを作成する画面です。インストール時に出力された bootstrap トークンが必要です。オーナーがすでに存在する場合は作成されません。",
  "bootstrap.token": "bootstrap トークン",
  "bootstrap.email": "オーナーのメールアドレス",
  "bootstrap.displayName": "名前",
  "bootstrap.password": "パスワード",
  "bootstrap.passwordHint": "{min}文字以上",
  "bootstrap.workspaceName": "ワークスペース名",
  "bootstrap.workspaceSlug": "ワークスペース識別子（slug）",
  "bootstrap.workspaceSlugHint":
    "ワークスペースを区別する名前のため、ほかのワークスペースと重複できず、あとから変更できません。英小文字・数字・ハイフン（-）",
  "bootstrap.submit": "オーナーを作成",
  "bootstrap.submitting": "作成中…",
  "bootstrap.tokenInvalid":
    "bootstrap トークンが正しくありません。インストール時に出力された値をそのまま入力してください。",
  "bootstrap.loginLink": "オーナーがすでにいる場合はログイン",
  "bootstrap.ownerExistsLogin": "ログイン",

  "invite.title": "招待を承諾",
  "invite.intro":
    "招待を承諾すると、ワークスペースに参加します。このメールアドレスのアカウントがすでにある場合はそのパスワードを、初めての場合は新しいパスワードを入力してください。",
  "invite.password": "パスワード",
  "invite.passwordHint":
    "{min}文字以上。既存のアカウントの場合は現在のパスワード",
  "invite.displayName": "名前",
  "invite.displayNameHint":
    "新規登録時のみ使います。空欄の場合はメールアドレスの @ より前の部分を使います",
  "invite.submit": "招待を承諾",
  "invite.submitting": "承諾中…",
  "invite.wrongPassword":
    "パスワードが一致しません。このメールアドレスのアカウントがすでにある場合は、そのアカウントのパスワードを入力してください。Google ログインのみで利用してきたアカウントにはパスワードがないため、ここでは承諾できません。オーナーまたは管理者に再有効化を依頼してください。",
  "invite.expired.title": "この招待は使用できません",
  "invite.expired.body":
    "期限切れか、取り消された招待です。招待した人に新しいリンクを依頼してください。",
  "invite.used.title": "この招待は承諾済みです",
  "invite.used.body":
    "この招待はすでに使用されています。承諾したアカウントでログインしてください。",
  "invite.used.login": "ログイン画面へ",
  "invite.member.title": "すでにこのワークスペースのメンバーです",
  "invite.member.body":
    "{email} で {workspace} にログインしているため、招待を承諾する必要はありません。",
  "invite.member.home": "ワークスペースへ移動",
  "invite.member.switch": "ログアウトして別のアカウントで承諾",
  "invite.steps": "招待承諾のステップ",
  "invite.step.account": "アカウント確認",
  "invite.step.password": "パスワード",
  "invite.account.question":
    "招待されたメールアドレスのアカウントをお持ちですか？",
  "invite.account.existing": "はい、アカウントがあります",
  "invite.account.new": "いいえ、初めてです",
  "invite.passwordTitle.existing": "既存のアカウントで承諾",
  "invite.passwordTitle.new": "新しいアカウントで承諾",
  "invite.back": "戻る",
  "invite.invalid.title": "招待リンクが正しくありません",
  "invite.invalid.body":
    "リンクが途中で切れているか、変更されているようです。受け取ったリンク全体をもう一度開いてください。",
};
