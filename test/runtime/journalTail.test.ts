import { expect, test } from "vitest"

import { getIncompleteTailStep } from "../../src/runtime/journalTail.js"
import type { StepCompletedEvent, StepFailedEvent, StepStartedEvent } from "../../src/index.js"

test("returns a step that was started at the journal tail", () => {
    const startedEvent = createStepStartedEvent()

    expect(getIncompleteTailStep([startedEvent])).toEqual(startedEvent)
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

    expect(getIncompleteTailStep([startedEvent, failedEvent])).toEqual(startedEvent)
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
