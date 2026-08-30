import { expect } from "vitest"

import { FileJournalStore, Runtime, step } from "../../src/index.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

test("rewinds a failed step before replaying the workflow", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const failingWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "broken-step",
            input: null,
            run: async () => {
                throw new Error("Broken")
            }
        })
    })

    await new Runtime({ journalStore })
        .start(failingWorkflow, {
            runId: "run-123",
            input: null
        })
        .waitForOutcome()

    const fixedWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "fixed-step",
            input: null,
            run: async () => "Fixed"
        })
    })

    const outcome = await new Runtime({ journalStore }).resume(fixedWorkflow, { runId: "run-123" }).waitForOutcome()
    const events = await journalStore.list({ runId: "run-123" })

    expect(outcome).toEqual({ status: "completed" })
    expect(events.map(event => event.type)).toEqual(["run.started", "step.started", "step.completed", "run.completed"])
    expect(events[1]).toMatchObject({
        type: "step.started",
        name: "fixed-step"
    })
})

test("replays updated workflow steps after rewinding a failure", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    let prepareExecutions = 0
    let validateExecutions = 0
    let sendExecutions = 0
    const originalWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "prepare-message",
            input: null,
            run: async () => {
                prepareExecutions++
                return "Hello, Ada"
            }
        })
        await step({
            name: "send-message",
            input: null,
            run: async () => {
                sendExecutions++
                throw new Error("Broken sender")
            }
        })
    })

    await new Runtime({ journalStore })
        .start(originalWorkflow, {
            runId: "run-123",
            input: null
        })
        .waitForOutcome()

    const failedStartedEvents = await journalStore.listByType({ runId: "run-123", eventType: "step.started" })
    const failedSendEvent = failedStartedEvents.find(event => event.type === "step.started" && event.name === "send-message")
    if (failedSendEvent?.type !== "step.started") throw new Error("Expected send-message to have started")

    const updatedWorkflow = defineInputlessWorkflow(async () => {
        await step({
            name: "prepare-message",
            input: null,
            run: async () => {
                prepareExecutions++
                return "Hello, Ada"
            }
        })
        await step({
            name: "validate-message",
            input: null,
            run: async () => {
                validateExecutions++
                return true
            }
        })
        await step({
            name: "send-message",
            input: null,
            run: async () => {
                sendExecutions++
                return "sent"
            }
        })
    })

    const outcome = await new Runtime({ journalStore }).resume(updatedWorkflow, { runId: "run-123" }).waitForOutcome()
    const startedEvents = await journalStore.listByType({ runId: "run-123", eventType: "step.started" })
    const completedEvents = await journalStore.listByType({ runId: "run-123", eventType: "step.completed" })
    const validateStartedEvent = startedEvents.find(event => event.type === "step.started" && event.name === "validate-message")
    const sendStartedEvent = startedEvents.find(event => event.type === "step.started" && event.name === "send-message")

    if (validateStartedEvent?.type !== "step.started") throw new Error("Expected validate-message to have started")
    if (sendStartedEvent?.type !== "step.started") throw new Error("Expected send-message to have started")

    expect(outcome).toEqual({ status: "completed" })
    expect(prepareExecutions).toBe(1)
    expect(validateExecutions).toBe(1)
    expect(sendExecutions).toBe(2)
    expect(startedEvents.map(event => event.type === "step.started" && event.name)).toEqual(["prepare-message", "validate-message", "send-message"])
    expect(completedEvents.map(event => event.type === "step.completed" && event.name)).toEqual(["prepare-message", "validate-message", "send-message"])
    expect(await journalStore.listByType({ runId: "run-123", eventType: "step.failed" })).toEqual([])
    expect(validateStartedEvent.stepId).toBe(failedSendEvent.stepId)
    expect(sendStartedEvent.stepId).not.toBe(failedSendEvent.stepId)
})
