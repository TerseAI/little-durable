import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getRewindableStepTail } from "../runtime/journalTail.js"

import { JournalEventSchema } from "../types/journalEvent.js"
import type { JournalEvent } from "../types/journalEvent.js"
import type { AppendJournalEventParams, GetJournalEventParams, JournalStore, ListJournalEventsByTypeParams, ListJournalEventsParams, PopJournalStepParams } from "../types/journalStore.js"

export class FileJournalStore implements JournalStore {
    constructor(private readonly rootDirectory: string) {}

    async list({ runId }: ListJournalEventsParams): Promise<readonly JournalEvent[]> {
        const runDirectory = this.runDirectoryFor(runId)
        const filenames = await readJournalDirectory(runDirectory)

        return Promise.all(
            filenames.sort().map(async filename => {
                const source = await readFile(join(runDirectory, filename), "utf8")
                return JournalEventSchema.parse(JSON.parse(source) as unknown)
            })
        )
    }

    async listByType({ runId, eventType }: ListJournalEventsByTypeParams): Promise<readonly JournalEvent[]> {
        const events = await this.list({ runId })
        return events.filter(event => event.type === eventType)
    }

    async get({ runId, eventId }: GetJournalEventParams): Promise<JournalEvent | undefined> {
        const events = await this.list({ runId })
        return events.find(event => event.eventId === eventId)
    }

    async append({ runId, event }: AppendJournalEventParams): Promise<JournalEvent> {
        const validatedEvent = JournalEventSchema.parse(event)
        const runDirectory = this.runDirectoryFor(runId)
        const filenames = await readJournalDirectory(runDirectory)
        const sequence = filenames.length + 1
        const filename = `${sequence.toString().padStart(8, "0")}-${validatedEvent.type}.json`

        await mkdir(runDirectory, { recursive: true })
        await writeFile(join(runDirectory, filename), `${JSON.stringify(validatedEvent, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx"
        })
        return validatedEvent
    }

    async popStep({ runId, stepId }: PopJournalStepParams): Promise<void> {
        const runDirectory = this.runDirectoryFor(runId)
        const filenames = (await readJournalDirectory(runDirectory)).sort()
        const events: JournalEvent[] = []
        for (const filename of filenames) {
            const source = await readFile(join(runDirectory, filename), "utf8")
            events.push(JournalEventSchema.parse(JSON.parse(source) as unknown))
        }
        const tail = getRewindableStepTail(events, stepId)
        for (const filename of filenames.slice(-tail.length).reverse()) await unlink(join(runDirectory, filename))
    }

    private runDirectoryFor(runId: string): string {
        if (runId.length === 0 || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\") || runId.includes("\0")) {
            throw new TypeError("Run ID must be a non-empty path segment")
        }

        return join(this.rootDirectory, runId)
    }
}

async function readJournalDirectory(path: string): Promise<string[]> {
    try {
        const entries = await readdir(path, { withFileTypes: true })
        return entries.filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name)
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return []
        throw error
    }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
    return value instanceof Error && "code" in value
}
