import type { JournalEvent } from "../types/journalEvent.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

export function getIncompleteTailStep(events: readonly JournalEvent[]): IncompleteTailStep | undefined {
    const tail = events.at(-1)

    if (tail?.type === "step.started") return tail.retry ? undefined : { startedEvent: tail, eventCount: 1 }
    if (tail?.type !== "step.failed") return undefined

    const unmatchedWaits = new Set<string>()
    let hasRetryEvents = false
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]
        if ("stepId" in event && event.stepId !== tail.stepId) break
        switch (event.type) {
            case "step.started":
                if (unmatchedWaits.size === 0 && (!hasRetryEvents || event.retry)) {
                    return { startedEvent: event, eventCount: events.length - index }
                }
                break
            case "step.failed":
                continue
            case "step.attempt.failed":
                hasRetryEvents = true
                if (event.decision.type === "retry") unmatchedWaits.delete(event.decision.waitId)
                continue
            case "wait.requested":
            case "wait.resolved":
                hasRetryEvents = true
                // Walking backward reaches the wait before the attempt that scheduled it.
                unmatchedWaits.add(event.waitId)
                continue
            default:
                break
        }
        break
    }
    throw new Error(`Step "${tail.stepId}" is not an incomplete step at the journal tail`)
}

type IncompleteTailStep = {
    readonly startedEvent: StepStartedEvent
    readonly eventCount: number
}
