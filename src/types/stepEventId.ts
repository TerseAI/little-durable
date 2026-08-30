import type { StepEventType } from "./stepEventType.js"

export function createStepEventId({ type, stepId }: CreateStepEventIdParams): string {
    return `${type}:${stepId}`
}

export type CreateStepEventIdParams = {
    readonly type: StepEventType
    readonly stepId: string
}
