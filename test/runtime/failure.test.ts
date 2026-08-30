import { setTimeout as delay } from "node:timers/promises"
import { expect } from "vitest"

import { FileJournalStore, Runtime } from "../../src/index.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

test("a failed run can be resumed through completion", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    let executions = 0
    const workflow = defineInputlessWorkflow(async () => {
        executions++
        if (executions === 1) throw new Error("Try again")
    })

    const failedOutcome = await new Runtime({ journalStore })
        .start(workflow, {
            runId: "run-123",
            input: null
        })
        .waitForOutcome()

    expect(failedOutcome).toEqual({
        status: "failed",
        error: {
            name: "Error",
            message: "Try again"
        }
    })
    expect(await journalStore.listByType({ runId: "run-123", eventType: "run.completed" })).toEqual([])

    const completedOutcome = await new Runtime({ journalStore }).resume(workflow, { runId: "run-123" }).waitForOutcome()

    expect(completedOutcome).toEqual({ status: "completed" })
    expect(executions).toBe(2)
    expect(await journalStore.listByType({ runId: "run-123", eventType: "run.completed" })).toHaveLength(1)
})

test("a run remains resumable after repeated failures", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    let executions = 0
    const workflow = defineInputlessWorkflow(async () => {
        executions++
        throw new Error(`Failure ${executions}`)
    })

    const firstOutcome = await new Runtime({ journalStore })
        .start(workflow, {
            runId: "run-123",
            input: null
        })
        .waitForOutcome()
    const secondOutcome = await new Runtime({ journalStore }).resume(workflow, { runId: "run-123" }).waitForOutcome()

    expect(firstOutcome).toMatchObject({
        status: "failed",
        error: { message: "Failure 1" }
    })
    expect(secondOutcome).toMatchObject({
        status: "failed",
        error: { message: "Failure 2" }
    })
    expect(executions).toBe(2)
    expect(await journalStore.listByType({ runId: "run-123", eventType: "run.completed" })).toEqual([])
})

test("normalizes a non-Error value thrown by a workflow", async ({ journalDirectory }) => {
    const outcome = await new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
        .start(
            defineInputlessWorkflow(async () => {
                throw "Workflow failed"
            }),
            {
                runId: "run-123",
                input: null
            }
        )
        .waitForOutcome()

    expect(outcome).toEqual({
        status: "failed",
        error: {
            name: "Error",
            message: "Workflow failed"
        }
    })
})

test("calculates failure duration from the persisted run start after restarting", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const workflow = defineInputlessWorkflow(async () => {
        throw new Error("Workflow failed")
    })

    await new Runtime({ journalStore })
        .start(workflow, {
            runId: "run-123",
            input: null
        })
        .waitForOutcome()

    await delay(5)

    const events = []
    for await (const event of new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).resume(workflow, { runId: "run-123" })) {
        events.push(event)
    }

    expect(events.map(event => event.type)).toEqual(["runtime.resumed", "runtime.failed"])
    expect(events.at(-1)).toMatchObject({
        type: "runtime.failed",
        runId: "run-123",
        failedAt: expect.any(String),
        durationMs: expect.any(Number),
        error: {
            name: "Error",
            message: "Workflow failed"
        }
    })

    const failedEvent = events.at(-1)
    if (failedEvent?.type !== "runtime.failed") throw new Error("Expected runtime.failed")
    expect(failedEvent.durationMs).toBeGreaterThan(0)
})
