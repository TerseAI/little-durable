import { afterEach, expect, vi } from "vitest"

import { FileJournalStore, Runtime, step } from "../../src/index.js"
import { NativeDate } from "../../src/runtime/systemClock.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

afterEach(() => vi.restoreAllMocks())

test("retries a transient failure through a durable timer and replays it after restart", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const journalStore = new FileJournalStore(journalDirectory)
    let calls = 0
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "provider",
            input: null,
            retry: { shouldRetry: error => error instanceof Error && error.message === "Provider unavailable" },
            run: async () => {
                calls++
                if (calls === 1) throw new Error("Provider unavailable")
                return "ok"
            }
        })
    })

    const suspended = await new Runtime({ journalStore }).start(workflow, { runId: "run-123", input: null }).waitForOutcome()

    if (suspended.status !== "suspended") throw new Error("Expected the retry to suspend the run")
    expect(suspended.suspension.request).toEqual({ type: "hook", name: "timer", payload: { wakeAt: new NativeDate(now + 1_000).toISOString() } })
    expect(calls).toBe(1)

    now += 1_000
    const completed = await new Runtime({ journalStore }).resumeTimer(workflow, { runId: "run-123", waitId: suspended.suspension.waitId }).waitForOutcome()

    expect(completed).toEqual({ status: "completed" })
    expect(calls).toBe(2)
    expect((await journalStore.list({ runId: "run-123" })).map(event => event.type)).toEqual([
        "run.started",
        "step.started",
        "step.failed",
        "wait.requested",
        "wait.resolved",
        "step.started",
        "step.completed",
        "run.completed"
    ])
})

test("applies capped exponential backoff and fails once attempts are exhausted", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const journalStore = new FileJournalStore(journalDirectory)
    let calls = 0
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "provider",
            input: null,
            retry: { shouldRetry: () => true, maxAttempts: 3, initialDelay: "1s", backoffMultiplier: 3, maxDelay: "2s" },
            run: async () => {
                calls++
                throw new Error(`Failure ${calls}`)
            }
        })
    })

    let outcome = await new Runtime({ journalStore }).start(workflow, { runId: "run-123", input: null }).waitForOutcome()
    const wakeAts: string[] = []
    while (outcome.status === "suspended") {
        const timer = outcome.suspension.request.payload as { wakeAt: string }
        wakeAts.push(timer.wakeAt)
        now = Date.parse(timer.wakeAt)
        outcome = await new Runtime({ journalStore }).resumeTimer(workflow, { runId: "run-123", waitId: outcome.suspension.waitId }).waitForOutcome()
    }

    expect(wakeAts).toEqual([new NativeDate(1_800_000_001_000).toISOString(), new NativeDate(1_800_000_003_000).toISOString()])
    expect(outcome).toEqual({ status: "failed", error: { name: "Error", message: "Failure 3" } })
    expect(calls).toBe(3)
})

test("does not retry errors the policy rejects", async ({ journalDirectory }) => {
    let calls = 0
    const outcome = await new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
        .start(
            defineInputlessWorkflow(async () => {
                await step({
                    name: "provider",
                    input: null,
                    retry: { shouldRetry: () => false },
                    run: async () => {
                        calls++
                        throw new Error("Bad request")
                    }
                })
            }),
            { runId: "run-123", input: null }
        )
        .waitForOutcome()

    expect(outcome).toEqual({ status: "failed", error: { name: "Error", message: "Bad request" } })
    expect(calls).toBe(1)
})
