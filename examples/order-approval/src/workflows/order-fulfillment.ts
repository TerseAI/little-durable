import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { defineWorkflow, step } from "little-durable"
import type { WorkflowDefinition } from "little-durable"
import { z } from "zod"

export function createOrderFulfillmentWorkflow({ recoveryDirectory, resultDirectory }: CreateOrderFulfillmentWorkflowOptions): WorkflowDefinition<typeof FulfillmentInputSchema> {
    return defineWorkflow({
        name: "order-fulfillment",
        input: FulfillmentInputSchema,
        run: async input => {
            const shipment = await step({
                name: "prepare-shipment",
                input: {
                    orderId: input.orderId,
                    packageCount: input.packageCount
                },
                run: async ({ orderId, packageCount }) => ({
                    shipmentId: `shipment-${orderId}`,
                    packageCount
                })
            })

            await step({
                name: "book-carrier-pickup",
                input: {
                    orderId: input.orderId,
                    customerEmail: input.customerEmail,
                    shipmentId: shipment.shipmentId,
                    packageCount: shipment.packageCount
                },
                run: booking => bookCarrierPickup(booking, { recoveryDirectory, resultDirectory })
            })
        }
    })
}

async function bookCarrierPickup(input: BookCarrierPickupInput, { recoveryDirectory, resultDirectory }: CarrierGatewayOptions): Promise<BookCarrierPickupOutput> {
    const recoveryMarker = join(recoveryDirectory, `${input.orderId}.ready`)
    await mkdir(recoveryDirectory, { recursive: true })

    try {
        await writeFile(recoveryMarker, "Carrier API recovers on the next attempt.\n", {
            encoding: "utf8",
            flag: "wx"
        })
    } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error

        const trackingNumber = `LD-${input.orderId.toUpperCase()}`
        const resultPath = join(resultDirectory, `${input.orderId}.json`)
        const result = {
            orderId: input.orderId,
            customerEmail: input.customerEmail,
            shipmentId: input.shipmentId,
            packageCount: input.packageCount,
            carrier: "Parcel Express",
            trackingNumber,
            status: "pickup-booked"
        }

        await mkdir(resultDirectory, { recursive: true })
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
        return { resultPath, trackingNumber }
    }

    throw new Error("Carrier API unavailable (simulated transient failure)")
}

const FulfillmentInputSchema = z
    .object({
        orderId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        customerEmail: z.string().email(),
        packageCount: z.number().int().positive()
    })
    .strict()

type CreateOrderFulfillmentWorkflowOptions = {
    readonly recoveryDirectory: string
    readonly resultDirectory: string
}

type BookCarrierPickupInput = {
    readonly orderId: string
    readonly customerEmail: string
    readonly shipmentId: string
    readonly packageCount: number
}

type CarrierGatewayOptions = {
    readonly recoveryDirectory: string
    readonly resultDirectory: string
}

type BookCarrierPickupOutput = {
    readonly resultPath: string
    readonly trackingNumber: string
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
    return value instanceof Error && "code" in value
}
