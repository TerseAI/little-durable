import { setTimeout as delay } from "node:timers/promises"
import { expect } from "vitest"
import { z } from "zod"

import { FileJournalStore, Runtime, defineHook, step, waitFor } from "../../src/index.js"
import { test } from "../fixtures/filesystem.js"
import { waitForRuntimeOutcome } from "../fixtures/runtime.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

test("streams step lifecycle events and a terminal completion event", async ({ journalDirectory }) => {
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "create-greeting",
            input: {
                person: "Ada"
            },
            run: async ({ person }) => {
                await delay(5)
                return `Hello, ${person}`
            }
        })
    })
    const events = []
    const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })

    for await (const event of runtime.start(workflow, {
        runId: "run-123",
        input: null
    })) {
        events.push(event)
    }

    expect(events.map(event => event.type)).toEqual(["runtime.started", "step.started", "step.completed", "runtime.completed"])

    const [runtimeStartedEvent, stepStartedEvent, stepCompletedEvent, runtimeCompletedEvent] = events
    if (runtimeStartedEvent?.type !== "runtime.started") throw new Error("Expected runtime.started")
    if (stepStartedEvent?.type !== "step.started") throw new Error("Expected step.started")
    if (stepCompletedEvent?.type !== "step.completed") throw new Error("Expected step.completed")
    if (runtimeCompletedEvent?.type !== "runtime.completed") throw new Error("Expected runtime.completed")

    expect(runtimeStartedEvent).toMatchObject({
        type: "runtime.started",
        runId: "run-123",
        workflowName: "test-workflow",
        startedAt: expect.any(String)
    })
    expect(stepStartedEvent).toMatchObject({
        type: "step.started",
        runId: "run-123",
        name: "create-greeting",
        startedAt: expect.any(String)
    })
    expect(stepCompletedEvent).toMatchObject({
        type: "step.completed",
        runId: "run-123",
        stepId: stepStartedEvent.stepId,
        name: "create-greeting",
        completedAt: expect.any(String),
        durationMs: expect.any(Number)
    })
    expect(stepCompletedEvent.durationMs).toBeGreaterThan(0)
    expect(runtimeCompletedEvent).toMatchObject({
        type: "runtime.completed",
        runId: "run-123",
        completedAt: expect.any(String),
        durationMs: expect.any(Number)
    })
})

test("streams the resumed execution through completion", async ({ journalDirectory }) => {
    const ApprovalHook = defineHook({
        name: "approval",
        request: z.object({ message: z.string() }).strict(),
        resolution: z.object({ approved: z.boolean() }).strict()
    })
    const workflow = defineInputlessWorkflow(async () => {
        await waitFor(ApprovalHook, { message: "Ship it?" })
        await step({
            name: "record-approval",
            input: null,
            run: async () => null
        })
    })
    const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
    const firstOutcome = await waitForRuntimeOutcome(
        runtime.start(workflow, {
            runId: "run-123",
            input: null
        })
    )

    if (firstOutcome.status !== "suspended") throw new Error("Expected the workflow to suspend")

    const events = []
    for await (const event of runtime.resumeHook(ApprovalHook, {
        runId: "run-123",
        workflow,
        waitId: firstOutcome.suspension.waitId,
        resolution: { approved: true }
    })) {
        events.push(event)
    }

    expect(events.map(event => event.type)).toEqual(["runtime.resumed", "step.started", "step.completed", "runtime.completed"])
    expect(events[0]).toMatchObject({
        type: "runtime.resumed",
        runId: "run-123",
        workflowName: "test-workflow",
        resumedAt: expect.any(String)
    })
})
