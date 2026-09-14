import ms from "ms"
import type { StringValue } from "ms"

import { StepCompletedEvent } from "../types/stepCompletedEvent.js"
import { createStepEventId } from "../types/stepEventId.js"
import { StepFailedEvent } from "../types/stepFailedEvent.js"
import type { StepStartedEvent } from "../types/stepStartedEvent.js"

import { sleep } from "./sleep.js"
import { systemNow, toIsoString } from "./systemClock.js"
import { getWorkflowContext, runWithStepContext } from "./workflowContext.js"

export async function step<Input extends CanonicalValue, Output extends CanonicalValue>({ name, input, run, retry }: StepParams<Input, Output>): Promise<Output> {
    for (let attempt = 1; ; attempt++) {
        const shouldRetry = (error: unknown): boolean => retry !== undefined && attempt < (retry.maxAttempts ?? 3) && retry.shouldRetry(error)
        const result = await runAttempt({ name, input, run, shouldRetry })

        if (result.status === "completed") return result.output
        if (!result.retry || retry === undefined) throw result.error

        const delayMs = Math.min(ms(retry.maxDelay ?? "30s"), ms(retry.initialDelay ?? "1s") * (retry.backoffMultiplier ?? 2) ** (attempt - 1))
        await sleep(`${delayMs}ms`)
    }
}

async function runAttempt<Input extends CanonicalValue, Output extends CanonicalValue>({ name, input, run, shouldRetry }: RunAttemptParams<Input, Output>): Promise<AttemptResult<Output>> {
    const context = getWorkflowContext()

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

        return { status: "completed", output: existingCompletedEvent.output as Output }
    }

    const existingFailedEvent = await context.journalStore.get({
        runId: context.runId,
        eventId: createStepEventId({ type: "step.failed", stepId })
    })

    if (existingFailedEvent?.type === "step.failed") {
        context.logicalClock.advanceTo(Date.parse(existingFailedEvent.failedAt))

        const error = new Error(existingFailedEvent.error.message)
        error.name = existingFailedEvent.error.name
        return { status: "failed", error, retry: existingFailedEvent.retry === true }
    }

    const existingStartedEvent = await context.journalStore.get({
        runId: context.runId,
        eventId: createStepEventId({ type: "step.started", stepId })
    })

    if (!existingStartedEvent) {
        const startedAt = systemNow()
        const event: StepStartedEvent = {
            eventId: createStepEventId({ type: "step.started", stepId }),
            type: "step.started",
            stepId,
            name,
            startedAt: toIsoString(startedAt),
            input
        }

        await context.journalStore.append({
            runId: context.runId,
            event
        })
    }

    let value: Output
    try {
        value = await runWithStepContext(() => run(input))
    } catch (error) {
        const retry = shouldRetry(error)
        const failedAt = systemNow()
        const failedEvent: StepFailedEvent = {
            eventId: createStepEventId({ type: "step.failed", stepId }),
            type: "step.failed",
            stepId,
            name,
            failedAt: toIsoString(failedAt),
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
            ...(retry ? { retry } : {})
        }

        await context.journalStore.append({
            runId: context.runId,
            event: failedEvent
        })

        context.logicalClock.advanceTo(failedAt)

        return { status: "failed", error, retry }
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

    return { status: "completed", output: value }
}

// The event input field is the journal's canonical JSON value type.
type CanonicalValue = StepStartedEvent["input"]

export type StepParams<Input extends CanonicalValue, Output extends CanonicalValue> = {
    readonly name: string
    readonly input: Input
    readonly run: (input: Input) => Output | Promise<Output>
    readonly retry?: RetryPolicy
}

export type RetryPolicy = {
    readonly shouldRetry: (error: unknown) => boolean
    readonly maxAttempts?: number
    readonly initialDelay?: StringValue
    readonly backoffMultiplier?: number
    readonly maxDelay?: StringValue
}

type RunAttemptParams<Input extends CanonicalValue, Output extends CanonicalValue> = {
    readonly name: string
    readonly input: Input
    readonly run: (input: Input) => Output | Promise<Output>
    readonly shouldRetry: (error: unknown) => boolean
}

type AttemptResult<Output> = { readonly status: "completed"; readonly output: Output } | { readonly status: "failed"; readonly error: unknown; readonly retry: boolean }
