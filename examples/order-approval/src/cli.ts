import { resolve } from "node:path"

import { FileJournalStore, Runtime } from "little-durable"
import type { RuntimeOutcome } from "little-durable"

import { OrderApprovalHook, createOrderApprovalWorkflow } from "./workflows/order-approval.js"

async function main(args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args

    switch (command) {
        case "start":
            await startWorkflow(commandArgs)
            return
        case "approve":
            await resolveApproval(commandArgs, true)
            return
        case "reject":
            await resolveApproval(commandArgs, false)
            return
        case "status":
            await showStatus(commandArgs)
            return
        case "journal":
            await showJournal(commandArgs)
            return
        case "help":
        case undefined:
            showHelp()
            return
        default:
            throw new UsageError(`Unknown command: ${command}`)
    }
}

async function startWorkflow(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? "order-run-001"
    const totalCents = parsePositiveInteger(args[1] ?? "12500", "total-cents")
    const outcome = await runtime.start(workflow, {
        runId,
        input: {
            orderId: runId,
            customerEmail: "ada@example.com",
            itemCount: 3,
            totalCents
        }
    })

    printOutcome(runId, outcome)
}

async function resolveApproval(args: readonly string[], approved: boolean): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const decidedBy = args[1] ?? "local-reviewer"
    const suspension = await runtime.getSuspension({ runId })

    if (!suspension) {
        console.log(`Run ${runId} has no active approval request.`)
        return
    }

    const outcome = await runtime.resumeHook(OrderApprovalHook, {
        runId,
        workflow,
        waitId: suspension.waitId,
        resolution: { approved, decidedBy }
    })

    printOutcome(runId, outcome)
}

async function showStatus(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const [run, suspension, events] = await Promise.all([runtime.getRun({ runId }), runtime.getSuspension({ runId }), journalStore.list({ runId })])

    console.log(
        JSON.stringify(
            {
                ...run,
                status: suspension ? "suspended" : events.some(event => event.type === "run.completed") ? "completed" : "running",
                suspension,
                eventCount: events.length
            },
            null,
            2
        )
    )
}

async function showJournal(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    console.log(JSON.stringify(await journalStore.list({ runId }), null, 2))
}

function printOutcome(runId: string, outcome: RuntimeOutcome): void {
    if (outcome.status === "completed") {
        console.log(`Run ${runId} completed. Result: ${resolve(dataDirectory, "results", `${runId}.json`)}`)
        return
    }

    console.log(`Run ${runId} suspended.`)
    console.log(JSON.stringify(outcome.suspension, null, 2))
}

function requireArgument(value: string | undefined, name: string): string {
    if (value) return value
    throw new UsageError(`Missing required argument: ${name}`)
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    throw new UsageError(`${name} must be a positive integer`)
}

function showHelp(): void {
    console.log(`Usage:
  npm run workflow -- start [run-id] [total-cents]
  npm run workflow -- approve <run-id> [reviewer]
  npm run workflow -- reject <run-id> [reviewer]
  npm run workflow -- status <run-id>
  npm run workflow -- journal <run-id>`)
}

class UsageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UsageError"
    }
}

const dataDirectory = resolve(process.env.DURABLE_SAMPLE_DATA_DIR ?? ".data")
const journalStore = new FileJournalStore(resolve(dataDirectory, "journals"))
const runtime = new Runtime({ journalStore })
const workflow = createOrderApprovalWorkflow({
    resultDirectory: resolve(dataDirectory, "results")
})

await main(process.argv.slice(2))
