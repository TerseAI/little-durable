import { z } from "zod"

import { RuntimeErrorSchema } from "./runtimeOutcome.js"

export const RetryStopReasonSchema = z.enum(["not-retryable", "attempts-exhausted", "classifier-failed", "invalid-operation"])

export const RetryScheduleSchema = z
    .object({
        type: z.literal("retry"),
        waitId: z.string(),
        delayMs: z.number().nonnegative().finite(),
        wakeAt: z.iso.datetime()
    })
    .strict()

export const StepAttemptFailedEventSchema = z
    .object({
        eventId: z.string(),
        type: z.literal("step.attempt.failed"),
        stepId: z.string(),
        name: z.string().min(1),
        attempt: z.number().int().positive(),
        failedAt: z.iso.datetime(),
        error: RuntimeErrorSchema,
        decision: z.discriminatedUnion("type", [RetryScheduleSchema, z.object({ type: z.literal("failed"), reason: RetryStopReasonSchema }).strict()])
    })
    .strict()

export type StepAttemptFailedEvent = z.infer<typeof StepAttemptFailedEventSchema>
export type RetrySchedule = z.infer<typeof RetryScheduleSchema>
