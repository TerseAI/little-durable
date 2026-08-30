import type { JournalEvent } from "./journalEvent.js"

export interface JournalStore {
    list(params: ListJournalEventsParams): Promise<readonly JournalEvent[]>
    listByType(params: ListJournalEventsByTypeParams): Promise<readonly JournalEvent[]>
    get(params: GetJournalEventParams): Promise<JournalEvent | undefined>
    append(params: AppendJournalEventParams): Promise<JournalEvent>
    popStep(params: PopJournalStepParams): Promise<void>
}

export type ListJournalEventsParams = {
    readonly runId: string
}

export type ListJournalEventsByTypeParams = {
    readonly runId: string
    readonly eventType: JournalEvent["type"]
}

export type GetJournalEventParams = {
    readonly runId: string
    readonly eventId: string
}

export type AppendJournalEventParams = {
    readonly runId: string
    readonly event: unknown
}

export type PopJournalStepParams = {
    readonly runId: string
    readonly stepId: string
}
