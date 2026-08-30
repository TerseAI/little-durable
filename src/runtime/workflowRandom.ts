import { getOptionalWorkflowContext } from "./workflowContext.js"

export function installWorkflowRandom(): void {
    if (Math.random !== workflowRandom) Math.random = workflowRandom
}

function workflowRandom(): number {
    const context = getOptionalWorkflowContext()

    if (!context || context.phase === "step") return nativeRandom()
    return context.random()
}

const nativeRandom = Math.random
