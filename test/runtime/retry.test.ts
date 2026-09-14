import { afterEach, expect, vi } from "vitest"

import { FileJournalStore, Runtime, sleep, step } from "../../src/index.js"
import type { RetryPolicy } from "../../src/index.js"
import { NativeDate } from "../../src/runtime/systemClock.js"
import { TimerHook } from "../../src/runtime/timerHook.js"
import { test } from "../fixtures/filesystem.js"
import { defineInputlessWorkflow } from "../fixtures/workflow.js"

afterEach(() => vi.restoreAllMocks())

test("retries only opted-in transient failures and retains attempt history after restart", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const originalError = new Error("Provider unavailable")
    const classify = vi.fn((error: unknown) => ({ retry: error === originalError }))
    let calls = 0
    const workflow = defineInputlessWorkflow(async () => {
        const result = await step({
            name: "provider",
            input: null,
            retry: { classify, jitter: false },
            run: () => {
                if (++calls < 3) throw originalError
                return "ok"
            }
        })
        expect(result).toBe("ok")
    })
    const store = new FileJournalStore(journalDirectory)
    const first = await new Runtime({ journalStore: store }).start(workflow, { runId, input: null }).waitForOutcome()
    if (first.status !== "suspended") throw new Error("Expected retry suspension")
    expect(first.suspension.request.payload).toEqual({ wakeAt: new NativeDate(now + 1_000).toISOString() })
    now += 1_000
    const second = await new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).resumeTimer(workflow, { runId, waitId: first.suspension.waitId }).waitForOutcome()
    if (second.status !== "suspended") throw new Error("Expected second retry suspension")
    expect(second.suspension.request.payload).toEqual({ wakeAt: new NativeDate(now + 2_000).toISOString() })
    now += 2_000
    expect(await new Runtime({ journalStore: store }).resumeTimer(workflow, { runId, waitId: second.suspension.waitId }).waitForOutcome()).toEqual({ status: "completed" })
    expect(calls).toBe(3)
    expect(classify).toHaveBeenCalledTimes(2)
    expect(await store.listByType({ runId, eventType: "step.attempt.failed" })).toHaveLength(2)
    expect(await store.listByType({ runId, eventType: "step.failed" })).toHaveLength(0)
})

test("exhausts three total attempts, preserves the final live error, and does not catch suspension", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const error = new TypeError("Provider unavailable")
    const caught: unknown[] = []
    let finalizations = 0
    let calls = 0
    const workflow = defineInputlessWorkflow(async () => {
        try {
            await step({
                name: "provider",
                input: null,
                retry: { classify: () => ({ retry: true }), jitter: false },
                run: () => {
                    calls++
                    throw error
                }
            })
        } catch (failure) {
            caught.push(failure)
        } finally {
            finalizations++
        }
    })
    const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
    let outcome = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    for (let attempt = 1; attempt < 3; attempt++) {
        if (outcome.status !== "suspended") throw new Error("Expected retry suspension")
        expect(caught).toEqual([])
        expect(finalizations).toBe(0)
        now += 10_000
        outcome = await runtime.resumeTimer(workflow, { runId, waitId: outcome.suspension.waitId }).waitForOutcome()
    }
    expect(outcome).toEqual({ status: "completed" })
    expect(calls).toBe(3)
    expect(caught).toEqual([error])
    expect(caught[0]).toBe(error)
    expect(finalizations).toBe(1)
})

test("all resume paths honor a provider delay and preserve the pending budget", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    let calls = 0
    const classify = vi.fn(() => ({ retry: true, delay: "2m" as const }))
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "provider",
            input: null,
            retry: { classify },
            run: () => {
                calls++
                throw new Error("Rate limited")
            }
        })
    })
    const store = new FileJournalStore(journalDirectory)
    const runtime = new Runtime({ journalStore: store })
    const first = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    if (first.status !== "suspended") throw new Error("Expected retry suspension")
    const waitId = first.suspension.waitId
    expect(first.suspension.request.payload).toEqual({ wakeAt: new NativeDate(now + 120_000).toISOString() })
    expect(await runtime.resume(workflow, { runId }).waitForOutcome()).toEqual(first)
    expect(await runtime.resumeTimer(workflow, { runId, waitId }).waitForOutcome()).toEqual(first)
    expect(await runtime.resumeHook(TimerHook, { workflow, runId, waitId, resolution: {} }).waitForOutcome()).toEqual(first)
    expect(await runtime.resume(workflow, { runId, event: { type: "wait.resolved", waitId, payload: {} } }).waitForOutcome()).toEqual(first)
    expect(calls).toBe(1)
    expect(classify).toHaveBeenCalledTimes(1)
    now += 120_000
    const next = await runtime.resumeTimer(workflow, { runId, waitId }).waitForOutcome()
    expect(next.status).toBe("suspended")
    expect(calls).toBe(2)
    expect(await runtime.resumeTimer(workflow, { runId, waitId }).waitForOutcome()).toEqual(next)
    expect(calls).toBe(2)
})

