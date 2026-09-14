import { HookRequestEnvelopeSchema } from "../types/hookRequestEnvelope.js"
import type { HookRequestEnvelope } from "../types/hookRequestEnvelope.js"
import type { JournalEvent } from "../types/journalEvent.js"
import type { JournalStore } from "../types/journalStore.js"
import { RuntimeEventSchema } from "../types/runtimeEvent.js"
import type { RuntimeEvent } from "../types/runtimeEvent.js"
import type { RuntimeError } from "../types/runtimeOutcome.js"
import type { Suspension } from "../types/runtimeOutcome.js"
import { createRunEventId } from "../types/runEventId.js"
import { createStepEventId } from "../types/stepEventId.js"
import { createWaitEventId } from "../types/waitEventId.js"

import { RuntimeEventStream } from "./runtimeEventStream.js"

export class RuntimeEvents {
    readonly stream: RuntimeEventStream

    private readonly context: RuntimeEventContext
    private controller!: ReadableStreamDefaultController<RuntimeEvent>
    private closed = false

    constructor({ runId, journalStore }: RuntimeEventsOptions) {
        this.context = {
            runId,
            journalStore,
            stepStartedAt: new Map(),
            hookRequests: new Map()
        }
        this.stream = new RuntimeEventStream({
            start: controller => {
                this.controller = controller
            },
            cancel: () => {
                this.closed = true
            }
        })
    }

    async observe(event: JournalEvent): Promise<void> {
        const projectedEvent = await projectJournalEvent(event, this.context)
        if (projectedEvent) this.emit(projectedEvent)
    }

    suspend(suspension: Suspension): void {
        this.emit(
            RuntimeEventSchema.parse({
                type: "runtime.suspended",
                runId: this.context.runId,
                suspension
            })
        )
    }

    resume(workflowName: string, resumedAt: string): void {
        this.emit(
            RuntimeEventSchema.parse({
                type: "runtime.resumed",
                runId: this.context.runId,
                workflowName,
                resumedAt
            })
        )
    }

    async fail({ error, failedAt }: RuntimeFailure): Promise<void> {
        this.emit(
            RuntimeEventSchema.parse({
                type: "runtime.failed",
                runId: this.context.runId,
                failedAt,
                durationMs: Date.parse(failedAt) - (await getRuntimeStartedAt(this.context)),
                error
            })
        )
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.controller.close()
    }

    error(error: unknown): void {
        if (this.closed) return
        this.closed = true
        this.controller.error(error)
    }

    private emit(event: RuntimeEvent): void {
        if (this.closed) return
        this.controller.enqueue(event)
    }
}

async function projectJournalEvent(event: JournalEvent, context: RuntimeEventContext): Promise<RuntimeEvent | undefined> {
    switch (event.type) {
        case "run.started":
            context.runtimeStartedAt = Date.parse(event.startedAt)
            return RuntimeEventSchema.parse({
                type: "runtime.started",
                runId: context.runId,
                workflowName: event.workflowName,
                startedAt: event.startedAt
            })

        case "run.completed":
            return RuntimeEventSchema.parse({
                type: "runtime.completed",
                runId: context.runId,
                completedAt: event.completedAt,
                durationMs: Date.parse(event.completedAt) - (await getRuntimeStartedAt(context))
            })

        case "step.started":
            context.stepStartedAt.set(event.stepId, Date.parse(event.startedAt))
            return RuntimeEventSchema.parse({
                type: "step.started",
                runId: context.runId,
                stepId: event.stepId,
                name: event.name,
                startedAt: event.startedAt
            })

        case "step.completed":
            return RuntimeEventSchema.parse({
                type: "step.completed",
                runId: context.runId,
                stepId: event.stepId,
                name: event.name,
                completedAt: event.completedAt,
                durationMs: Date.parse(event.completedAt) - (await getStepStartedAt(event.stepId, context))
            })

        case "step.failed":
            return RuntimeEventSchema.parse({
                type: "step.failed",
                runId: context.runId,
                stepId: event.stepId,
                name: event.name,
                failedAt: event.failedAt,
                durationMs: Date.parse(event.failedAt) - (await getStepStartedAt(event.stepId, context)),
                error: event.error
            })

        case "wait.requested": {
            const request = HookRequestEnvelopeSchema.parse(event.request)
            context.hookRequests.set(event.waitId, request)
            return RuntimeEventSchema.parse({
                type: "hook.requested",
                runId: context.runId,
                waitId: event.waitId,
                name: request.name,
                requestedAt: event.requestedAt,
                request: request.payload
            })
        }

        case "wait.resolved": {
            const request = await getHookRequest(event.waitId, context)
            return RuntimeEventSchema.parse({
                type: "hook.resolved",
                runId: context.runId,
                waitId: event.waitId,
                name: request.name,
                resolvedAt: event.resolvedAt,
                resolution: event.payload
            })
        }

        default: {
            const exhaustiveCheck: never = event
            return exhaustiveCheck
        }
    }
}

async function getRuntimeStartedAt(context: RuntimeEventContext): Promise<number> {
    if (context.runtimeStartedAt !== undefined) return context.runtimeStartedAt

    const event = await context.journalStore.get({
        runId: context.runId,
        eventId: createRunEventId({ type: "run.started" })
    })

    if (event?.type !== "run.started") throw new Error(`Run "${context.runId}" has no start event`)
    return Date.parse(event.startedAt)
}

async function getStepStartedAt(stepId: string, context: RuntimeEventContext): Promise<number> {
    const startedAt = context.stepStartedAt.get(stepId)
    if (startedAt !== undefined) return startedAt

    const event = await context.journalStore.get({
        runId: context.runId,
        eventId: createStepEventId({ type: "step.started", stepId })
    })

    if (event?.type !== "step.started") throw new Error(`Step "${stepId}" has no start event`)
    return Date.parse(event.startedAt)
}

async function getHookRequest(waitId: string, context: RuntimeEventContext): Promise<HookRequestEnvelope> {
    const cachedRequest = context.hookRequests.get(waitId)
    if (cachedRequest) return cachedRequest

    const event = await context.journalStore.get({
        runId: context.runId,
        eventId: createWaitEventId({ type: "wait.requested", waitId })
    })

    if (event?.type !== "wait.requested") throw new Error(`Wait "${waitId}" has no request event`)
    const request = HookRequestEnvelopeSchema.parse(event.request)
    context.hookRequests.set(waitId, request)
    return request
}

type RuntimeEventsOptions = {
    readonly runId: string
    readonly journalStore: JournalStore
}

type RuntimeFailure = {
    readonly error: RuntimeError
    readonly failedAt: string
}

type RuntimeEventContext = {
    readonly runId: string
    readonly journalStore: JournalStore
    readonly stepStartedAt: Map<string, number>
    readonly hookRequests: Map<string, HookRequestEnvelope>
    runtimeStartedAt?: number
}
