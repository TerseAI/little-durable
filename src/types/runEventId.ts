import type { RunEventType } from "./runEventType.js"

export function createRunEventId<Type extends RunEventType>({ type }: CreateRunEventIdParams<Type>): Type {
    return type
}

export type CreateRunEventIdParams<Type extends RunEventType = RunEventType> = {
    readonly type: Type
}