test("a completed retried step does not shift later workflow timers or randomness on replay", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    let calls = 0
    const randomValues: number[] = []
    const dates: number[] = []
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "provider",
            input: null,
            retry: { classify: () => ({ retry: true }) },
            run: () => {
                if (++calls === 1) throw new Error("Temporary")
                return null
            }
        })
        randomValues.push(Math.random())
        dates.push(Date.now())
        await sleep("1h")
    })
    const store = new FileJournalStore(journalDirectory)
    const runtime = new Runtime({ journalStore: store })
    const first = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    if (first.status !== "suspended") throw new Error("Expected retry suspension")
    now += 10_000
    const second = await runtime.resumeTimer(workflow, { runId, waitId: first.suspension.waitId }).waitForOutcome()
    if (second.status !== "suspended") throw new Error("Expected workflow sleep")
    expect(second.suspension.waitId).not.toBe(first.suspension.waitId)
    expect(await new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).resume(workflow, { runId }).waitForOutcome()).toEqual(second)
    expect(randomValues).toHaveLength(2)
    expect(randomValues[0]).toBe(randomValues[1])
    expect(dates).toEqual([now, now])
    expect(calls).toBe(2)
})

test("permanent failures and steps without a policy execute once", async ({ journalDirectory }) => {
    const store = new FileJournalStore(journalDirectory)
    const runtime = new Runtime({ journalStore: store })
    for (const retry of [undefined, { classify: () => ({ retry: false as const }) }]) {
        const run = vi.fn(() => {
            throw new Error("Invalid request")
        })
        const id = retry ? "permanent" : "no-policy"
        const workflow = defineInputlessWorkflow(async () => {
            await step({ name: "provider", input: null, retry, run })
        })
        expect(await runtime.start(workflow, { runId: id, input: null }).waitForOutcome()).toMatchObject({ status: "failed", error: { message: "Invalid request" } })
        expect(run).toHaveBeenCalledTimes(1)
        expect(await store.listByType({ runId: id, eventType: "wait.requested" })).toEqual([])
    }
})

test("custom attempt limits and capped exponential delays are honored", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const run = vi.fn(() => {
        throw new Error("Temporary")
    })
    const workflow = defineInputlessWorkflow(async () => {
        await step({ name: "provider", input: null, retry: { classify: () => ({ retry: true }), maxAttempts: 4, initialDelay: "2s", backoffMultiplier: 3, maxDelay: "5s", jitter: false }, run })
    })
    const store = new FileJournalStore(journalDirectory)
    const runtime = new Runtime({ journalStore: store })
    let outcome = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    for (const delayMs of [2_000, 5_000, 5_000]) {
        if (outcome.status !== "suspended") throw new Error("Expected retry")
        expect(outcome.suspension.request.payload).toEqual({ wakeAt: new NativeDate(now + delayMs).toISOString() })
        now += delayMs
        outcome = await runtime.resumeTimer(workflow, { runId, waitId: outcome.suspension.waitId }).waitForOutcome()
    }
    expect(outcome.status).toBe("failed")
    expect(run).toHaveBeenCalledTimes(4)
    expect(await store.listByType({ runId, eventType: "step.failed" })).toMatchObject([{ attempt: 4, reason: "attempts-exhausted" }])
})

test("manual resume resets an exhausted budget, allows changed code, and rejects old timers", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const prepare = vi.fn(() => "prepared")
    let name = "broken-provider"
    let succeed = false
    let calls = 0
    const workflow = defineInputlessWorkflow(async () => {
        await step({ name: "prepare", input: null, run: prepare })
        await step({
            name,
            input: null,
            retry: { maxAttempts: 2, jitter: false, classify: () => ({ retry: true }) },
            run: () => {
                calls++
                if (!succeed) throw new Error("Temporary")
                return null
            }
        })
    })
    const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
    const first = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    if (first.status !== "suspended") throw new Error("Expected retry")
    const oldWaitId = first.suspension.waitId
    now += 1_000
    expect((await runtime.resumeTimer(workflow, { runId, waitId: oldWaitId }).waitForOutcome()).status).toBe("failed")
    expect((await runtime.resumeTimer(workflow, { runId, waitId: oldWaitId }).waitForOutcome()).status).toBe("failed")
    expect(calls).toBe(2)
    name = "fixed-provider"
    const reset = await runtime.resume(workflow, { runId }).waitForOutcome()
    if (reset.status !== "suspended") throw new Error("Expected fresh budget")
    expect(reset.suspension.waitId).not.toBe(oldWaitId)
    await expect(runtime.resumeTimer(workflow, { runId, waitId: oldWaitId }).waitForOutcome()).rejects.toThrow("does not exist")
    succeed = true
    now += 1_000
    expect(await runtime.resumeTimer(workflow, { runId, waitId: reset.suspension.waitId }).waitForOutcome()).toEqual({ status: "completed" })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(calls).toBe(4)
})

