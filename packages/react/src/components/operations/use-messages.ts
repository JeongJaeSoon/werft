import { useWerft } from "../../provider.tsx";
import {
  OPERATIONS_MESSAGES,
  type OperationsFormat,
  type OperationsMessages,
  type UnknownPriceMessages,
} from "./messages.ts";

type Part = Exclude<keyof OperationsMessages, "format">;

/** The provider locale's wording for one part, with the host's replacements. */
export function useOperationsMessages<P extends Part>(
  part: P,
  override: Partial<OperationsMessages[P]> | undefined,
): {
  readonly messages: OperationsMessages[P];
  readonly format: OperationsFormat;
  readonly unknownPrice: UnknownPriceMessages;
} {
  const { locale } = useWerft();
  const defaults = OPERATIONS_MESSAGES[locale];
  return {
    messages: { ...defaults[part], ...override },
    format: defaults.format,
    unknownPrice: defaults.unknownPrice,
  };
}
