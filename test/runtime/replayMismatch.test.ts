import { expect } from "vitest"

import { FileJournalStore, Runtime, step } from "../../src/index.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

test("rejects replay when a completed step has a different name", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const originalWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "original-step",
            input: null,
            run: async () => "original output"
        })
        throw new Error("Fail after the completed step")
    })

    await new Runtime({ journalStore }).start(originalWorkflow, { runId: "run-123", input: null }).waitForOutcome()

    let changedStepExecuted = false
    const changedWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "changed-step",
            input: null,
            run: async () => {
                changedStepExecuted = true
                return "changed output"
            }
        })
    })

    const outcome = await new Runtime({ journalStore }).resume(changedWorkflow, { runId: "run-123" }).waitForOutcome()

    expect(outcome).toMatchObject({
        status: "failed",
        error: {
            message: expect.stringContaining('was previously recorded as "original-step", not "changed-step"')
        }
    })
    expect(changedStepExecuted).toBe(false)
})

test("replays a completed step when its input changes but its name does not", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const originalWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "same-step",
            input: { version: 1 },
            run: async () => "persisted output"
        })
        throw new Error("Fail after the completed step")
    })

    await new Runtime({ journalStore }).start(originalWorkflow, { runId: "run-123", input: null }).waitForOutcome()

    let changedStepExecuted = false
    let replayedOutput: string | undefined
    const changedWorkflow = defineInputlessWorkflow(async () => {
        replayedOutput = await step({
            name: "same-step",
            input: { version: 2 },
            run: async () => {
                changedStepExecuted = true
                return "changed output"
            }
        })
    })

    const outcome = await new Runtime({ journalStore }).resume(changedWorkflow, { runId: "run-123" }).waitForOutcome()

    expect(outcome).toEqual({ status: "completed" })
    expect(replayedOutput).toBe("persisted output")
    expect(changedStepExecuted).toBe(false)
})
