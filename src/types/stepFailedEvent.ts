import { z } from "zod"
import { RetryStopReasonSchema } from "./stepAttemptFailedEvent.js"

export const StepFailedEventSchema = z
    .object({
        eventId: z.string(),
        type: z.literal("step.failed"),
        stepId: z.string(),
        name: z.string().min(1),
        failedAt: z.iso.datetime(),
        attempt: z.number().int().positive().optional(),
        reason: RetryStopReasonSchema.optional(),
        error: z
            .object({
                name: z.string(),
                message: z.string()
            })
            .strict()
    })
    .strict()

export type StepFailedEvent = z.infer<typeof StepFailedEventSchema>
