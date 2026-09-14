import { z } from "zod"

export const RetryPolicySnapshotSchema = z
    .object({
        budgetId: z.string().uuid(),
        maxAttempts: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        initialDelayMs: z.number().positive().finite(),
        backoffMultiplier: z.number().min(1).finite(),
        maxDelayMs: z.number().positive().finite(),
        jitter: z.boolean()
    })
    .strict()

export type RetryPolicySnapshot = z.infer<typeof RetryPolicySnapshotSchema>
