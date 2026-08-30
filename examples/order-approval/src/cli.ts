import { resolve } from "node:path"

import { FileJournalStore, Runtime } from "little-durable"
import type { JournalEvent, RuntimeEvent, Suspension } from "little-durable"

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

    printHeading("Starting order approval")
    printDetails([
        ["Run ID", runId],
        ["Customer", "ada@example.com"],
        ["Items", "3"],
        ["Total", formatCurrency(totalCents)]
    ])
    const events = runtime.start(workflow, {
        runId,
        input: {
            orderId: runId,
            customerEmail: "ada@example.com",
            itemCount: 3,
            totalCents
        }
    })

    await printRuntimeEventStream(events)
}

async function resolveApproval(args: readonly string[], approved: boolean): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const decidedBy = args[1] ?? "local-reviewer"
    const [suspension, journalEvents] = await Promise.all([runtime.getSuspension({ runId }), journalStore.list({ runId })])

    if (!suspension) {
        printHeading("Nothing to resolve")
        printDetails([
            ["Run ID", runId],
            ["Status", "No active approval request"]
        ])
        return
    }

    printHeading("Resuming order approval")
    printDetails([["Run ID", runId]])
    printJournalHistory(journalEvents)

    console.log(`\n${color.yellow("──────── Approval received ────────")}`)
    printDetails([
        ["Decision", approved ? "Approve" : "Reject"],
        ["Reviewer", decidedBy],
        ["Wait ID", suspension.waitId]
    ])

    const events = runtime.resumeHook(OrderApprovalHook, {
        runId,
        workflow,
        waitId: suspension.waitId,
        resolution: { approved, decidedBy }
    })

    await printRuntimeEventStream(events, "New runtime event stream")
}

async function showStatus(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const [run, suspension, events] = await Promise.all([runtime.getRun({ runId }), runtime.getSuspension({ runId }), journalStore.list({ runId })])
    const status = suspension ? "Waiting for approval" : events.some(event => event.type === "run.completed") ? "Completed" : "Running"

    printHeading("Run status")
    printDetails([
        ["Run ID", run.runId],
        ["Workflow", run.workflowName],
        ["Status", status],
        ["Started", run.startedAt],
        ["Journal events", String(events.length)]
    ])

    if (suspension) printSuspension(runId, suspension)
}

async function showJournal(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    console.log(JSON.stringify(await journalStore.list({ runId }), null, 2))
}

async function printRuntimeEventStream(events: AsyncIterable<RuntimeEvent>, title = "Runtime event stream"): Promise<void> {
    console.log(`\n${color.bold(title)}`)
    console.log(color.dim("  #   STEP ID                          EVENT                DETAILS"))

    let index = 0
    for await (const event of events) printRuntimeEvent(event, ++index)
}

function printJournalHistory(events: readonly JournalEvent[]): void {
    console.log(`\n${color.bold("Persisted journal · before approval")}`)
    console.log(color.dim("  #   STEP ID                          EVENT                DETAILS"))

    events.forEach((event, index) => printJournalEvent(event, index + 1))
}

function printJournalEvent(event: JournalEvent, index: number): void {
    switch (event.type) {
        case "run.started":
            printLedgerRow(index, event.type, event.workflowName, color.cyan)
            return
        case "run.completed":
            printLedgerRow(index, event.type, event.completedAt, color.green)
            return
        case "step.started":
        case "step.completed":
            printLedgerRow(index, event.type, event.name, event.type === "step.started" ? color.cyan : color.green, event.stepId)
            return
        case "step.failed":
            printLedgerRow(index, event.type, `${event.name} · ${event.error.message}`, color.red, event.stepId)
            return
        case "wait.requested":
            printLedgerRow(index, event.type, event.waitId, color.yellow)
            return
        case "wait.resolved":
            printLedgerRow(index, event.type, event.waitId, color.green)
    }
}

