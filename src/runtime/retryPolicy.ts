import { randomInt, randomUUID } from "node:crypto"
import ms from "ms"
import type { StringValue } from "ms"
import { z } from "zod"

import { RetryPolicySnapshotSchema } from "../types/retryPolicySnapshot.js"
import type { RetryPolicySnapshot } from "../types/retryPolicySnapshot.js"
import type { StepAttemptFailedEvent } from "../types/stepAttemptFailedEvent.js"
import { RetryScheduleSchema } from "../types/stepAttemptFailedEvent.js"

import { systemNow, toIsoString } from "./systemClock.js"
import { DurableOperationError } from "./workflowContext.js"

export function normalizeRetryPolicy(policy: RetryPolicy): RetryPolicySnapshot {
    if (typeof policy.classify !== "function") throw new TypeError("Retry policy requires a classify function")
    return RetryPolicySnapshotSchema.parse({
        budgetId: randomUUID(),
        maxAttempts: policy.maxAttempts ?? 3,
        initialDelayMs: parseDelay(policy.initialDelay ?? "1s"),
        backoffMultiplier: policy.backoffMultiplier ?? 2,
        maxDelayMs: parseDelay(policy.maxDelay ?? "30s"),
        jitter: policy.jitter ?? true
    })
}

export function classifyAttempt({ error, policy, snapshot, attempt, failedAt }: ClassifyAttemptParams): ClassifiedAttempt {
    if (error instanceof DurableOperationError) return { error, decision: { type: "failed", reason: "invalid-operation" } }
    try {
        const decision = RetryDecisionSchema.parse(policy.classify(error))
        if (decision.retry && decision.delay !== undefined) parseDelay(decision.delay)
        if (!decision.retry) return { error, decision: { type: "failed", reason: "not-retryable" } }
        if (attempt >= snapshot.maxAttempts) return { error, decision: { type: "failed", reason: "attempts-exhausted" } }

        const backoff = Math.min(snapshot.maxDelayMs, snapshot.initialDelayMs * snapshot.backoffMultiplier ** (attempt - 1))
        const delayMs = decision.delay === undefined ? (snapshot.jitter ? Math.floor((backoff * randomInt(0, 2 ** 32)) / 2 ** 32) : backoff) : parseDelay(decision.delay)
        return {
            error,
            decision: RetryScheduleSchema.parse({
                type: "retry",
                waitId: `wait_retry_${snapshot.budgetId}_${attempt}`,
                delayMs,
                wakeAt: toIsoString(failedAt + delayMs)
            })
        }
    } catch (cause) {
        return { error: new RetryClassificationError(cause), decision: { type: "failed", reason: "classifier-failed" } }
    }
}

function parseDelay(duration: StringValue): number {
    const milliseconds = ms(duration)
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > maximumWakeAt - systemNow()) {
        throw new RangeError(`Retry delay must be nonnegative and resolve before year 10000, received "${duration}"`)
    }
    return milliseconds
}

class RetryClassificationError extends Error {
    constructor(cause: unknown) {
        super(`Retry classifier failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
        this.name = "RetryClassificationError"
    }
}

const maximumWakeAt = Date.parse("9999-12-31T23:59:59.999Z")
const RetryDecisionSchema = z.discriminatedUnion("retry", [
    z.object({ retry: z.literal(false) }).strict(),
    z.object({ retry: z.literal(true), delay: z.custom<StringValue>(value => typeof value === "string").optional() }).strict()
])

export type RetryDecision = { readonly retry: false } | { readonly retry: true; readonly delay?: StringValue }
export type RetryPolicy = {
    readonly classify: (error: unknown) => RetryDecision
    readonly maxAttempts?: number
    readonly initialDelay?: StringValue
    readonly backoffMultiplier?: number
    readonly maxDelay?: StringValue
    readonly jitter?: boolean
}

type ClassifyAttemptParams = {
    readonly error: unknown
    readonly policy: RetryPolicy
    readonly snapshot: RetryPolicySnapshot
    readonly attempt: number
    readonly failedAt: number
}
type ClassifiedAttempt = { readonly error: unknown; readonly decision: StepAttemptFailedEvent["decision"] }
