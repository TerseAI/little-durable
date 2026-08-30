import { resolve } from "node:path"

import { FileJournalStore, Runtime } from "little-durable"
import type { JournalEvent, RuntimeEvent, Suspension, WorkflowDefinition } from "little-durable"
import { z } from "zod"

import { createDelayedOrderFollowUpWorkflow } from "./workflows/delayed-order-follow-up.js"
import { OrderApprovalHook, createOrderApprovalWorkflow } from "./workflows/order-approval.js"

async function main(args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args

    switch (command) {
        case "start":
            await startOrderApproval(commandArgs)
            return
        case "start-follow-up":
            await startDelayedFollowUp(commandArgs)
            return
        case "resume":
            await resumeWorkflow(commandArgs)
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

async function startOrderApproval(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? "order-run-001"
    const totalCents = parsePositiveInteger(args[1] ?? "12500", "total-cents")

    printHeading("Starting order approval")
    printDetails([
        ["Run ID", runId],
        ["Customer", "ada@example.com"],
        ["Items", "3"],
        ["Total", formatCurrency(totalCents)]
    ])
    const events = runtime.start(orderApprovalWorkflow, {
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

async function startDelayedFollowUp(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? "follow-up-run-001"
    const delayMs = parsePositiveInteger(args[1] ?? "3000", "delay-ms")

    printHeading("Starting delayed order follow-up")
    printDetails([
        ["Run ID", runId],
        ["Customer", "ada@example.com"],
        ["Sleep", formatDuration(delayMs)]
    ])

    const events = runtime.start(delayedOrderFollowUpWorkflow, {
        runId,
        input: {
            orderId: runId,
            customerEmail: "ada@example.com",
            delayMs
        }
    })

    const terminalEvent = await printRuntimeEventStream(events, "Runtime event stream", { showNextAction: false })

    if (terminalEvent?.type !== "runtime.suspended" || terminalEvent.suspension.request.name !== "timer") return

    const timer = TimerRequestSchema.parse(terminalEvent.suspension.request.payload)
    await waitForTimer(runId, timer.wakeAt)
    await resumeWorkflow([runId])
}

async function resolveApproval(args: readonly string[], approved: boolean): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const decidedBy = args[1] ?? "local-reviewer"
    const [registeredWorkflow, suspension, journalEvents] = await Promise.all([resolveWorkflow(runId), runtime.getSuspension({ runId }), journalStore.list({ runId })])

    if (registeredWorkflow.name !== orderApprovalWorkflow.name) {
        throw new UsageError(`Run ${runId} belongs to workflow "${registeredWorkflow.name}"; use the resume command instead`)
    }

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
        workflow: registeredWorkflow,
        waitId: suspension.waitId,
        resolution: { approved, decidedBy }
    })

    await printRuntimeEventStream(events, "New runtime event stream")
}

async function resumeWorkflow(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const [registeredWorkflow, suspension, journalEvents] = await Promise.all([resolveWorkflow(runId), runtime.getSuspension({ runId }), journalStore.list({ runId })])

    if (!suspension) {
        printHeading("Nothing to resume")
        printDetails([
            ["Run ID", runId],
            ["Workflow", registeredWorkflow.name],
            ["Status", "No active suspension"]
        ])
        return
    }

    if (suspension.request.name !== "timer") {
        throw new UsageError(`Run ${runId} is waiting for hook "${suspension.request.name}"; use its hook-specific command instead`)
    }

    const timer = TimerRequestSchema.parse(suspension.request.payload)
    const remainingMs = Date.parse(timer.wakeAt) - Date.now()

    if (remainingMs > 0) {
        printHeading("Timer is still sleeping")
        printDetails([
            ["Run ID", runId],
            ["Workflow", registeredWorkflow.name],
            ["Wake at", timer.wakeAt],
            ["Remaining", formatDuration(remainingMs)]
        ])
        return
    }

    printHeading("Resuming delayed workflow")
    printDetails([
        ["Run ID", runId],
        ["Workflow", registeredWorkflow.name]
    ])
    printJournalHistory(journalEvents, "Persisted journal · before timer resolution")

    console.log(`\n${color.yellow("──────── Timer elapsed ────────")}`)
    printDetails([
        ["Wake at", timer.wakeAt],
        ["Wait ID", suspension.waitId]
    ])

    const events = runtime.resumeTimer(registeredWorkflow, {
        runId,
        waitId: suspension.waitId
    })

    await printRuntimeEventStream(events, "New runtime event stream")
}

async function showStatus(args: readonly string[]): Promise<void> {
    const runId = requireArgument(args[0], "run-id")
    const [run, suspension, events] = await Promise.all([runtime.getRun({ runId }), runtime.getSuspension({ runId }), journalStore.list({ runId })])
    const status = suspension
        ? suspension.request.name === "timer"
            ? "Sleeping"
            : `Waiting for ${suspension.request.name}`
        : events.some(event => event.type === "run.completed")
          ? "Completed"
          : "Running"

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

async function printRuntimeEventStream(
    events: AsyncIterable<RuntimeEvent>,
    title = "Runtime event stream",
    { showNextAction = true }: PrintRuntimeEventStreamOptions = {}
): Promise<RuntimeEvent | undefined> {
    console.log(`\n${color.bold(title)}`)
    console.log(color.dim("  #   STEP ID                          EVENT                DETAILS"))

    let index = 0
    let terminalEvent: RuntimeEvent | undefined

    for await (const event of events) {
        printRuntimeEvent(event, ++index, showNextAction)
        if (event.type === "runtime.completed" || event.type === "runtime.suspended") terminalEvent = event
    }

    return terminalEvent
}

function printJournalHistory(events: readonly JournalEvent[], title = "Persisted journal · before approval"): void {
    console.log(`\n${color.bold(title)}`)
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

function printRuntimeEvent(event: RuntimeEvent, index: number, showNextAction: boolean): void {
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
            printSuspension(event.runId, event.suspension, false, showNextAction)
    }
}

function printLedgerRow(index: number, type: JournalEvent["type"] | RuntimeEvent["type"], details: string, paint: (value: string) => string, stepId?: string): void {
    const number = color.dim(String(index).padStart(2, "0"))
    const step = color.dim((stepId ?? "").padEnd(32))
    const eventType = paint(type.padEnd(20))
    console.log(`  ${number}  ${step} ${eventType} ${details}`)
}

function printSuspension(runId: string, suspension: Suspension, showHeading = true, showNextAction = true): void {
    if (showHeading) printHeading(color.yellow(suspension.request.name === "timer" ? "⏸ Sleeping until timer" : "⏸ Waiting for approval"))
    else console.log()

    if (suspension.request.name === OrderApprovalHook.name) {
        const request = OrderApprovalHook.request.parse(suspension.request.payload)
        printDetails([
            ["Order", request.orderId],
            ["Summary", request.summary],
            ["Total", formatCurrency(request.totalCents)],
            ["Wait ID", suspension.waitId]
        ])
        if (showNextAction) {
            console.log("\nNext")
            console.log(`  npm run workflow -- approve ${runId} Grace`)
            console.log(`  npm run workflow -- reject ${runId} Grace`)
        }
        return
    }

    if (suspension.request.name === "timer") {
        const timer = TimerRequestSchema.parse(suspension.request.payload)
        printDetails([
            ["Wake at", timer.wakeAt],
            ["Wait ID", suspension.waitId]
        ])

        if (showNextAction) {
            console.log("\nNext")
            console.log(`  npm run workflow -- resume ${runId}`)
        }
        return
    }

    printDetails([
        ["Hook", suspension.request.name],
        ["Wait ID", suspension.waitId]
    ])
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

async function waitForTimer(runId: string, wakeAt: string): Promise<void> {
    const waitMs = Math.max(0, Date.parse(wakeAt) - Date.now())

    printHeading(`Waiting ${formatDuration(waitMs)} for timer`)
    console.log(color.dim(`  Safe to stop · resume later with: npm run workflow -- resume ${runId}`))

    if (!process.stdout.isTTY) {
        await new Promise(resolve => setTimeout(resolve, waitMs))
        console.log(`  ${color.green("✓")} Timer elapsed`)
        return
    }

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    let frameIndex = 0
    const render = () => {
        const remainingMs = Math.max(0, Date.parse(wakeAt) - Date.now())
        const frame = color.cyan(frames[frameIndex++ % frames.length] ?? "⠋")
        process.stdout.write(`\r\u001B[2K  ${frame} ${formatDuration(remainingMs)} remaining`)
    }

    render()
    const animation = setInterval(render, 80)

    try {
        await new Promise(resolve => setTimeout(resolve, waitMs))
    } finally {
        clearInterval(animation)
    }

    process.stdout.write(`\r\u001B[2K  ${color.green("✓")} Timer elapsed\n`)
}

type PrintRuntimeEventStreamOptions = {
    readonly showNextAction?: boolean
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
    console.log(`Little Durable · Workflow demo

Usage
  npm run workflow -- <command>

Commands
  start [run-id] [total-cents]     Start an order and wait for approval
  start-follow-up [run-id] [ms]    Start an order follow-up that sleeps
  resume <run-id>                  Recover and resume an interrupted timer run
  approve <run-id> [reviewer]      Approve a suspended order
  reject <run-id> [reviewer]       Reject a suspended order
  status <run-id>                  Show the current run status
  journal <run-id>                 Print the durable event journal

Try it
  npm run workflow -- start order-1001 12500
  npm run workflow -- start-follow-up follow-up-1001 3000`)
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
const orderApprovalWorkflow = createOrderApprovalWorkflow({
    resultDirectory: resolve(dataDirectory, "results")
})
const delayedOrderFollowUpWorkflow = createDelayedOrderFollowUpWorkflow({
    resultDirectory: resolve(dataDirectory, "results")
})
const workflowsByName = new Map<string, WorkflowDefinition>([
    [orderApprovalWorkflow.name, orderApprovalWorkflow],
    [delayedOrderFollowUpWorkflow.name, delayedOrderFollowUpWorkflow]
])
const TimerRequestSchema = z.object({ wakeAt: z.iso.datetime() }).strict()

async function resolveWorkflow(runId: string): Promise<WorkflowDefinition> {
    const run = await runtime.getRun({ runId })
    const registeredWorkflow = workflowsByName.get(run.workflowName)

    if (!registeredWorkflow) throw new Error(`Workflow "${run.workflowName}" is not registered`)
    return registeredWorkflow
}

try {
    await main(process.argv.slice(2))
} catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof UsageError) showHelp()
    process.exitCode = 1
}
