import type { JournalEvent } from "../types/journalEvent.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

export function getIncompleteTailStep(events: readonly JournalEvent[]): StepStartedEvent | undefined {
    const tail = events.at(-1)

    if (tail?.type === "step.started") return tail
    if (tail?.type !== "step.failed") return undefined

    const startedEvent = events.at(-2)
    if (startedEvent?.type !== "step.started" || startedEvent.stepId !== tail.stepId) {
        throw new Error(`Step "${tail.stepId}" failed without a matching step.started event at the journal tail`)
    }

    return startedEvent
}
