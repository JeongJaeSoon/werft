import { describe, expect, test } from "bun:test";
import { GitHubCallError } from "../github/ports/github-gate.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `WorkflowRunnable` promises: a dispatch names the run it
 * started, and the run reads back by id; a rerun is asked for the whole run
 * or its failed jobs. A failed call throws `GitHubCallError` with the status,
 * and is sent once: a dispatch the forge took and answered 5xx would run
 * twice.
 */
export function describeWorkflowRunnableContract(make: MakeForgeSubject) {
  describe("WorkflowRunnable", () => {
    test("dispatches a workflow on a branch and reads the run it started", async () => {
      const { api, newBranch } = await make();
      const branch = await newBranch();
      const started = await api.dispatchWorkflow({
        workflow: "ci.yml",
        ref: branch,
        inputs: { reason: "check" },
      });
      expect(started).not.toBeNull();
      const run = await api.getWorkflowRun(started?.id ?? 0);
      expect(run).toMatchObject({
        id: started?.id,
        path: ".github/workflows/ci.yml",
        head_branch: branch,
        html_url: started?.html_url,
      });
    });

    test("asks for a rerun of the whole run or of its failed jobs", async () => {
      const { api, newBranch, workflowRunsOnForge } = await make();
      const started = await api.dispatchWorkflow({
        workflow: "ci.yml",
        ref: await newBranch(),
        inputs: {},
      });
      await api.rerunWorkflow(started?.id ?? 0, false);
      await api.rerunWorkflow(started?.id ?? 0, true);
      expect(workflowRunsOnForge()).toEqual([
        {
          id: started?.id ?? 0,
          reruns: [{ failedOnly: false }, { failedOnly: true }],
        },
      ]);
    });

    test("a run the forge does not have throws GitHubCallError with its status", async () => {
      const { api } = await make();
      const missing = await api
        .getWorkflowRun(1)
        .catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(GitHubCallError);
      expect(missing).toMatchObject({ status: 404 });
    });

    test("a refused dispatch or rerun throws GitHubCallError and is sent once", async () => {
      const subject = await make();
      const branch = await subject.newBranch();
      const before = subject.requestCount();
      subject.failNext(502, 10);
      const dispatch = await subject.api
        .dispatchWorkflow({ workflow: "ci.yml", ref: branch, inputs: {} })
        .catch((error: unknown) => error);
      expect(dispatch).toBeInstanceOf(GitHubCallError);
      expect(dispatch).toMatchObject({ status: 502 });
      expect(subject.requestCount() - before).toBe(1);
      expect(subject.workflowRunsOnForge()).toEqual([]);
      const rerun = await make();
      rerun.failNext(502, 10);
      const rerunBefore = rerun.requestCount();
      expect(
        await rerun.api
          .rerunWorkflow(1, false)
          .catch((error: unknown) => error),
      ).toBeInstanceOf(GitHubCallError);
      expect(rerun.requestCount() - rerunBefore).toBe(1);
    });
  });
}
