import type { WaitEventType } from "./waitEventType.js"

export function createWaitEventId({ type, waitId }: CreateWaitEventIdParams): string {
    return `${type}:${waitId}`
}

export type CreateWaitEventIdParams = {
    readonly type: WaitEventType
    readonly waitId: string
}
