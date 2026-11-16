/**
 * What the provider callback says when a provider account is already
 * someone's: an invite's sign-up, or a link started through the API.
 */
export const loginMethodsKo = {
  "loginMethods.callback.taken":
    "이 공급자 계정은 이미 다른 사용자에게 연결돼 있습니다.",
  "loginMethods.callback.issuer":
    "이 공급자의 다른 계정이 이미 내 계정에 연결돼 있습니다. 먼저 그 연결을 끊으세요.",
} as const;

export const loginMethodsEn: Record<keyof typeof loginMethodsKo, string> = {
  "loginMethods.callback.taken":
    "This provider account is already connected to another user.",
  "loginMethods.callback.issuer":
    "Another account of this provider is already connected to you. Remove that connection first.",
};

export const loginMethodsJa: Record<keyof typeof loginMethodsKo, string> = {
  "loginMethods.callback.taken":
    "このプロバイダーのアカウントは、すでに別のユーザーに接続されています。",
  "loginMethods.callback.issuer":
    "このプロバイダーの別のアカウントが、すでに自分のアカウントに接続されています。先にその接続を解除してください。",
};
