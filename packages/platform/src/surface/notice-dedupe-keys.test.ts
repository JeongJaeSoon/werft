import { expect, test } from "bun:test";
import {
  actionNoticeDedupeKey,
  intentNoticeDedupeKey,
} from "./action-notice.ts";
import { modelCutDedupeKey } from "./model-cut-notice.ts";
import { sessionModelMoveDedupeKey } from "./model-move-notice.ts";
import { runtimeRetiredDedupeKey } from "./runtime-retired-notice.ts";
import { workerImageReplacedDedupeKey } from "./worker-image-replaced-notice.ts";

// Outbox rows already written carry these keys; a new spelling would tell
// every thread a second time. The start pass that moves a person's DM into
// its session's thread writes the same keys (moveModelNoticesOffPeople).
test("every notice keeps the dedupe key its outbox rows were written with", () => {
  expect([
    actionNoticeDedupeKey("p-1", "opened"),
    actionNoticeDedupeKey("p-1", "pushed"),
    intentNoticeDedupeKey("i-1"),
    modelCutDedupeKey("w-1", "s-1", "l-1"),
    sessionModelMoveDedupeKey("w-1", "s-1", "m-old", "m-new", "l-1"),
    runtimeRetiredDedupeKey("w-1", "s-1", 7, "l-1"),
    workerImageReplacedDedupeKey("w-1", "s-1", 2, "l-1"),
  ]).toEqual([
    "action:p-1:opened",
    "action:p-1:pushed",
    "intent:i-1:ended",
    "model-not-allowed:w-1:s-1:l-1",
    "session-model-move:w-1:s-1:m-old:m-new:l-1",
    "runtime-retired:w-1:s-1:7:l-1",
    "worker-image-replaced:w-1:s-1:2:l-1",
  ]);
});
