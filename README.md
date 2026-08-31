# Little Durable

[![npm](https://img.shields.io/npm/v/little-durable)](https://www.npmjs.com/package/little-durable)
[![CI](https://github.com/TerseAI/little-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/TerseAI/little-durable/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Documentation](https://img.shields.io/badge/docs-read-4B5563)](./Docs.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

This is an extremely light-weight, runtime and storage agnostic, malleable, Durable Workflow runtime.

Little Durable is BYOCP (bring your own control plane, yes I just made that up), BYOC, and BYOS(torage).

This project was build entirely with the TDD + AI approach. Everything started with tests, and everything is heavily unit tested.

# Installation

Little Durable requires Node.js 20 or newer. Install it with Zod:

```bash
npm install little-durable zod
```

See the [example project](./examples/order-approval) to see a real working implementation of little-durable.

# Why Does this Exist?

I built this because I wanted to run durable functions on Sandboxes. This meant coupling the state of the filesystem with the durable journal.

Existing solutions were super heavy-weight and made assumptions on how the workflows were being hosted. For example, most Durable Workflow systems assume you run everything on a small number of nodes and assume each invocation is non-isolated.

This is not the case for running durability in a serverless/cloud function environment.

So I made this!

Some key features:

- Insanely lightweight: The only dependencies are ulid and ms.
- Storage agnostic: Journal can be Postgres, File System, Durable Object etc...
- Runtime agnostic: Runs anywhere you can import this npm package
- Type safety: Type safety enforced everywhere with Zod enforcing serialization safety in the Journal interactions.

```ts
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileJournalStore, Runtime, defineWorkflow, sleep, step } from "little-durable"
import { z } from "zod"

// 1 line runtime init
const runtime = new Runtime({ journalStore: new FileJournalStore(await mkdtemp(join(tmpdir(), "little-durable-test-"))) })

// Build your workflow
const WelcomeWorkflow = defineWorkflow({
    name: "welcome-customer",
    input: z.object({
        recipient: z.string(),
        name: z.string()
    }),
    run: async input => {
        const message = await step({
            name: "prepare-message",
            input: {
                name: input.name
            },
            run: async ({ name }) => {
                return `Welcome, ${name}!`
            }
        })

        await sleep("1 day")

        await step({
            name: "send-message",
            input: {
                recipient: input.recipient,
                message
            },
            run: async ({ recipient, message }) => {
                return { delivered: true }
            }
        })
    }
})

// run it
const events = runtime.start(WelcomeWorkflow, {
    runId: "run-123",
    input: {
        // this is type safe!
        recipient: "ada@example.com",
        name: "Ada"
    }
})

for await (const event of events) {
    console.log(event)

    if (event.type === "runtime.suspended") {
        // Reach out to your control plane and schedule the run to resume.
        console.log("Workflow suspended", event.suspension)
    }
}
```

We also have some convenience methods to see the state of a run.

```ts
const run = await runtime.getRun({ runId: "run-123" })
// { runId: "run-123", workflowName: "welcome-customer", startedAt: "..." }

const suspension = await runtime.getSuspension({ runId: "run-123" })
// { waitId: "wait_01...", request: { type: "hook", name: "timer", payload: { wakeAt: "..." } } }
// or undefined when no unresolved wait exists
```

This is the bare bones of a durable runtime. From here, you can chose where to store the journal by simply implementing an interface and plugging it in. (See fileJournalStore.ts for an example implementation)

```ts
export interface JournalStore {
    list(params: ListJournalEventsParams): Promise<readonly JournalEvent[]>
    listByType(params: ListJournalEventsByTypeParams): Promise<readonly JournalEvent[]>
    get(params: GetJournalEventParams): Promise<JournalEvent | undefined>
    append(params: AppendJournalEventParams): Promise<JournalEvent>
    popStep(params: PopJournalStepParams): Promise<void>
}
```

It doesn't care where you run it! Run it on a hosted k8s pod, run it on Workers, sandboxes etc..

We make it really easy to plug into an external control plane

```ts
// Control plane reaches out via HTTP, Grpc, CLI etc...
const input = req.input
const runId = req.runId
const workflowName = req.workflowName

// resolve workflow, your code here
const workflow = fetchWorkflow(workflowName)

// Start a workflow
const events = runtime.start(workflow, {
    runId,
    input: {
        // this is type safe!
        recipient: "ada@example.com",
        name: "Ada"
    }
})

for await (const event of events) publishRuntimeEvent(event)

// Resume from a sleep
const waitId = req.waitId

const resumedEvents = runtime.resumeTimer(workflow, {
    runId,
    waitId
})

for await (const event of resumedEvents) publishRuntimeEvent(event)
```

The hook system is also extremely malleable. Very easy to add Slack/email Human in the loop steps and plug into an integration system like Composio.

```ts
const ApprovalHook = defineHook({
    name: "approval",
    request: z.object({
        message: z.string()
    }),
    resolution: z.object({
        approved: z.boolean(),
        approvedBy: z.string()
    })
})

const WelcomeWorkflow = defineWorkflow({
    name: "welcome-customer",
    input: z.object({
        recipient: z.string(),
        name: z.string()
    }),
    run: async input => {
        console.log("Pre approval")

        const approved = await waitFor(ApprovalHook, {
            // Type will match resolution zod object above!
            message: "Deploy to production?"
        })

        console.log("Post approval:", approved)
    }
})

let suspension
for await (const event of runtime.start(WelcomeWorkflow, {
    runId: "run-123",
    input: {
        recipient: "ada@example.com",
        name: "Ada"
    }
})) {
    if (event.type === "runtime.suspended") suspension = event.suspension
}

if (suspension) {
    for await (const event of runtime.resumeHook(ApprovalHook, {
        workflow: WelcomeWorkflow,
        runId: "run-123",
        waitId: suspension.waitId,
        resolution: {
            approved: true,
            approvedBy: "Ada"
        }
    })) {
        console.log(event)
    }
}
```

In fact, we implement `sleep()` with a small wrapper around defineHook(). A good example to check if you want some more custom hooks.

At Terse, we use this internally to power our Durable functions. We use the `FileJournalStore` to store the journal on the filesystem. On sandbox suspension, it gets picked up on the snapshot.

You can make your own `JournalStore` very easily. Store the journal in Postgres, Durable Object etc... as long as you can connect to it, it will work!

Given how malleable and lightweight this project is, you can use it as a base to build your own Durable Workflow API as we did in Terse. That is the beauty of this.

# What do we Support?

Here is a list of the table-stake durability feature that are currently in:

- Starting, resuming, retrying a workflow
- Journaling steps
- Step() support for defining durable steps
- Passing in Workflow context and reading it from the workflow
- Pinning Date() and seeded Random number generate for idempotent replays. (uses runId for seeding)
- Creating custom hooks for suspending and resuming with external data

# Documentation

Read the [full documentation](./Docs.md).

# Example project

See the runnable [order approval workflow](./examples/order-approval), which demonstrates durable steps, typed hooks, filesystem journaling, process-independent resume, and replay safety.
