import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { FileJournalStore, Runtime } from "little-durable"
import { z } from "zod"

import { OrderApprovalHook, createOrderApprovalWorkflow } from "../src/workflows/order-approval.js"

test("suspends for approval, resumes, and reuses the completed preparation step", async t => {
    const directory = await mkdtemp(join(tmpdir(), "little-durable-order-approval-"))
    t.after(async () => rm(directory, { recursive: true, force: true }))

    const journalStore = new FileJournalStore(join(directory, "journals"))
    const workflow = createOrderApprovalWorkflow({ resultDirectory: join(directory, "results") })
    const runId = "order-1001"

    const firstOutcome = await new Runtime({ journalStore }).start(workflow, {
        runId,
        input: {
            orderId: "order-1001",
            customerEmail: "ada@example.com",
            itemCount: 3,
            totalCents: 12500
        }
    })

    assert.equal(firstOutcome.status, "suspended")
    if (firstOutcome.status !== "suspended") throw new Error("Expected the workflow to suspend")

    assert.equal(firstOutcome.suspension.request.name, "order-approval")
    assert.equal((await journalStore.listByType({ runId, eventType: "step.completed" })).length, 1)

    const resumedOutcome = await new Runtime({ journalStore }).resumeHook(OrderApprovalHook, {
        runId,
        workflow,
        waitId: firstOutcome.suspension.waitId,
        resolution: {
            approved: true,
            decidedBy: "Grace"
        }
    })

    assert.deepEqual(resumedOutcome, { status: "completed" })
    assert.equal((await journalStore.listByType({ runId, eventType: "step.completed" })).length, 2)
    assert.equal((await journalStore.listByType({ runId, eventType: "wait.resolved" })).length, 1)

    const result = OrderResultSchema.parse(JSON.parse(await readFile(join(directory, "results", "order-1001.json"), "utf8")) as unknown)
    assert.deepEqual(result, {
        orderId: "order-1001",
        customerEmail: "ada@example.com",
        summary: "3 item(s), $125.00",
        status: "approved",
        decidedBy: "Grace"
    })

    const eventCount = (await journalStore.list({ runId })).length
    assert.deepEqual(await new Runtime({ journalStore }).resume(workflow, { runId }), { status: "completed" })
    assert.equal((await journalStore.list({ runId })).length, eventCount)
})

const OrderResultSchema = z
    .object({
        orderId: z.string(),
        customerEmail: z.string().email(),
        summary: z.string(),
        status: z.enum(["approved", "rejected"]),
        decidedBy: z.string()
    })
    .strict()
