import { readdir } from "node:fs/promises"
import { resolve } from "node:path"

import * as p from "@clack/prompts"
import { FileJournalStore, Runtime } from "little-durable"
import type { JournalEvent, RuntimeEvent, Suspension, WorkflowDefinition } from "little-durable"
import { z } from "zod"

import { createDelayedOrderFollowUpWorkflow } from "./workflows/delayed-order-follow-up.js"
import { OrderApprovalHook, createOrderApprovalWorkflow } from "./workflows/order-approval.js"

async function main(args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args

    switch (command) {
        case "run":
            await runWorkflow(commandArgs)
            return
        case "runs":
            await showRuns()
            return
        case "inspect":
            await inspectRun(commandArgs)
            return
        case "workflows":
            showWorkflows()
            return
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
            showHelp()
            return
        case undefined:
            if (isInteractive) await openControlPlane()
            else showHelp()
            return
        default:
            throw new UsageError(`Unknown command: ${command}`)
    }
}

async function openControlPlane(): Promise<void> {
    p.intro(`${color.bold("Little Durable")} ${color.dim("· local control plane")}`)

    while (true) {
        const runs = await listRunSummaries()
        const suspendedRunCount = runs.filter(run => run.suspension !== undefined).length
        const action = unwrapPrompt(
            await p.select<ControlPlaneAction>({
                message: "What would you like to do?",
                options: [
                    { value: "run", label: "Run a workflow", hint: `${workflowCatalog.length} available` },
                    { value: "runs", label: "Inspect a run", hint: runs.length === 0 ? "no runs yet" : `${runs.length} available`, disabled: runs.length === 0 },
                    {
                        value: "resume",
                        label: "Resume a suspended run",
                        hint: suspendedRunCount === 0 ? "none waiting" : `${suspendedRunCount} waiting`,
                        disabled: suspendedRunCount === 0
                    },
                    { value: "workflows", label: "View workflows", hint: "registered in this worker" },
                    { value: "exit", label: "Exit" }
                ]
            })
        )

        switch (action) {
            case "run":
                await runWorkflow([])
                break
            case "runs":
                await inspectRun([])
                break
            case "resume":
                await resumeWorkflow([])
                break
            case "workflows":
                showWorkflows()
                break
            case "exit":
                p.outro("Control plane stopped")
                return
        }
    }
}

async function runWorkflow(args: readonly string[]): Promise<void> {
    const requestedWorkflowName = args[0]
    const workflowName = requestedWorkflowName ? parseWorkflowName(requestedWorkflowName) : await promptForWorkflow()

    switch (workflowName) {
        case "order-approval":
            await startOrderApproval(args.slice(1))
            return
        case "delayed-order-follow-up":
            await startDelayedFollowUp(args.slice(1))
    }
}

async function startOrderApproval(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? (isInteractive ? await promptForRunId("order") : "order-1001")
    const totalCents = args[1] ? parsePositiveInteger(args[1], "total-cents") : isInteractive ? await promptForPositiveInteger("What is the order total in cents?", "12500", "Order total") : 12500

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

    const terminalEvent = await printRuntimeEventStream(events, "Runtime event stream", { showNextAction: !isInteractive })

    if (terminalEvent?.type === "runtime.suspended" && terminalEvent.suspension.request.name === OrderApprovalHook.name && isInteractive) {
        await promptForApproval(runId, terminalEvent.suspension, { showJournal: false })
    }
}

