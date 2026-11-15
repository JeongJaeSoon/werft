import { Avatar, avatarInitials, avatarTone } from "@werft-ai/ui";

/** The design's square initials mark, one colour per name. */
export function AgentAvatar({
  name,
  size = "lg",
}: {
  readonly name: string;
  readonly size?: "lg" | "two-line";
}) {
  return (
    <Avatar
      size={size}
      shape="square"
      tone={avatarTone(name)}
      initials={avatarInitials(name)}
    />
  );
}
