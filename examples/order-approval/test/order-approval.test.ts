import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import { FileJournalStore, Runtime } from "little-durable"
import type { WorkflowDefinition } from "little-durable"
import { z } from "zod"

import { createDelayedOrderFollowUpWorkflow } from "../src/workflows/delayed-order-follow-up.js"
import { OrderApprovalHook, createOrderApprovalWorkflow } from "../src/workflows/order-approval.js"

test("suspends for approval, resumes, and reuses the completed preparation step", async t => {
    const directory = await mkdtemp(join(tmpdir(), "little-durable-order-approval-"))
    t.after(async () => rm(directory, { recursive: true, force: true }))

    const journalStore = new FileJournalStore(join(directory, "journals"))
    const workflow = createOrderApprovalWorkflow({ resultDirectory: join(directory, "results") })
    const runId = "order-1001"

    const runtimeEvents = []

    for await (const event of new Runtime({ journalStore }).start(workflow, {
        runId,
        input: {
            orderId: "order-1001",
            customerEmail: "ada@example.com",
            itemCount: 3,
            totalCents: 12500
        }
    })) {
        runtimeEvents.push(event)
    }

    assert.deepEqual(
        runtimeEvents.map(event => event.type),
        ["runtime.started", "step.started", "step.completed", "hook.requested", "runtime.suspended"]
    )

    const suspendedEvent = runtimeEvents.at(-1)
    if (suspendedEvent?.type !== "runtime.suspended") throw new Error("Expected the workflow to suspend")

    assert.equal(suspendedEvent.suspension.request.name, "order-approval")
    assert.equal((await journalStore.listByType({ runId, eventType: "step.completed" })).length, 1)

    const resumedEvents = []

    for await (const event of new Runtime({ journalStore }).resumeHook(OrderApprovalHook, {
        runId,
        workflow,
        waitId: suspendedEvent.suspension.waitId,
        resolution: {
            approved: true,
            decidedBy: "Grace"
        }
    })) {
        resumedEvents.push(event)
    }

    assert.deepEqual(
        resumedEvents.map(event => event.type),
        ["hook.resolved", "runtime.resumed", "step.started", "step.completed", "runtime.completed"]
    )
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
    const completedEvents = []
    for await (const event of new Runtime({ journalStore }).resume(workflow, { runId })) completedEvents.push(event)
    assert.deepEqual(
        completedEvents.map(event => event.type),
        ["runtime.completed"]
    )
    assert.equal((await journalStore.list({ runId })).length, eventCount)
})

test("resolves a sleeping workflow by name and resumes its timer", async t => {
    const directory = await mkdtemp(join(tmpdir(), "little-durable-delayed-follow-up-"))
    t.after(async () => rm(directory, { recursive: true, force: true }))

    const journalStore = new FileJournalStore(join(directory, "journals"))
    const workflow = createDelayedOrderFollowUpWorkflow({ resultDirectory: join(directory, "results") })
    const workflowsByName = new Map<string, WorkflowDefinition>([[workflow.name, workflow]])
    const runtime = new Runtime({ journalStore })
    const runId = "follow-up-1001"
    const startEvents = []

    for await (const event of runtime.start(workflow, {
        runId,
        input: {
            orderId: runId,
            customerEmail: "ada@example.com",
            delayMs: 20
        }
    })) {
        startEvents.push(event)
    }

    assert.deepEqual(
        startEvents.map(event => event.type),
        ["runtime.started", "step.started", "step.completed", "hook.requested", "runtime.suspended"]
    )

    const suspendedEvent = startEvents.at(-1)
    if (suspendedEvent?.type !== "runtime.suspended") throw new Error("Expected the workflow to suspend")
    assert.equal(suspendedEvent.suspension.request.name, "timer")

    const run = await runtime.getRun({ runId })
    const resolvedWorkflow = workflowsByName.get(run.workflowName)
    if (!resolvedWorkflow) throw new Error(`Workflow "${run.workflowName}" is not registered`)

    await delay(35)

    const resumedEvents = []
    for await (const event of runtime.resumeTimer(resolvedWorkflow, {
        runId,
        waitId: suspendedEvent.suspension.waitId
    })) {
        resumedEvents.push(event)
    }

    assert.deepEqual(
        resumedEvents.map(event => event.type),
        ["hook.resolved", "runtime.resumed", "step.started", "step.completed", "runtime.completed"]
    )

    const result = DelayedFollowUpResultSchema.parse(JSON.parse(await readFile(join(directory, "results", `${runId}.json`), "utf8")) as unknown)
    assert.deepEqual(result, {
        orderId: runId,
        customerEmail: "ada@example.com",
        status: "follow-up-sent"
    })
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

const DelayedFollowUpResultSchema = z
    .object({
        orderId: z.string(),
        customerEmail: z.string().email(),
        status: z.literal("follow-up-sent")
    })
    .strict()