function printRuntimeEvent(event: RuntimeEvent, index: number): void {
    switch (event.type) {
        case "runtime.started":
            printLedgerRow(index, event.type, event.workflowName, color.cyan)
            return
        case "runtime.resumed":
            printLedgerRow(index, event.type, event.workflowName, color.cyan)
            return
        case "hook.requested":
            printLedgerRow(index, event.type, `${event.name} · waiting for resolution`, color.yellow)
            return
        case "hook.resolved":
            printLedgerRow(index, event.type, `${event.name} · resolution recorded`, color.green)
            return
        case "step.started":
            printLedgerRow(index, event.type, event.name, color.cyan, event.stepId)
            return
        case "step.completed":
            printLedgerRow(index, event.type, `${event.name} · ${formatDuration(event.durationMs)}`, color.green, event.stepId)
            return
        case "step.failed":
            printLedgerRow(index, event.type, `${event.name} · ${formatDuration(event.durationMs)} · ${event.error.message}`, color.red, event.stepId)
            return
        case "runtime.completed":
            printLedgerRow(index, event.type, `${formatDuration(event.durationMs)} total elapsed`, color.green)
            console.log()
            printDetails([["Result", resolve(dataDirectory, "results", `${event.runId}.json`)]])
            return
        case "runtime.suspended":
            printLedgerRow(index, event.type, `waiting for ${event.suspension.request.name}`, color.yellow)
            printSuspension(event.runId, event.suspension, false)
    }
}

function printLedgerRow(index: number, type: JournalEvent["type"] | RuntimeEvent["type"], details: string, paint: (value: string) => string, stepId?: string): void {
    const number = color.dim(String(index).padStart(2, "0"))
    const step = color.dim((stepId ?? "").padEnd(32))
    const eventType = paint(type.padEnd(20))
    console.log(`  ${number}  ${step} ${eventType} ${details}`)
}

function printSuspension(runId: string, suspension: Suspension, showHeading = true): void {
    if (showHeading) printHeading(color.yellow("⏸ Waiting for approval"))
    else console.log()

    if (suspension.request.name === OrderApprovalHook.name) {
        const request = OrderApprovalHook.request.parse(suspension.request.payload)
        printDetails([
            ["Order", request.orderId],
            ["Summary", request.summary],
            ["Total", formatCurrency(request.totalCents)],
            ["Wait ID", suspension.waitId]
        ])
    } else {
        printDetails([
            ["Hook", suspension.request.name],
            ["Wait ID", suspension.waitId]
        ])
    }

    console.log("\nNext")
    console.log(`  npm run workflow -- approve ${runId} Grace`)
    console.log(`  npm run workflow -- reject ${runId} Grace`)
}

function printHeading(title: string): void {
    console.log(`\n${color.bold(title)}`)
}

function printDetails(rows: readonly (readonly [label: string, value: string])[]): void {
    const labelWidth = Math.max(...rows.map(([label]) => label.length))
    for (const [label, value] of rows) console.log(`  ${label.padEnd(labelWidth)}  ${value}`)
}

function formatCurrency(totalCents: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(totalCents / 100)
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`
    const seconds = durationMs / 1000
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
}

const color = {
    bold: (value: string) => style(value, 1),
    dim: (value: string) => style(value, 2),
    red: (value: string) => style(value, 31),
    green: (value: string) => style(value, 32),
    yellow: (value: string) => style(value, 33),
    cyan: (value: string) => style(value, 36)
}

function style(value: string, code: number): string {
    if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined) return value
    return `\u001B[${code}m${value}\u001B[0m`
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
    console.log(`Little Durable · Order approval demo

Usage
  npm run workflow -- <command>

Commands
  start [run-id] [total-cents]     Start an order and wait for approval
  approve <run-id> [reviewer]      Approve a suspended order
  reject <run-id> [reviewer]       Reject a suspended order
  status <run-id>                  Show the current run status
  journal <run-id>                 Print the durable event journal

Try it
  npm run workflow -- start order-1001 12500`)
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

try {
    await main(process.argv.slice(2))
} catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof UsageError) showHelp()
    process.exitCode = 1
}
