import { afterEach, expect, vi } from "vitest"

import { FileJournalStore, Runtime, step } from "../../src/index.js"
import type { JournalEvent, JournalStore } from "../../src/index.js"
import { NativeDate } from "../../src/runtime/systemClock.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

afterEach(() => vi.restoreAllMocks())

for (const eventType of ["step.attempt.failed", "wait.requested"] as const) {
    test(`recovers after committing ${eventType} without reclassifying or recalculating jitter`, async ({ journalDirectory }) => {
        let now = 1_800_000_000_000
        vi.spyOn(NativeDate, "now").mockImplementation(() => now)
        const store = new FileJournalStore(journalDirectory)
        const failing = interruptAppend(store, eventType, "after")
        let calls = 0
        const classify = vi.fn(() => ({ retry: true as const }))
        const workflow = defineInputlessWorkflow(async () => {
            await step({
                name: "provider",
                input: null,
                retry: { classify },
                run: () => {
                    if (++calls === 1) throw new Error("Temporary")
                    return "ok"
                }
            })
        })
        expect(await new Runtime({ journalStore: failing }).start(workflow, { runId, input: null }).waitForOutcome()).toMatchObject({
            status: "failed",
            error: { message: "Interrupted journal write" }
        })
        const [failure] = await store.listByType({ runId, eventType: "step.attempt.failed" })
        if (failure?.type !== "step.attempt.failed" || failure.decision.type !== "retry") throw new Error("Expected committed retry decision")
        expect(failure.decision.delayMs).toBeGreaterThanOrEqual(0)
        expect(failure.decision.delayMs).toBeLessThan(1_000)
        const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
        const resumed = await runtime.resume(workflow, { runId }).waitForOutcome()
        expect(resumed).toMatchObject({ status: "suspended", suspension: { waitId: failure.decision.waitId, request: { payload: { wakeAt: failure.decision.wakeAt } } } })
        expect(calls).toBe(1)
        expect(classify).toHaveBeenCalledTimes(1)
        now += 1_000
        expect(await runtime.resumeTimer(workflow, { runId, waitId: failure.decision.waitId }).waitForOutcome()).toEqual({ status: "completed" })
        expect(calls).toBe(2)
        expect(classify).toHaveBeenCalledTimes(1)
        expect(await store.listByType({ runId, eventType: "wait.requested" })).toHaveLength(1)
    })
}

test("an interrupted step start preserves its budget and policy snapshot", async ({ journalDirectory }) => {
    const store = new FileJournalStore(journalDirectory)
    let maxAttempts = 3
    const run = vi.fn(() => {
        throw new Error("Temporary")
    })
    const workflow = defineInputlessWorkflow(async () => {
        await step({ name: "provider", input: null, retry: { maxAttempts, classify: () => ({ retry: true }) }, run })
    })
    await new Runtime({ journalStore: interruptAppend(store, "step.started", "after") }).start(workflow, { runId, input: null }).waitForOutcome()
    const starts = await store.listByType({ runId, eventType: "step.started" })
    expect(run).not.toHaveBeenCalled()
    maxAttempts = 1
    expect((await new Runtime({ journalStore: store }).resume(workflow, { runId }).waitForOutcome()).status).toBe("suspended")
    expect(await store.listByType({ runId, eventType: "step.started" })).toEqual(starts)
    expect(run).toHaveBeenCalledTimes(1)
})

test("repairs an interrupted terminal marker without another API attempt", async ({ journalDirectory }) => {
    const store = new FileJournalStore(journalDirectory)
    const run = vi.fn(() => {
        throw new TypeError("Permanent")
    })
    const classify = vi.fn(() => ({ retry: false as const }))
    const workflow = defineInputlessWorkflow(async () => {
        await step({ name: "provider", input: null, retry: { classify }, run })
    })
    await new Runtime({ journalStore: interruptAppend(store, "step.failed", "before") }).start(workflow, { runId, input: null }).waitForOutcome()
    expect(await store.listByType({ runId, eventType: "step.failed" })).toEqual([])
    expect(await new Runtime({ journalStore: store }).resume(workflow, { runId }).waitForOutcome()).toMatchObject({ status: "failed", error: { name: "TypeError", message: "Permanent" } })
    expect(run).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(await store.listByType({ runId, eventType: "step.failed" })).toMatchObject([{ reason: "not-retryable", attempt: 1 }])
})

for (const phase of ["before", "after"] as const) {
    test(`recovers ${phase} committing a timer resolution without an extra attempt`, async ({ journalDirectory }) => {
        let now = 1_800_000_000_000
        vi.spyOn(NativeDate, "now").mockImplementation(() => now)
        const store = new FileJournalStore(journalDirectory)
        const run = vi.fn(() => {
            if (run.mock.calls.length === 1) throw new Error("Temporary")
            return null
        })
        const workflow = defineInputlessWorkflow(async () => {
            await step({ name: "provider", input: null, retry: { classify: () => ({ retry: true }) }, run })
        })
        const runtime = new Runtime({ journalStore: interruptAppend(store, "wait.resolved", phase) })
        const first = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
        if (first.status !== "suspended") throw new Error("Expected retry")
        now += 1_000
        await expect(runtime.resumeTimer(workflow, { runId, waitId: first.suspension.waitId }).waitForOutcome()).rejects.toThrow("Interrupted journal write")
        expect(run).toHaveBeenCalledTimes(1)
        expect(await new Runtime({ journalStore: store }).resumeTimer(workflow, { runId, waitId: first.suspension.waitId }).waitForOutcome()).toEqual({ status: "completed" })
        expect(run).toHaveBeenCalledTimes(2)
        expect(await store.listByType({ runId, eventType: "wait.resolved" })).toHaveLength(1)
    })
}

test("a committed successful result is replayed after interrupted completion", async ({ journalDirectory }) => {
    const store = new FileJournalStore(journalDirectory)
    const run = vi.fn(() => "ok")
    const classify = vi.fn(() => ({ retry: true as const }))
    const workflow = defineInputlessWorkflow(async () => {
        expect(await step({ name: "provider", input: null, retry: { classify }, run })).toBe("ok")
    })
    expect((await new Runtime({ journalStore: interruptAppend(store, "step.completed", "after") }).start(workflow, { runId, input: null }).waitForOutcome()).status).toBe("failed")
    expect(await new Runtime({ journalStore: store }).resume(workflow, { runId }).waitForOutcome()).toEqual({ status: "completed" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(classify).not.toHaveBeenCalled()
})

function interruptAppend(store: JournalStore, eventType: JournalEvent["type"], phase: "before" | "after"): JournalStore {
    let interrupted = false
    return {
        get: params => store.get(params),
        list: params => store.list(params),
        listByType: params => store.listByType(params),
        popStep: params => store.popStep(params),
        append: async params => {
            const matches = typeof params.event === "object" && params.event !== null && "type" in params.event && params.event.type === eventType
            if (matches && !interrupted && phase === "before") {
                interrupted = true
                throw new Error("Interrupted journal write")
            }
            const event = await store.append(params)
            if (matches && !interrupted && phase === "after") {
                interrupted = true
                throw new Error("Interrupted journal write")
            }
            return event
        }
    }
}

const runId = "retry-recovery"
