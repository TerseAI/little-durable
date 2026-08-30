import { AsyncLocalStorage } from "node:async_hooks"

import type { Suspension } from "../types/runtimeOutcome.js"

import type { DeterministicIdGenerator } from "./deterministicIdGenerator.js"
import type { ExecutionJournal } from "./executionJournal.js"

export function getWorkflowContext(): WorkflowContext {
    const context = getOptionalWorkflowContext()

    if (!context) {
        throw new Error("Durable operations must be called from within a workflow")
    }

    return context
}

export function getOptionalWorkflowContext(): WorkflowContext | undefined {
    return workflowContext().getStore()
}

export function getExecutionPhase(): ExecutionPhase | undefined {
    return getOptionalWorkflowContext()?.phase
}

export function runWithWorkflowContext<Output>(context: WorkflowContext, run: () => Output): Output {
    return workflowContext().run(context, run)
}

export function runWithStepContext<Output>(run: () => Output): Output {
    const context = getWorkflowContext()
    return workflowContext().run({ ...context, phase: "step" }, run)
}

function workflowContext(): AsyncLocalStorage<WorkflowContext> {
    return (durableGlobal[WORKFLOW_CONTEXT_KEY] ??= new AsyncLocalStorage<WorkflowContext>())
}

const WORKFLOW_CONTEXT_KEY = Symbol.for("little-durable/workflow-context")
const durableGlobal = globalThis as DurableGlobal

export type LogicalClock = {
    readonly now: () => number
    readonly advanceTo: (timestamp: number) => void
}

export type ExecutionPhase = "step" | "workflow"

export type WorkflowContext = {
    readonly runId: string
    readonly journalStore: ExecutionJournal
    readonly idGenerator: DeterministicIdGenerator
    readonly suspend: (suspension: Suspension) => void
    readonly logicalClock: LogicalClock
    readonly random: () => number
    readonly phase: ExecutionPhase
}

type DurableGlobal = typeof globalThis & {
    [key: symbol]: AsyncLocalStorage<WorkflowContext> | undefined
}
