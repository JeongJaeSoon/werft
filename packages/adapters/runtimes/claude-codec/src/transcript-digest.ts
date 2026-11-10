// The rule itself lives in runtime-codec-kit, where every engine's mirror and
// codec share it; this keeps the name Claude's callers import.
export { digestParts } from "@werft-ai/runtime-codec-kit";
