import { expect } from "vitest"

import { ExecutionJournal } from "../../src/runtime/executionJournal.js"
import { FileJournalStore } from "../../src/index.js"
import type { JournalEvent, JournalStore, RunStartedEvent } from "../../src/index.js"
import { test } from "../fixtures/filesystem.js"

test("observes successfully appended events and delegates reads", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const observedEvents: JournalEvent[] = []
    const journal = new ExecutionJournal({
        store: journalStore,
        runtimeEvents: {
            observe: async event => {
                observedEvents.push(event)
            }
        }
    })
    const event = createRunStartedEvent()

    expect(await journal.append({ runId: "run-123", event })).toEqual(event)
    expect(await journal.get({ runId: "run-123", eventId: event.eventId })).toEqual(event)
    expect(await journal.list({ runId: "run-123" })).toEqual([event])
    expect(await journal.listByType({ runId: "run-123", eventType: "run.started" })).toEqual([event])
    expect(observedEvents).toEqual([event])
})

test("does not observe an event when the append fails", async ({ journalDirectory }) => {
    const fileJournalStore = new FileJournalStore(journalDirectory)
    const appendError = new Error("append failed")
    const failingStore: JournalStore = {
        get: params => fileJournalStore.get(params),
        list: params => fileJournalStore.list(params),
        listByType: params => fileJournalStore.listByType(params),
        append: async () => {
            throw appendError
        }
    }
    const observedEvents: JournalEvent[] = []
    const journal = new ExecutionJournal({
        store: failingStore,
        runtimeEvents: {
            observe: async event => {
                observedEvents.push(event)
            }
        }
    })

    await expect(journal.append({ runId: "run-123", event: createRunStartedEvent() })).rejects.toBe(appendError)
    expect(observedEvents).toEqual([])
})

function createRunStartedEvent(): RunStartedEvent {
    return {
        eventId: "run.started",
        type: "run.started",
        workflowName: "test-workflow",
        startedAt: "2026-08-24T15:30:00.000Z",
        input: null
    }
}
