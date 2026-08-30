import { z } from "zod"

import { HookRequestEnvelopeSchema } from "./hookRequestEnvelope.js"

export const SuspensionSchema = z
    .object({
        waitId: z.string(),
        request: HookRequestEnvelopeSchema
    })
    .strict()

export const RuntimeCompletedOutcomeSchema = z
    .object({
        status: z.literal("completed")
    })
    .strict()

export const RuntimeErrorSchema = z
    .object({
        name: z.string(),
        message: z.string()
    })
    .strict()

export const RuntimeFailedOutcomeSchema = z
    .object({
        status: z.literal("failed"),
        error: RuntimeErrorSchema
    })
    .strict()

export const RuntimeSuspendedOutcomeSchema = z
    .object({
        status: z.literal("suspended"),
        suspension: SuspensionSchema
    })
    .strict()

export const RuntimeOutcomeSchema = z.discriminatedUnion("status", [RuntimeCompletedOutcomeSchema, RuntimeFailedOutcomeSchema, RuntimeSuspendedOutcomeSchema])

export type Suspension = z.infer<typeof SuspensionSchema>
export type RuntimeCompletedOutcome = z.infer<typeof RuntimeCompletedOutcomeSchema>
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>
export type RuntimeFailedOutcome = z.infer<typeof RuntimeFailedOutcomeSchema>
export type RuntimeSuspendedOutcome = z.infer<typeof RuntimeSuspendedOutcomeSchema>
export type RuntimeOutcome = z.infer<typeof RuntimeOutcomeSchema>
