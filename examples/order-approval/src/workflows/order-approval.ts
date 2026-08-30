import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { defineHook, defineWorkflow, step, waitFor } from "little-durable"
import type { WorkflowDefinition } from "little-durable"
import { z } from "zod"

export function createOrderApprovalWorkflow({ resultDirectory }: CreateOrderApprovalWorkflowOptions): WorkflowDefinition<typeof OrderInputSchema> {
    return defineWorkflow({
        name: "order-approval",
        input: OrderInputSchema,
        run: async input => {
            const prepared = await step({
                name: "prepare-order-summary",
                input: {
                    orderId: input.orderId,
                    itemCount: input.itemCount,
                    totalCents: input.totalCents
                },
                run: async ({ orderId, itemCount, totalCents }) => ({
                    orderId,
                    summary: `${itemCount} item(s), ${formatCurrency(totalCents)}`,
                    preparedAt: new Date().toISOString()
                })
            })

            const decision = await waitFor(OrderApprovalHook, {
                orderId: input.orderId,
                summary: prepared.summary,
                totalCents: input.totalCents
            })

            await step({
                name: "record-order-decision",
                input: {
                    orderId: input.orderId,
                    customerEmail: input.customerEmail,
                    summary: prepared.summary,
                    approved: decision.approved,
                    decidedBy: decision.decidedBy,
                    resultDirectory
                },
                run: recordOrderDecision
            })
        }
    })
}

export const OrderApprovalHook = defineHook({
    name: "order-approval",
    request: z
        .object({
            orderId: z.string(),
            summary: z.string(),
            totalCents: z.number().int().positive()
        })
        .strict(),
    resolution: z
        .object({
            approved: z.boolean(),
            decidedBy: z.string().min(1)
        })
        .strict()
})

async function recordOrderDecision(input: RecordOrderDecisionInput): Promise<RecordOrderDecisionOutput> {
    const status = input.approved ? "approved" : "rejected"
    const resultPath = join(input.resultDirectory, `${input.orderId}.json`)
    const result = {
        orderId: input.orderId,
        customerEmail: input.customerEmail,
        summary: input.summary,
        status,
        decidedBy: input.decidedBy
    }

    await mkdir(input.resultDirectory, { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")

    return { resultPath, status }
}

function formatCurrency(totalCents: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(totalCents / 100)
}

const OrderInputSchema = z
    .object({
        orderId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        customerEmail: z.string().email(),
        itemCount: z.number().int().positive(),
        totalCents: z.number().int().positive()
    })
    .strict()

type CreateOrderApprovalWorkflowOptions = {
    readonly resultDirectory: string
}

type RecordOrderDecisionInput = {
    readonly orderId: string
    readonly customerEmail: string
    readonly summary: string
    readonly approved: boolean
    readonly decidedBy: string
    readonly resultDirectory: string
}

type RecordOrderDecisionOutput = {
    readonly resultPath: string
    readonly status: "approved" | "rejected"
}
