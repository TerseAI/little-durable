import { StepCompletedEvent } from "../types/stepCompletedEvent.js"
import { createStepEventId } from "../types/stepEventId.js"
import { StepFailedEvent } from "../types/stepFailedEvent.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

import { normalizeRetryPolicy } from "./retryPolicy.js"
import type { RetryPolicy } from "./retryPolicy.js"
import { runRetryStep } from "./retryStep.js"
import { systemNow, toIsoString } from "./systemClock.js"
import { assertDurableOperationAllowed, DurableOperationError, getWorkflowContext, runWithStepContext } from "./workflowContext.js"

export async function step<Input extends CanonicalValue, Output extends CanonicalValue>({ name, input, run, retry }: StepParams<Input, Output>): Promise<Output> {
    const context = getWorkflowContext()
    assertDurableOperationAllowed()
    if (retry && context.phase === "step") throw new DurableOperationError("Retry-enabled steps cannot be nested inside another step")

    const stepId = context.idGenerator.next({ namespace: "step" })

    const existingCompletedEvent = await context.journalStore.get({
        runId: context.runId,
        eventId: createStepEventId({ type: "step.completed", stepId })
    })

    if (existingCompletedEvent?.type === "step.completed") {
        const existingStartedEvent = await context.journalStore.get({
            runId: context.runId,
            eventId: createStepEventId({ type: "step.started", stepId })
        })

        if (existingStartedEvent?.type !== "step.started") {
            throw new Error(`Step "${stepId}" completed without a matching step.started event`)
        }

        if (existingStartedEvent.name !== name) {
            throw new Error(`Step "${stepId}" was previously recorded as "${existingStartedEvent.name}", not "${name}"`)
        }

        context.logicalClock.advanceTo(Date.parse(existingCompletedEvent.completedAt))
        return existingCompletedEvent.output as Output
    }

    const existingStartedEvent = await context.journalStore.get({
        runId: context.runId,
        eventId: createStepEventId({ type: "step.started", stepId })
    })

    let started: StepStartedEvent
    if (existingStartedEvent) {
        if (existingStartedEvent.type !== "step.started" || existingStartedEvent.name !== name) throw new Error(`Step "${stepId}" does not match its recorded start`)
        started = existingStartedEvent
    } else {
        const startedAt = systemNow()
        const event: StepStartedEvent = {
            eventId: createStepEventId({ type: "step.started", stepId }),
            type: "step.started",
            stepId,
            name,
            startedAt: toIsoString(startedAt),
            input,
            ...(retry ? { retry: normalizeRetryPolicy(retry) } : {})
        }

        await context.journalStore.append({
            runId: context.runId,
            event
        })
        started = event
    }

    if (started.retry && !retry) throw new Error(`Step "${name}" has a pending retry policy; its classifier must remain available`)

    let value: Output
    try {
        value = started.retry && retry ? await runRetryStep({ started, policy: retry, run: () => run(input) }) : await runWithStepContext(() => run(input))
    } catch (error) {
        if (started.retry) throw error
        const failedAt = systemNow()
        const failedEvent: StepFailedEvent = {
            eventId: createStepEventId({ type: "step.failed", stepId }),
            type: "step.failed",
            stepId,
            name,
            failedAt: toIsoString(failedAt),
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }
        }

        await context.journalStore.append({
            runId: context.runId,
            event: failedEvent
        })

        context.logicalClock.advanceTo(failedAt)

        throw error
    }

    const completedAt = systemNow()
    const completedEvent: StepCompletedEvent = {
        eventId: createStepEventId({ type: "step.completed", stepId }),
        type: "step.completed",
        stepId,
        name,
        completedAt: toIsoString(completedAt),
        output: value
    }

    await context.journalStore.append({
        runId: context.runId,
        event: completedEvent
    })

    context.logicalClock.advanceTo(completedAt)

    return value
}

// The event input field is the journal's canonical JSON value type.
type CanonicalValue = StepStartedEvent["input"]

export type StepParams<Input extends CanonicalValue, Output extends CanonicalValue> = {
    readonly name: string
    readonly input: Input
    readonly run: (input: Input) => Output | Promise<Output>
    readonly retry?: RetryPolicy
}