test("caught terminal failures replay without executing again after a later workflow suspension", async ({ journalDirectory }) => {
    let now = 1_800_000_000_000
    vi.spyOn(NativeDate, "now").mockImplementation(() => now)
    const error = new TypeError("Invalid request")
    const run = vi.fn(() => {
        throw error
    })
    const classify = vi.fn(() => ({ retry: false as const }))
    const caught: unknown[] = []
    const workflow = defineInputlessWorkflow(async () => {
        try {
            await step({ name: "provider", input: null, retry: { classify }, run })
        } catch (failure) {
            caught.push(failure)
        }
        await sleep("1s")
    })
    const runtime = new Runtime({ journalStore: new FileJournalStore(journalDirectory) })
    const first = await runtime.start(workflow, { runId, input: null }).waitForOutcome()
    if (first.status !== "suspended") throw new Error("Expected workflow sleep")
    now += 1_000
    expect(await runtime.resumeTimer(workflow, { runId, waitId: first.suspension.waitId }).waitForOutcome()).toEqual({ status: "completed" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(caught[0]).toBe(error)
    expect(caught[1]).toMatchObject({ name: "TypeError", message: "Invalid request" })
})

test("invalid policies fail before executing external work", async ({ journalDirectory }) => {
    const invalidPolicies: RetryPolicy[] = [
        { maxAttempts: 0, classify: () => ({ retry: true }) },
        { maxAttempts: 1.5, classify: () => ({ retry: true }) },
        { maxAttempts: Infinity, classify: () => ({ retry: true }) },
        { initialDelay: "0s", classify: () => ({ retry: true }) },
        { maxDelay: "-1s", classify: () => ({ retry: true }) },
        { maxDelay: "10000 years", classify: () => ({ retry: true }) },
        { backoffMultiplier: 0.5, classify: () => ({ retry: true }) }
    ]
    for (const [index, retry] of invalidPolicies.entries()) {
        const run = vi.fn(() => null)
        const workflow = defineInputlessWorkflow(async () => {
            await step({ name: "provider", input: null, retry, run })
        })
        const outcome = await new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).start(workflow, { runId: `invalid-${index}`, input: null }).waitForOutcome()
        expect(outcome.status).toBe("failed")
        expect(run).not.toHaveBeenCalled()
    }
})

test("classifier failures and invalid delay decisions terminate without retrying", async ({ journalDirectory }) => {
    const policies: RetryPolicy[] = [
        {
            classify: () => {
                throw new Error("Bad classifier")
            }
        },
        { classify: () => ({ retry: true, delay: "-1s" }) },
        { classify: () => ({ retry: true, delay: "10000 years" }) }
    ]
    for (const [index, retry] of policies.entries()) {
        const run = vi.fn(() => {
            throw new Error("API error")
        })
        const workflow = defineInputlessWorkflow(async () => {
            await step({ name: "provider", input: null, retry, run })
        })
        const id = `classifier-${index}`
        const store = new FileJournalStore(journalDirectory)
        const outcome = await new Runtime({ journalStore: store }).start(workflow, { runId: id, input: null }).waitForOutcome()
        expect(outcome).toMatchObject({ status: "failed", error: { name: "RetryClassificationError" } })
        expect(run).toHaveBeenCalledTimes(1)
        expect(await store.listByType({ runId: id, eventType: "step.failed" })).toMatchObject([{ reason: "classifier-failed" }])
        expect(await store.listByType({ runId: id, eventType: "wait.requested" })).toEqual([])
    }
})

test("nested durable operations fail clearly without being classified as transient", async ({ journalDirectory }) => {
    const classify = vi.fn(() => ({ retry: true as const }))
    const operations = [
        async (): Promise<void> => {
            await sleep("1s")
        },
        async (): Promise<void> => {
            await step({ name: "inner", input: null, run: () => null })
        }
    ]
    for (const [index, operation] of operations.entries()) {
        const workflow = defineInputlessWorkflow(async () => {
            await step({
                name: "outer",
                input: null,
                retry: { classify },
                run: async () => {
                    await operation()
                    return null
                }
            })
        })
        expect(await new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).start(workflow, { runId: `nested-${index}`, input: null }).waitForOutcome()).toMatchObject({
            status: "failed",
            error: { name: "DurableOperationError" }
        })
    }
    expect(classify).not.toHaveBeenCalled()
})

test("retry scheduling events include the failed attempt, error, and selected wake time", async ({ journalDirectory }) => {
    const workflow = defineInputlessWorkflow(async () => {
        await step({
            name: "provider",
            input: null,
            retry: { classify: () => ({ retry: true, delay: "30s" }) },
            run: () => {
                throw new Error("Rate limited")
            }
        })
    })
    const events = []
    for await (const event of new Runtime({ journalStore: new FileJournalStore(journalDirectory) }).start(workflow, { runId, input: null })) events.push(event)
    expect(events.map(event => event.type)).toEqual(["runtime.started", "step.started", "step.retry.scheduled", "hook.requested", "runtime.suspended"])
    expect(events[2]).toMatchObject({ type: "step.retry.scheduled", attempt: 1, delayMs: 30_000, error: { name: "Error", message: "Rate limited" } })
})

const runId = "retry-test"
