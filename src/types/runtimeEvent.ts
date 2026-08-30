import { z } from "zod"

import { RuntimeErrorSchema, SuspensionSchema } from "./runtimeOutcome.js"

export const RuntimeEventSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("runtime.started"),
            runId: z.string(),
            workflowName: z.string(),
            startedAt: z.iso.datetime()
        })
        .strict(),
    z
        .object({
            type: z.literal("runtime.resumed"),
            runId: z.string(),
            workflowName: z.string(),
            resumedAt: z.iso.datetime()
        })
        .strict(),
    z
        .object({
            type: z.literal("hook.requested"),
            runId: z.string(),
            waitId: z.string(),
            name: z.string(),
            requestedAt: z.iso.datetime(),
            request: z.json()
        })
        .strict(),
    z
        .object({
            type: z.literal("hook.resolved"),
            runId: z.string(),
            waitId: z.string(),
            name: z.string(),
            resolvedAt: z.iso.datetime(),
            resolution: z.json()
        })
        .strict(),
    z
        .object({
            type: z.literal("step.started"),
            runId: z.string(),
            stepId: z.string(),
            name: z.string(),
            startedAt: z.iso.datetime()
        })
        .strict(),
    z
        .object({
            type: z.literal("step.completed"),
            runId: z.string(),
            stepId: z.string(),
            name: z.string(),
            completedAt: z.iso.datetime(),
            durationMs: z.number().nonnegative()
        })
        .strict(),
    z
        .object({
            type: z.literal("step.failed"),
            runId: z.string(),
            stepId: z.string(),
            name: z.string(),
            failedAt: z.iso.datetime(),
            durationMs: z.number().nonnegative(),
            error: z
                .object({
                    name: z.string(),
                    message: z.string()
                })
                .strict()
        })
        .strict(),
    z
        .object({
            type: z.literal("runtime.suspended"),
            runId: z.string(),
            suspension: SuspensionSchema
        })
        .strict(),
    z
        .object({
            type: z.literal("runtime.failed"),
            runId: z.string(),
            failedAt: z.iso.datetime(),
            durationMs: z.number().nonnegative(),
            error: RuntimeErrorSchema
        })
        .strict(),
    z
        .object({
            type: z.literal("runtime.completed"),
            runId: z.string(),
            completedAt: z.iso.datetime(),
            durationMs: z.number().nonnegative()
        })
        .strict()
])

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>
