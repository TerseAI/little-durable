import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { defineWorkflow, sleep, step } from "little-durable"
import type { WorkflowDefinition } from "little-durable"
import { z } from "zod"

export function createDelayedOrderFollowUpWorkflow({ resultDirectory }: CreateDelayedOrderFollowUpWorkflowOptions): WorkflowDefinition<typeof FollowUpInputSchema> {
    return defineWorkflow({
        name: "delayed-order-follow-up",
        input: FollowUpInputSchema,
        run: async input => {
            await step({
                name: "schedule-order-follow-up",
                input: {
                    orderId: input.orderId,
                    delayMs: input.delayMs
                },
                run: async ({ orderId, delayMs }) => ({
                    orderId,
                    delayMs,
                    scheduledAt: new Date().toISOString()
                })
            })

            await sleep(`${input.delayMs}ms`)

            await step({
                name: "send-order-follow-up",
                input: {
                    orderId: input.orderId,
                    customerEmail: input.customerEmail,
                    resultDirectory
                },
                run: recordFollowUp
            })
        }
    })
}

async function recordFollowUp(input: RecordFollowUpInput): Promise<RecordFollowUpOutput> {
    const resultPath = join(input.resultDirectory, `${input.orderId}.json`)
    const result = {
        orderId: input.orderId,
        customerEmail: input.customerEmail,
        status: "follow-up-sent"
    }

    await mkdir(input.resultDirectory, { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")

    return { resultPath }
}

const FollowUpInputSchema = z
    .object({
        orderId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        customerEmail: z.string().email(),
        delayMs: z.number().int().positive()
    })
    .strict()

type CreateDelayedOrderFollowUpWorkflowOptions = {
    readonly resultDirectory: string
}

type RecordFollowUpInput = {
    readonly orderId: string
    readonly customerEmail: string
    readonly resultDirectory: string
}

type RecordFollowUpOutput = {
    readonly resultPath: string
}
