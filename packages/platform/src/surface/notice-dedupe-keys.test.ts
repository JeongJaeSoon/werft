import { expect, test } from "bun:test";
import {
  actionNoticeDedupeKey,
  intentNoticeDedupeKey,
} from "./action-notice.ts";
import { budgetRefusalTurnDedupeKey } from "./budget-refusal-notice.ts";
import {
  modelCutDedupeKey,
  modelCutDedupeKeyWithoutInstallation,
} from "./model-cut-notice.ts";
import {
  modelMoveDedupeKey,
  modelMoveDedupeKeyWithoutInstallation,
  sessionModelMoveDedupeKey,
} from "./model-move-notice.ts";
import { runtimeRetiredDedupeKey } from "./runtime-retired-notice.ts";
import { workerImageReplacedDedupeKey } from "./worker-image-replaced-notice.ts";

// Outbox rows already written carry these keys; a new spelling would tell
// every account a second time.
test("every notice keeps the dedupe key its outbox rows were written with", () => {
  expect([
    actionNoticeDedupeKey("p-1", "opened"),
    intentNoticeDedupeKey("i-1"),
    modelCutDedupeKey("w-1", "s-1", "inst-1", "U1"),
    modelCutDedupeKeyWithoutInstallation("w-1", "s-1", "U1"),
    modelMoveDedupeKey("moved", "a-1", "m-old", "m-new", "inst-1", "U1", 3),
    modelMoveDedupeKeyWithoutInstallation(
      "failed",
      "a-1",
      "m-old",
      "m-new",
      "U1",
      3,
    ),
    sessionModelMoveDedupeKey("w-1", "s-1", "m-old", "m-new", "inst-1", "U1"),
    runtimeRetiredDedupeKey("w-1", "s-1", 7, "inst-1", "U1"),
    workerImageReplacedDedupeKey("w-1", "s-1", 2, "inst-1", "U1"),
    budgetRefusalTurnDedupeKey("l-1", 3),
  ]).toEqual([
    "action:p-1:opened",
    "intent:i-1:ended",
    "model-not-allowed:w-1:s-1:inst-1:U1",
    "model-not-allowed:w-1:s-1:U1",
    "model-move:moved:a-1:m-old:m-new:3:inst-1:U1",
    "model-move:failed:a-1:m-old:m-new:3:U1",
    "session-model-move:w-1:s-1:m-old:m-new:inst-1:U1",
    "runtime-retired:w-1:s-1:7:inst-1:U1",
    "worker-image-replaced:w-1:s-1:2:inst-1:U1",
    "failure:l-1:3",
  ]);
});
