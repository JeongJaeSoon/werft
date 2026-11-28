import { deserialize } from "node:v8";
import { gateSkillVersion, type SkillGateInput } from "@werft-ai/platform";

// One gate run per process (see skill-gate.ts beside this file): the input
// comes in on stdin, the result goes out as JSON on stdout.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = deserialize(Buffer.concat(chunks)) as SkillGateInput;
process.stdout.write(JSON.stringify(gateSkillVersion(input)));
