import type { StepAttemptFailedEvent } from "../types/stepAttemptFailedEvent.js"
import { createStepEventId } from "../types/stepEventId.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

import { classifyAttempt } from "./retryPolicy.js"
import type { RetryPolicy } from "./retryPolicy.js"
import { systemNow, toIsoString } from "./systemClock.js"
import { TimerHook } from "./timerHook.js"
import { waitForRequest } from "./waitFor.js"
import { getWorkflowContext, runWithStepContext } from "./workflowContext.js"

export async function runRetryStep<Output>({ started, policy, run }: RunRetryStepParams<Output>): Promise<Output> {
    const context = getWorkflowContext()
    const snapshot = started.retry
    if (!snapshot) throw new Error("Retry step requires a persisted retry policy")
    const failures = (await context.journalStore.listByType({ runId: context.runId, eventType: "step.attempt.failed" })).filter(
        (event): event is StepAttemptFailedEvent => event.type === "step.attempt.failed" && event.stepId === started.stepId
    )
    const previous = failures.at(-1)
    if (previous) {
        context.logicalClock.advanceTo(Date.parse(previous.failedAt))
        if (previous.decision.type === "failed") {
            await recordTerminalFailure(previous)
            const error = new Error(previous.error.message)
            error.name = previous.error.name
            throw error
        }
        await waitForRetry(previous)
    }

    let value: Output
    try {
        value = await runWithStepContext(run, true)
    } catch (error) {
        const failedAt = systemNow()
        const attempt = (previous?.attempt ?? 0) + 1
        const classified = runWithStepContext(() => classifyAttempt({ error, policy, snapshot, attempt, failedAt }), true)
        const failure: StepAttemptFailedEvent = {
            eventId: `step.attempt.failed:${started.stepId}:${snapshot.budgetId}:${attempt}`,
            type: "step.attempt.failed",
            stepId: started.stepId,
            name: started.name,
            attempt,
            failedAt: toIsoString(failedAt),
            error: normalizeError(classified.error),
            decision: classified.decision
        }
        // One append commits the error and classification before any timer writes.
        await context.journalStore.append({ runId: context.runId, event: failure })
        context.logicalClock.advanceTo(failedAt)
        if (failure.decision.type === "failed") {
            await recordTerminalFailure(failure)
            throw classified.error
        }
        await waitForRetry(failure)
        throw new Error("A newly scheduled retry cannot already be resolved")
    }
    return value
}

async function waitForRetry(failure: StepAttemptFailedEvent): Promise<void> {
    if (failure.decision.type !== "retry") throw new Error("Cannot schedule a terminal attempt")
    await waitForRequest({
        waitId: failure.decision.waitId,
        request: { type: "hook", name: TimerHook.name, payload: { wakeAt: failure.decision.wakeAt } }
    })
}

async function recordTerminalFailure(failure: StepAttemptFailedEvent): Promise<void> {
    if (failure.decision.type !== "failed") throw new Error("Cannot finalize a retryable attempt")
    const context = getWorkflowContext()
    const eventId = createStepEventId({ type: "step.failed", stepId: failure.stepId })
    if (await context.journalStore.get({ runId: context.runId, eventId })) return
    await context.journalStore.append({
        runId: context.runId,
        event: {
            eventId,
            type: "step.failed",
            stepId: failure.stepId,
            name: failure.name,
            failedAt: failure.failedAt,
            attempt: failure.attempt,
            reason: failure.decision.reason,
            error: failure.error
        }
    })
}

function normalizeError(error: unknown): StepAttemptFailedEvent["error"] {
    return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }
}

type RunRetryStepParams<Output> = {
    readonly started: StepStartedEvent
    readonly policy: RetryPolicy
    readonly run: () => Output | Promise<Output>
}
