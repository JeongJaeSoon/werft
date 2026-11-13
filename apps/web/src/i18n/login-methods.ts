/**
 * Settings > Sign-in methods: the ways the signed-in person signs in, and
 * what the callback says when a link to a provider account is refused.
 */
export const loginMethodsKo = {
  "loginMethods.title": "로그인 수단",
  "loginMethods.description":
    "이 계정으로 로그인하는 방법입니다. 연결하거나 끊으려면 로그인한 지 10분 안이어야 합니다.",
  "loginMethods.stale":
    "로그인한 지 10분이 지나 지금은 바꿀 수 없습니다. 로그아웃하고 다시 로그인한 뒤 바꾸세요.",
  "loginMethods.section.mine": "쓰고 있는 수단",
  "loginMethods.section.linkable": "연결할 수 있는 공급자",
  "loginMethods.section.linkableHint":
    "공급자에서 로그인하고 나면 이 화면으로 돌아옵니다. 어느 계정을 연결할지는 공급자에서 로그인한 계정으로 정해지고, 이메일 주소가 이 계정과 달라도 됩니다.",
  "loginMethods.password": "비밀번호",
  "loginMethods.providerGone": "삭제된 공급자",
  "loginMethods.off": "지금은 쓸 수 없음",
  "loginMethods.lastLogin": "마지막 로그인",
  "loginMethods.neverUsed": "로그인한 적 없음",
  "loginMethods.linkable.none": "연결할 수 있는 공급자가 없습니다.",
  "loginMethods.link": "연결",
  "loginMethods.linkNamed": "{name} 연결",
  "loginMethods.unlink": "끊기",
  "loginMethods.unlinkNamed": "{name} 끊기",
  "loginMethods.reason.stale":
    "로그인한 지 10분이 지났습니다. 다시 로그인한 뒤 바꾸세요.",
  "loginMethods.reason.last":
    "쓸 수 있는 로그인 수단이 이것뿐이라 끊을 수 없습니다.",
  "loginMethods.unlinkTitle": "{name} 로그인을 끊을까요?",
  "loginMethods.unlinkConsequence":
    "이 공급자 계정으로는 더 로그인할 수 없습니다. 이 수단으로 로그인한 세션은 모두 로그아웃되고, 지금 세션이 그중 하나면 함께 로그아웃됩니다. 나중에 다시 연결할 수 있습니다.",
  "loginMethods.unlinkConsequence.password":
    "비밀번호가 지워지고, 다시 정할 수 없습니다. 비밀번호로 로그인한 세션은 모두 로그아웃되고, 지금 세션이 그중 하나면 함께 로그아웃됩니다.",
  "loginMethods.done.unlinked":
    "끊었습니다. 세션 {count}개가 로그아웃됐습니다.",
  "loginMethods.done.linked":
    "연결했습니다. 이제 이 공급자 계정으로 로그인할 수 있습니다.",
  "loginMethods.error.gone": "이미 없는 로그인 수단입니다.",
  "loginMethods.error.providerOff": "이 공급자는 지금 쓸 수 없습니다.",
  "loginMethods.callback.taken":
    "이 공급자 계정은 이미 다른 사용자에게 연결돼 있습니다.",
  "loginMethods.callback.issuer":
    "이 공급자의 다른 계정이 이미 내 계정에 연결돼 있습니다. 먼저 그 연결을 끊으세요.",
  "loginMethods.callback.back": "로그인 수단으로 돌아가기",
} as const;

