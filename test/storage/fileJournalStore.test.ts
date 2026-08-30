import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "vitest"

import { FileJournalStore } from "../../src/index.js"
import type { RunCompletedEvent } from "../../src/types/runCompletedEvent.js"
import type { RunStartedEvent } from "../../src/types/runStartedEvent.js"
import { test } from "../fixtures/filesystem.js"

test("writes each journal event to its run directory", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const event = createRunStartedEvent()

    expect(
        await journalStore.append({
            runId: "run-123",
            event
        })
    ).toEqual(event)

    const runDirectory = join(journalDirectory, "run-123")

    expect((await stat(runDirectory)).isDirectory()).toBe(true)
    expect(await readdir(runDirectory)).toEqual(["00000001-run.started.json"])
})

test("reads events in append order after the store restarts", async ({ journalDirectory }) => {
    const startedEvent = createRunStartedEvent()
    const completedEvent: RunCompletedEvent = {
        eventId: "run.completed",
        type: "run.completed",
        completedAt: "2026-08-24T15:31:00.000Z"
    }
    const journalStore = new FileJournalStore(journalDirectory)

    await journalStore.append({ runId: "run-123", event: startedEvent })
    await journalStore.append({ runId: "run-123", event: completedEvent })

    const restartedJournalStore = new FileJournalStore(journalDirectory)

    expect(await restartedJournalStore.list({ runId: "run-123" })).toEqual([startedEvent, completedEvent])
    expect(await restartedJournalStore.get({ runId: "run-123", eventId: "run.completed" })).toEqual(completedEvent)
    expect(await restartedJournalStore.get({ runId: "run-123", eventId: "missing-event" })).toBeUndefined()
})

test("keeps journals for different runs isolated", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const firstRunEvent = createRunStartedEvent("first-workflow")
    const secondRunEvent = createRunStartedEvent("second-workflow")

    await journalStore.append({ runId: "run-1", event: firstRunEvent })
    await journalStore.append({ runId: "run-2", event: secondRunEvent })

    expect(await journalStore.list({ runId: "run-1" })).toEqual([firstRunEvent])
    expect(await journalStore.list({ runId: "run-2" })).toEqual([secondRunEvent])
})

test("rejects an invalid event before writing it", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)

    await expect(
        journalStore.append({
            runId: "run-123",
            event: {
                eventId: "run.started",
                type: "run.started"
            }
        })
    ).rejects.toThrow()

    expect(await readdir(journalDirectory)).toEqual([])
})

test("rejects a corrupted journal file", async ({ journalDirectory }) => {
    const runDirectory = join(journalDirectory, "run-123")
    await mkdir(runDirectory)
    await writeFile(join(runDirectory, "00000001-run.started.json"), "{not-json\n", "utf8")

    await expect(new FileJournalStore(journalDirectory).list({ runId: "run-123" })).rejects.toThrow()
})

test("pops all journal events for a step from the tail", async ({ journalDirectory }) => {
    const journalStore = new FileJournalStore(journalDirectory)
    const startedEvent = createRunStartedEvent()

    await journalStore.append({ runId: "run-123", event: startedEvent })
    await journalStore.append({
        runId: "run-123",
        event: {
            eventId: "step.started:step-123",
            type: "step.started",
            stepId: "step-123",
            name: "broken-step",
            startedAt: "2026-08-24T15:30:30.000Z",
            input: null
        }
    })
    await journalStore.append({
        runId: "run-123",
        event: {
            eventId: "step.failed:step-123",
            type: "step.failed",
            stepId: "step-123",
            name: "broken-step",
            failedAt: "2026-08-24T15:30:45.000Z",
            error: {
                name: "Error",
                message: "Broken"
            }
        }
    })

    await journalStore.popStep({
        runId: "run-123",
        stepId: "step-123"
    })

    expect(await journalStore.list({ runId: "run-123" })).toEqual([startedEvent])
})

function createRunStartedEvent(workflowName = "test-workflow"): RunStartedEvent {
    return {
        eventId: "run.started",
        type: "run.started",
        workflowName,
        startedAt: "2026-08-24T15:30:00.000Z",
        input: null
    }
}
