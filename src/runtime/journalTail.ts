import type { JournalEvent } from "../types/journalEvent.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

export function getIncompleteTailStep(events: readonly JournalEvent[]): StepStartedEvent | undefined {
    const tail = events.at(-1)

    if (tail?.type === "step.started") return tail.retry ? undefined : tail
    if (tail?.type !== "step.failed") return undefined

    const startedEvent = events.find(event => event.type === "step.started" && event.stepId === tail.stepId)
    if (startedEvent?.type !== "step.started") {
        throw new Error(`Step "${tail.stepId}" failed without a matching step.started event at the journal tail`)
    }
    getRewindableStepTail(events, tail.stepId)
    return startedEvent
}

export function getRewindableStepTail(events: readonly JournalEvent[], stepId: string): readonly JournalEvent[] {
    const index = events.findIndex(event => event.type === "step.started" && event.stepId === stepId)
    const tail = index < 0 ? [] : events.slice(index)
    const started = tail[0]
    if (started?.type !== "step.started") throw new Error(`Step "${stepId}" is not an incomplete step at the journal tail`)
    const waitIds = new Set(tail.flatMap(event => (event.type === "step.attempt.failed" && event.stepId === stepId && event.decision.type === "retry" ? [event.decision.waitId] : [])))
    const valid = tail.slice(1).every(event => {
        switch (event.type) {
            case "step.failed":
                return event.stepId === stepId
            case "step.attempt.failed":
                return Boolean(started.retry) && event.stepId === stepId
            case "wait.requested":
            case "wait.resolved":
                return Boolean(started.retry) && waitIds.has(event.waitId)
            default:
                return false
        }
    })
    if (!valid || (started.retry && tail.at(-1)?.type !== "step.failed")) throw new Error(`Step "${stepId}" is not an incomplete step at the journal tail`)
    return tail
}
