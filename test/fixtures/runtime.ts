import type { RuntimeEvent, RuntimeOutcome } from "../../src/index.js"

export async function waitForRuntimeOutcome(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeOutcome> {
    for await (const event of events) {
        if (event.type === "runtime.completed") return { status: "completed" }
        if (event.type === "runtime.suspended") {
            return {
                status: "suspended",
                suspension: event.suspension
            }
        }
    }

    throw new Error("Runtime event stream ended without an outcome")
}
