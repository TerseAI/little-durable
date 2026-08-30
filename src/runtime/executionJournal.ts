import type { JournalEvent } from "../types/journalEvent.js"
import type { AppendJournalEventParams, GetJournalEventParams, JournalStore, ListJournalEventsByTypeParams, ListJournalEventsParams } from "../types/journalStore.js"

export class ExecutionJournal implements JournalStore {
    constructor(private readonly options: ExecutionJournalOptions) {}

    list(params: ListJournalEventsParams): Promise<readonly JournalEvent[]> {
        return this.options.store.list(params)
    }

    listByType(params: ListJournalEventsByTypeParams): Promise<readonly JournalEvent[]> {
        return this.options.store.listByType(params)
    }

    get(params: GetJournalEventParams): Promise<JournalEvent | undefined> {
        return this.options.store.get(params)
    }

    async append(params: AppendJournalEventParams): Promise<JournalEvent> {
        const event = await this.options.store.append(params)
        await this.options.runtimeEvents.observe(event)
        return event
    }
}

type ExecutionJournalOptions = {
    readonly store: JournalStore
    readonly runtimeEvents: JournalEventObserver
}

type JournalEventObserver = {
    readonly observe: (event: JournalEvent) => Promise<void>
}