async function startDelayedFollowUp(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? (isInteractive ? await promptForRunId("follow-up") : "follow-up-1001")
    const delayMs = args[1] ? parsePositiveInteger(args[1], "delay-ms") : isInteractive ? await promptForPositiveInteger("How long should the workflow sleep in milliseconds?", "3000", "Delay") : 3000

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

async function resolveApproval(args: readonly string[], approved: boolean, { showJournal = true }: ResolveApprovalOptions = {}): Promise<void> {
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

    printHeading(approved ? "Approving order" : "Rejecting order")
    printDetails([["Run ID", runId]])
    if (showJournal) printJournalHistory(journalEvents)

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
    const runId = args[0] ?? (isInteractive ? await promptForRun({ suspendedOnly: true }) : requireArgument(args[0], "run-id"))
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

    if (suspension.request.name === OrderApprovalHook.name) {
        if (isInteractive) {
            await promptForApproval(runId, suspension)
            return
        }
        throw new UsageError(`Run ${runId} needs an approval; use "approve ${runId}" or "reject ${runId}"`)
    }

    if (suspension.request.name !== "timer") {
        throw new UsageError(`Run ${runId} is waiting for unsupported hook "${suspension.request.name}"`)
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

        if (isInteractive) {
            const action = unwrapPrompt(
                await p.select<"wait" | "later">({
                    message: "How should the control plane handle this timer?",
                    options: [
                        { value: "wait", label: "Wait and resume", hint: formatDuration(remainingMs) },
                        { value: "later", label: "Leave it sleeping", hint: "resume from another process" }
                    ]
                })
            )

            if (action === "wait") await waitForTimer(runId, timer.wakeAt)
            else return
        } else {
            return
        }
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

async function showStatus(args: readonly string[], { showNextAction = true }: ShowStatusOptions = {}): Promise<void> {
    const runId = args[0] ?? (isInteractive ? await promptForRun() : requireArgument(args[0], "run-id"))
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

    if (suspension) printSuspension(runId, suspension, true, showNextAction)
}

async function showJournal(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? (isInteractive ? await promptForRun() : requireArgument(args[0], "run-id"))
    const events = await journalStore.list({ runId })

    if (args.includes("--json")) {
        console.log(JSON.stringify(events, null, 2))
        return
    }

    printJournalHistory(events, `Journal · ${runId}`)
}

async function inspectRun(args: readonly string[]): Promise<void> {
    const runId = args[0] ?? (isInteractive ? await promptForRun() : requireArgument(args[0], "run-id"))
    await showStatus([runId], { showNextAction: false })

    if (!isInteractive) return

    const suspension = await runtime.getSuspension({ runId })
    const action = unwrapPrompt(
        await p.select<RunAction>({
            message: "What would you like to do with this run?",
            options: [
                { value: "journal", label: "Inspect journal", hint: "durable event history" },
                ...(suspension ? [{ value: "resume" as const, label: "Resume run", hint: describeSuspension(suspension) }] : []),
                { value: "back", label: "Back" }
            ]
        })
    )

    if (action === "journal") await showJournal([runId])
    if (action === "resume") await resumeWorkflow([runId])
}

async function showRuns(): Promise<void> {
    const runs = await listRunSummaries()
    printHeading(`Runs · ${runs.length}`)

    if (runs.length === 0) {
        console.log(color.dim(`  No runs yet. Start one with: ${formatCliCommand("run")}`))
        return
    }

    console.log(color.dim("  RUN ID                         WORKFLOW                       STATUS"))
    for (const run of runs) {
        console.log(`  ${run.runId.padEnd(30)} ${run.workflowName.padEnd(30)} ${paintRunStatus(run)}`)
    }
}

function showWorkflows(): void {
    printHeading(`Available workflows · ${workflowCatalog.length}`)
    for (const workflow of workflowCatalog) {
        console.log(`  ${color.cyan(workflow.name)}`)
        console.log(`    ${workflow.description}`)
        console.log(color.dim(`    Suspends on ${workflow.suspendsOn}`))
        console.log(color.dim(`    ${formatCliCommand(workflow.usage)}`))
    }
}

async function promptForWorkflow(): Promise<WorkflowName> {
    requireInteractive("Choose a workflow by passing its name after the run command")
    return unwrapPrompt(
        await p.select<WorkflowName>({
            message: "Which workflow should run?",
            options: workflowCatalog.map(workflow => ({
                value: workflow.name,
                label: workflow.label,
                hint: workflow.promptHint
            }))
        })
    )
}

async function promptForRun({ suspendedOnly = false }: PromptForRunOptions = {}): Promise<string> {
    requireInteractive("Choose a run by passing its run ID")
    const runs = await listRunSummaries()
    const choices = suspendedOnly ? runs.filter(run => run.suspension !== undefined) : runs

    if (choices.length === 0) {
        throw new UsageError(suspendedOnly ? "There are no suspended runs to resume" : "There are no runs to inspect")
    }

    return unwrapPrompt(
        await p.autocomplete<string>({
            message: suspendedOnly ? "Which suspended run should resume?" : "Which run should open?",
            placeholder: "Type a run ID…",
            maxItems: 8,
            options: choices.map(run => ({
                value: run.runId,
                label: run.runId,
                hint: `${run.workflowName} · ${describeRunStatus(run)}`
            }))
        })
    )
}

async function promptForRunId(prefix: "order" | "follow-up"): Promise<string> {
    const runIds = new Set(await listRunIds())
    const suggestion = suggestRunId(prefix, runIds)
    return unwrapPrompt(
        await p.text({
            message: "Choose a run ID",
            initialValue: suggestion,
            placeholder: suggestion,
            validate: value => {
                if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return "Use letters, numbers, dashes, or underscores"
                if (runIds.has(value)) return `Run ${value} already exists`
            }
        })
    )
}

async function promptForPositiveInteger(message: string, defaultValue: string, label: string): Promise<number> {
    const value = unwrapPrompt(
        await p.text({
            message,
            initialValue: defaultValue,
            placeholder: defaultValue,
            validate: value => {
                const parsed = Number(value)
                if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${label} must be a positive integer`
            }
        })
    )
    return parsePositiveInteger(value, label)
}

async function promptForApproval(runId: string, suspension: Suspension, { showJournal = true }: ResolveApprovalOptions = {}): Promise<void> {
    if (suspension.request.name !== OrderApprovalHook.name) throw new Error(`Wait ${suspension.waitId} is not an order approval`)

    if (showJournal) printJournalHistory(await journalStore.list({ runId }), "Persisted journal · awaiting approval")

    const request = OrderApprovalHook.request.parse(suspension.request.payload)
    if (showJournal) {
        p.note([`Run       ${runId}`, `Order     ${request.orderId}`, `Summary   ${request.summary}`, `Total     ${formatCurrency(request.totalCents)}`].join("\n"), "Approval requested")
    }

    const decision = unwrapPrompt(
        await p.select<ApprovalDecision>({
            message: "How should this order proceed?",
            options: [
                { value: "approve", label: "Approve order", hint: "continue the workflow" },
                { value: "reject", label: "Reject order", hint: "record the rejection" },
                { value: "later", label: "Leave pending", hint: "resume from another process" }
            ]
        })
    )

    if (decision === "later") {
        p.log.info(`Approval left pending · ${formatCliCommand(`resume ${runId}`)}`)
        return
    }

    const reviewer = unwrapPrompt(
        await p.text({
            message: "Who reviewed this order?",
            initialValue: "Grace",
            placeholder: "Grace",
            validate: value => (!value || value.trim().length === 0 ? "Reviewer is required" : undefined)
        })
    )

    await resolveApproval([runId, reviewer], decision === "approve", { showJournal: false })
}

async function listRunSummaries(): Promise<readonly RunSummary[]> {
    const runIds = await listRunIds()
    const runs = await Promise.all(
        runIds.map(async runId => {
            const [run, suspension, events] = await Promise.all([runtime.getRun({ runId }), runtime.getSuspension({ runId }), journalStore.list({ runId })])
            return {
                ...run,
                suspension,
                eventCount: events.length,
                completed: events.some(event => event.type === "run.completed")
            }
        })
    )

    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

async function listRunIds(): Promise<readonly string[]> {
    try {
        const entries = await readdir(journalDirectory, { withFileTypes: true })
        return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return []
        throw error
    }
}

function suggestRunId(prefix: "order" | "follow-up", runIds: ReadonlySet<string>): string {
    for (let index = 1001; ; index++) {
        const candidate = `${prefix}-${index}`
        if (!runIds.has(candidate)) return candidate
    }
}

function describeRunStatus(run: RunSummary): string {
    if (run.suspension?.request.name === "timer") {
        const timer = TimerRequestSchema.parse(run.suspension.request.payload)
        const remainingMs = Date.parse(timer.wakeAt) - Date.now()
        return remainingMs > 0 ? `Sleeping · ${formatDuration(remainingMs)} remaining` : "Ready to resume"
    }
    if (run.suspension) return `Waiting for ${run.suspension.request.name}`
    if (run.completed) return "Completed"
    return "Running"
}

function describeSuspension(suspension: Suspension): string {
    if (suspension.request.name !== "timer") return `waiting for ${suspension.request.name}`
    const timer = TimerRequestSchema.parse(suspension.request.payload)
    const remainingMs = Date.parse(timer.wakeAt) - Date.now()
    return remainingMs > 0 ? `${formatDuration(remainingMs)} remaining` : "timer ready"
}

function paintRunStatus(run: RunSummary): string {
    const status = describeRunStatus(run)
    if (run.completed) return color.green(status)
    if (run.suspension) return color.yellow(status)
    return color.cyan(status)
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
            printLedgerRow(index, event.type, `${getJournalRequestName(event.request)} · ${event.waitId}`, color.yellow)
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
            console.log(`  ${formatCliCommand(`approve ${runId} Grace`)}`)
            console.log(`  ${formatCliCommand(`reject ${runId} Grace`)}`)
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
            console.log(`  ${formatCliCommand(`resume ${runId}`)}`)
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

function getJournalRequestName(request: unknown): string {
    const parsed = HookRequestSummarySchema.safeParse(request)
    return parsed.success ? parsed.data.name : "hook"
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`
    const seconds = durationMs / 1000
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
}

async function waitForTimer(runId: string, wakeAt: string): Promise<void> {
    const waitMs = Math.max(0, Date.parse(wakeAt) - Date.now())

    printHeading(`Waiting ${formatDuration(waitMs)} for timer`)
    console.log(color.dim(`  Safe to stop · resume later with: ${formatCliCommand(`resume ${runId}`)}`))

    if (!process.stdout.isTTY) {
        await new Promise(resolve => setTimeout(resolve, waitMs))
        console.log(`  ${color.green("✓")} Timer elapsed`)
        return
    }

    const spinner = p.spinner()
    const render = () => {
        const remainingMs = Math.max(0, Date.parse(wakeAt) - Date.now())
        spinner.message(`${formatDuration(remainingMs)} remaining`)
    }

    spinner.start(`${formatDuration(waitMs)} remaining`)
    const animation = setInterval(render, 100)

    try {
        await new Promise(resolve => setTimeout(resolve, waitMs))
    } finally {
        clearInterval(animation)
    }

    spinner.stop("Timer elapsed · resuming workflow")
}

type PrintRuntimeEventStreamOptions = {
    readonly showNextAction?: boolean
}

type ResolveApprovalOptions = {
    readonly showJournal?: boolean
}

type PromptForRunOptions = {
    readonly suspendedOnly?: boolean
}

type ShowStatusOptions = {
    readonly showNextAction?: boolean
}

type WorkflowName = "order-approval" | "delayed-order-follow-up"
type ControlPlaneAction = "run" | "runs" | "resume" | "workflows" | "exit"
type RunAction = "journal" | "resume" | "back"
type ApprovalDecision = "approve" | "reject" | "later"

type RunSummary = {
    readonly runId: string
    readonly workflowName: string
    readonly startedAt: string
    readonly suspension: Suspension | undefined
    readonly eventCount: number
    readonly completed: boolean
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

function requireInteractive(recovery: string): void {
    if (isInteractive) return
    throw new UsageError(`${recovery}; prompts require an interactive terminal`)
}

function unwrapPrompt<Value>(value: Value | symbol): Value {
    if (!p.isCancel(value)) return value as Value
    p.cancel("No changes made")
    throw new PromptCancelledError()
}

function parseWorkflowName(value: string): WorkflowName {
    if (workflowsByName.has(value)) return value as WorkflowName
    throw new UsageError(`Unknown workflow: ${value}. Run "${formatCliCommand("workflows")}" to see what is available`)
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    throw new UsageError(`${name} must be a positive integer`)
}

function formatCliCommand(args?: string): string {
    return `npm run --silent workflow${args ? ` -- ${args}` : ""}`
}

function showHelp(): void {
    console.log(`${color.bold("Little Durable")} ${color.dim("· local control plane")}

Usage
  npm run --silent workflow
  npm run --silent workflow -- <command>

Commands
  run [workflow] [run-id] [value]  Run a workflow; prompts when omitted
  workflows                        List registered workflows
  runs                             List persisted runs
  inspect [run-id]                 Open a run's status and actions
  resume [run-id]                  Resume a timer or approval
  approve <run-id> [reviewer]      Approve a suspended order directly
  reject <run-id> [reviewer]       Reject a suspended order directly
  status [run-id]                  Show run status
  journal [run-id] [--json]        Inspect the durable event journal

Start here
  npm run --silent workflow`)
}

class UsageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UsageError"
    }
}

class PromptCancelledError extends Error {}

const dataDirectory = resolve(process.env.DURABLE_SAMPLE_DATA_DIR ?? ".data")
const journalDirectory = resolve(dataDirectory, "journals")
const journalStore = new FileJournalStore(journalDirectory)
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
const workflowCatalog = [
    {
        name: "order-approval",
        label: "Order approval",
        description: "Prepare an order, then ask a reviewer to approve or reject it",
        promptHint: "waits for a human decision",
        suspendsOn: "an approval hook",
        usage: "run order-approval [run-id] [total-cents]"
    },
    {
        name: "delayed-order-follow-up",
        label: "Delayed order follow-up",
        description: "Schedule a customer follow-up, sleep, then send it",
        promptHint: "waits on a durable timer",
        suspendsOn: "a durable timer",
        usage: "run delayed-order-follow-up [run-id] [delay-ms]"
    }
] as const satisfies readonly {
    readonly name: WorkflowName
    readonly label: string
    readonly description: string
    readonly promptHint: string
    readonly suspendsOn: string
    readonly usage: string
}[]
const TimerRequestSchema = z.object({ wakeAt: z.iso.datetime() }).strict()
const HookRequestSummarySchema = z.object({ name: z.string() }).passthrough()
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

async function resolveWorkflow(runId: string): Promise<WorkflowDefinition> {
    const run = await runtime.getRun({ runId })
    const registeredWorkflow = workflowsByName.get(run.workflowName)

    if (!registeredWorkflow) throw new Error(`Workflow "${run.workflowName}" is not registered`)
    return registeredWorkflow
}

try {
    await main(process.argv.slice(2))
} catch (error) {
    if (error instanceof PromptCancelledError) process.exitCode = 0
    else {
        console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
        if (error instanceof UsageError) showHelp()
        process.exitCode = 1
    }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
    return value instanceof Error && "code" in value
}
