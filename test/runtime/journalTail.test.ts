import { expect, test } from "vitest"

import { getIncompleteTailStep } from "../../src/runtime/journalTail.js"
import type { JournalEvent, StepCompletedEvent, StepFailedEvent, StepStartedEvent } from "../../src/index.js"

test("returns a step that was started at the journal tail", () => {
    const startedEvent = createStepStartedEvent()

    expect(getIncompleteTailStep([startedEvent])).toEqual({ startedEvent, eventCount: 1 })
})

test("returns a step that failed at the journal tail", () => {
    const startedEvent = createStepStartedEvent()
    const failedEvent: StepFailedEvent = {
        eventId: "step.failed:step-123",
        type: "step.failed",
        stepId: "step-123",
        name: "test-step",
        failedAt: "2026-08-24T15:31:00.000Z",
        error: {
            name: "Error",
            message: "Broken"
        }
    }

    expect(getIncompleteTailStep([startedEvent, failedEvent])).toEqual({ startedEvent, eventCount: 2 })
})

test("returns no incomplete step when the journal tail completed", () => {
    const startedEvent = createStepStartedEvent()
    const completedEvent: StepCompletedEvent = {
        eventId: "step.completed:step-123",
        type: "step.completed",
        stepId: "step-123",
        name: "test-step",
        completedAt: "2026-08-24T15:31:00.000Z",
        output: null
    }

    expect(getIncompleteTailStep([startedEvent, completedEvent])).toBeUndefined()
})

function createStepStartedEvent(): StepStartedEvent {
    return {
        eventId: "step.started:step-123",
        type: "step.started",
        stepId: "step-123",
        name: "test-step",
        startedAt: "2026-08-24T15:30:00.000Z",
        input: null
    }
}

test("finds a failed retry step beyond its timers while preserving earlier work", () => {
    const events = createFailedRetryEvents()
    const earlier: StepCompletedEvent = { eventId: "step.completed:earlier", type: "step.completed", stepId: "earlier", name: "earlier", completedAt: "2026-08-24T15:00:00.000Z", output: null }
    expect(getIncompleteTailStep([earlier, ...events])).toEqual({ startedEvent: events[0], eventCount: events.length })
})

test("rejects unrelated events inside a failed retry step", () => {
    const unrelated: JournalEvent[] = [
        { eventId: "wait.requested:other", type: "wait.requested", waitId: "other", requestedAt: "2026-08-24T15:30:00.000Z", request: {} },
        { eventId: "step.completed:other", type: "step.completed", stepId: "other", name: "other", completedAt: "2026-08-24T15:30:00.000Z", output: null },
        { ...createStepStartedEvent(), stepId: "other", eventId: "step.started:other" }
    ]
    for (const event of unrelated) {
        const events = createFailedRetryEvents()
        events.splice(2, 0, event)
        expect(() => getIncompleteTailStep(events)).toThrow("not an incomplete step")
    }
})

test("preserves retry starts and pending retry waits", () => {
    const events = createFailedRetryEvents()
    expect(getIncompleteTailStep(events.slice(0, 1))).toBeUndefined()
    expect(getIncompleteTailStep(events.slice(0, -1))).toBeUndefined()
})

function createFailedRetryEvents(): JournalEvent[] {
    const started: StepStartedEvent = {
        ...createStepStartedEvent(),
        retry: { budgetId: "7f9e2c20-bb18-4ef2-8bd4-c94699199e0a", maxAttempts: 2, initialDelayMs: 1_000, maxDelayMs: 30_000, backoffMultiplier: 2, jitter: false }
    }
    const timestamp = "2026-08-24T15:31:00.000Z"
    return [
        started,
        {
            eventId: "attempt-1",
            type: "step.attempt.failed",
            stepId: started.stepId,
            name: started.name,
            attempt: 1,
            failedAt: timestamp,
            error: { name: "Error", message: "Temporary" },
            decision: { type: "retry", waitId: "retry-wait", delayMs: 1_000, wakeAt: timestamp }
        },
        { eventId: "wait.requested:retry-wait", type: "wait.requested", waitId: "retry-wait", requestedAt: timestamp, request: { type: "hook", name: "timer", payload: { wakeAt: timestamp } } },
        { eventId: "wait.resolved:retry-wait", type: "wait.resolved", waitId: "retry-wait", resolvedAt: timestamp, payload: {} },
        { eventId: "step.failed:step-123", type: "step.failed", stepId: started.stepId, name: started.name, failedAt: timestamp, error: { name: "Error", message: "Failed" } }
    ]
}
