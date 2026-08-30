import type { RuntimeEvent } from "../types/runtimeEvent.js"
import type { RuntimeOutcome } from "../types/runtimeOutcome.js"

export class RuntimeEventStream extends ReadableStream<RuntimeEvent> {
    async waitForOutcome(): Promise<RuntimeOutcome> {
        for await (const event of this) {
            if (event.type === "runtime.completed") return { status: "completed" }
            if (event.type === "runtime.failed") {
                return {
                    status: "failed",
                    error: event.error
                }
            }
            if (event.type === "runtime.suspended") {
                return {
                    status: "suspended",
                    suspension: event.suspension
                }
            }
        }

        throw new Error("Runtime event stream ended without an outcome")
    }
}