export const loginMethodsEn: Record<keyof typeof loginMethodsKo, string> = {
  "loginMethods.title": "Sign-in methods",
  "loginMethods.description":
    "The ways you sign in to this account. To connect or remove one, you must have signed in within the last 10 minutes.",
  "loginMethods.stale":
    "You signed in more than 10 minutes ago, so nothing can be changed now. Log out, sign in again, then make the change.",
  "loginMethods.section.mine": "In use",
  "loginMethods.section.linkable": "Providers you can connect",
  "loginMethods.section.linkableHint":
    "You sign in at the provider and come back to this page. The account you sign in with there is the one connected; its email address may differ from this account's.",
  "loginMethods.password": "Password",
  "loginMethods.providerGone": "Deleted provider",
  "loginMethods.off": "Cannot be used now",
  "loginMethods.lastLogin": "Last sign-in",
  "loginMethods.neverUsed": "Never signed in",
  "loginMethods.linkable.none": "There is no provider to connect.",
  "loginMethods.link": "Connect",
  "loginMethods.linkNamed": "Connect {name}",
  "loginMethods.unlink": "Remove",
  "loginMethods.unlinkNamed": "Remove {name}",
  "loginMethods.reason.stale":
    "You signed in more than 10 minutes ago. Sign in again, then make the change.",
  "loginMethods.reason.last":
    "This is the only way you can sign in, so it cannot be removed.",
  "loginMethods.unlinkTitle": "Remove sign-in with {name}?",
  "loginMethods.unlinkConsequence":
    "You can no longer sign in with this provider account. Every session signed in this way is logged out, this one included if it is one of them. You can connect it again later.",
  "loginMethods.unlinkConsequence.password":
    "Your password is erased and cannot be set again. Every session signed in with the password is logged out, this one included if it is one of them.",
  "loginMethods.done.unlinked": "Removed. {count} sessions were logged out.",
  "loginMethods.done.linked":
    "Connected. You can now sign in with this provider account.",
  "loginMethods.error.gone": "That sign-in method no longer exists.",
  "loginMethods.error.providerOff": "This provider cannot be used right now.",
  "loginMethods.callback.taken":
    "This provider account is already connected to another user.",
  "loginMethods.callback.issuer":
    "Another account of this provider is already connected to you. Remove that connection first.",
  "loginMethods.callback.back": "Back to sign-in methods",
};

export const loginMethodsJa: Record<keyof typeof loginMethodsKo, string> = {
  "loginMethods.title": "ログイン方法",
  "loginMethods.description":
    "このアカウントにログインする方法です。接続または解除するには、ログインしてから 10 分以内である必要があります。",
  "loginMethods.stale":
    "ログインしてから 10 分が過ぎたため、今は変更できません。ログアウトしてもう一度ログインしてから変更してください。",
  "loginMethods.section.mine": "使用中の方法",
  "loginMethods.section.linkable": "接続できるプロバイダー",
  "loginMethods.section.linkableHint":
    "プロバイダーでログインすると、この画面に戻ります。接続されるのはプロバイダーでログインしたアカウントで、メールアドレスがこのアカウントと異なっていてもかまいません。",
  "loginMethods.password": "パスワード",
  "loginMethods.providerGone": "削除されたプロバイダー",
  "loginMethods.off": "今は使用できません",
  "loginMethods.lastLogin": "最終ログイン",
  "loginMethods.neverUsed": "ログイン履歴なし",
  "loginMethods.linkable.none": "接続できるプロバイダーはありません。",
  "loginMethods.link": "接続",
  "loginMethods.linkNamed": "{name} を接続",
  "loginMethods.unlink": "解除",
  "loginMethods.unlinkNamed": "{name} を解除",
  "loginMethods.reason.stale":
    "ログインしてから 10 分が過ぎました。もう一度ログインしてから変更してください。",
  "loginMethods.reason.last":
    "使用できるログイン方法がこれだけのため、解除できません。",
  "loginMethods.unlinkTitle": "{name} でのログインを解除しますか？",
  "loginMethods.unlinkConsequence":
    "このプロバイダーのアカウントではログインできなくなります。この方法でログインしたセッションはすべてログアウトされ、現在のセッションがその一つであれば一緒にログアウトされます。あとでもう一度接続できます。",
  "loginMethods.unlinkConsequence.password":
    "パスワードは消去され、設定し直すことはできません。パスワードでログインしたセッションはすべてログアウトされ、現在のセッションがその一つであれば一緒にログアウトされます。",
  "loginMethods.done.unlinked":
    "解除しました。セッションを {count} 件ログアウトしました。",
  "loginMethods.done.linked":
    "接続しました。今後はこのプロバイダーのアカウントでログインできます。",
  "loginMethods.error.gone": "このログイン方法はすでにありません。",
  "loginMethods.error.providerOff": "このプロバイダーは今は使用できません。",
  "loginMethods.callback.taken":
    "このプロバイダーのアカウントは、すでに別のユーザーに接続されています。",
  "loginMethods.callback.issuer":
    "このプロバイダーの別のアカウントが、すでに自分のアカウントに接続されています。先にその接続を解除してください。",
  "loginMethods.callback.back": "ログイン方法に戻る",
};
