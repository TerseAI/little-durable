# Documentation

## Core Concepts

This is a durable workflow SDK. What does this mean?

Durable Workflows are **functions** that are broken up into **steps**. Each step is an idempotent chunk of work that has a a serializable input and output.

After each step runs, we write both input and output to a **journal**. In the event a step fails (say, because github is down... again), you resume the run and it will hit the journal cache for the steps that completed successfully, thus resuming real work at the point it failed.

Each workflow is executed in a **runtime**. This is what calls the internal function and injects context variables into the system.

## How to Make A Runtime

The runtime protocol here is very simple.

All you need to initialize one, is a **JournalStore**. In this v0.1, we have the FileJournalStore available for use.

```ts
const journalDirectory = await mkdtemp(join(tmpdir(), "little-durable-test-"))
const journalStore = new FileJournalStore(journalDirectory)
const runtime = new Runtime({ journalStore })

const startEvents = runtime.start(workflow, {
    runId,
    input: {
        recipient: "ada@example.com",
        name: "Ada"
    }
})

// Replay an interrupted run without resolving a wait.
// This will pop a failed/incomplete step so the workflow can "try again".
// This supports swapping out the actual code of the workflow as well!
const resumeEvents = runtime.resume(workflow, { runId })

// Resume a timer
const timerEvents = runtime.resumeTimer(workflow, {
    runId,
    waitId
})

// Resume a hook with its resolution payload
const hookEvents = runtime.resumeHook(ApprovalHook, {
    workflow,
    runId,
    waitId,
    resolution: {
        approved: true,
        approvedBy: "Ada"
    }
})
```

`start()`, `resume()`, `resumeTimer()`, and `resumeHook()` return a `RuntimeEventStream`, which extends `ReadableStream<RuntimeEvent>`. Every execution attempt has the same event-driven interface:

```ts
for await (const event of startEvents) {
    switch (event.type) {
        case "runtime.started":
        case "runtime.resumed":
        case "hook.requested":
        case "hook.resolved":
        case "step.started":
        case "step.completed":
        case "step.failed":
        case "step.retry.scheduled":
            console.log(event)
            break

        case "runtime.suspended":
            console.log("Workflow suspended", event.suspension)
            break

        case "runtime.completed":
            console.log("Workflow completed")
            break

        case "runtime.failed":
            console.error("Workflow failed", event.error)
            break
    }
}
```

Optionally, if you just want to get the outcome directly, you can use `.waitForOutcome`.

```ts
const outcome = await runtime
    .start(workflow, {
        runId: "run-123",
        input: {
            recipient: "ada@example.com",
            name: "Ada"
        }
    })
    .waitForOutcome()
```

Use `getRun()` to read identity metadata for an existing run:

```ts
const run = await runtime.getRun({ runId })

// {
//     runId: "run-123",
//     workflowName: "welcome-customer",
//     startedAt: "2026-08-29T12:00:00.000Z"
// }
```

Use `getSuspension()` to read its active unresolved wait:

```ts
const suspension = await runtime.getSuspension({ runId })

// {
//     waitId: "wait_01...",
//     request: {
//         type: "hook",
//         name: "timer",
//         payload: { wakeAt: "2026-08-30T12:00:00.000Z" }
//     }
// }
```

Remember, with FileJournalStore, you need journal data in that path if you plan on resuming a workflow! We take sandbox snapshots here to solve for this. There will be no durability if you don't persist the journal state correctly!

## How to Define a Workflow

Workflows just need a name, input schema and a closure.

```ts
const workflow = defineWorkflow({
    name: "test-workflow",
    input: z.object({
        recipient: z.string(),
        name: z.string()
    }),
    run: async input => {
        console.log("Hello world")
    }
})
```

Now, we can combine that with our runtime above and run our first workflow!

```ts
const events = runtime.start(workflow, {
    runId: "run-123",
    input: {
        recipient: "ada@example.com",
        name: "Ada"
    }
})

for await (const event of events) {
    if (event.type === "runtime.completed") console.log("Workflow completed")
    if (event.type === "runtime.suspended") console.log("Workflow suspended", event.suspension)
}
```

Ok so far not the most interesting, now it's time to build our first **Step**.

## Building Steps

Similar to a workflow, a step needs a name, schemas and closures.

```ts
const message = await step({
    name: "prepare-message",
    input: {
        name: input.name
    },
    run: async ({ name }) => {
        return `Welcome, ${name}!`
    }
})
```

The closure here is where you go and do I/O, reach out to slack github etc... run a model whatever you need to do!

### Automatic step retries

Add a `retry` policy to an individual step to retry failures your application recognizes as transient:

```ts
await step({
    name: "call-provider",
    input,
    retry: {
        maxAttempts: 3,
        initialDelay: "1s",
        backoffMultiplier: 2,
        maxDelay: "30s",
        jitter: true,
        classify: error => {
            if (isRateLimitError(error)) {
                return { retry: true, delay: "30s" }
            }

            return { retry: isTransientProviderError(error) }
        }
    },
    run: callProvider
})
```

`callProvider`, `isRateLimitError`, and `isTransientProviderError` are application functions. Use your SDK's error types to implement the classifiers. The runtime does not infer retryability from error messages or HTTP statuses. Steps without a policy execute once before surfacing a failure.

Only `classify` is required inside `retry`. `RetryPolicy` and `RetryDecision` are exported types.

| Option              | Default  | Meaning                                                                                                                         |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `classify(error)`   | Required | Synchronously returns `{ retry: false }` or `{ retry: true, delay?: string }`. Receives the original thrown value as `unknown`. |
| `maxAttempts`       | `3`      | Total attempts, including the first. Must be a positive safe integer; `1` disables additional attempts.                         |
| `initialDelay`      | `"1s"`   | Positive duration before the first retry, before jitter. Uses the same duration syntax as `sleep()`.                            |
| `backoffMultiplier` | `2`      | Multiplies the delay for each subsequent retry. Must be finite and at least `1`.                                                |
| `maxDelay`          | `"30s"`  | Positive cap on calculated backoff, before jitter.                                                                              |
| `jitter`            | `true`   | Selects a whole-millisecond delay from zero up to the calculated backoff. `false` uses the calculated delay directly.           |

A classifier-provided `delay` overrides the calculated delay, cap, and jitter. It may be zero. Convert a provider's `Retry-After` seconds or HTTP date into a nonnegative duration such as `` `${milliseconds}ms` ``. Apply the provider's documented semantics: a `429` may be transient, while an invalid request generally needs a caller fix. A transient response alone does not establish that repeating a write is safe.

Keep classifiers synchronous and free of side effects. A committed failure record contains the error and retry decision together. Replay reuses that decision without rerunning the classifier or choosing new jitter. The numeric policy is snapshotted when the step first starts; changing it affects new steps or a manually reset budget. Keep the classifier available while a step is pending. Updated classifier code applies to newly observed errors.

**Scheduling and errors.** Backoff persists a timer wait and suspends the runtime. Schedule host wakeups from `runtime.suspended`, exactly as for `sleep()`, and call `resumeTimer()` when due. `step.retry.scheduled` is an observability event emitted before the timer handoff; it is not the host scheduling signal. An early resume cannot skip the wait, and an ordinary `resume()` does not resolve it even after its deadline.

Intermediate failures do not enter workflow `catch` or `finally` blocks. When the classifier rejects an error or attempts run out, the final live attempt throws its original error to the workflow. Replaying a recorded terminal failure after a later workflow suspension reconstructs an `Error` with the persisted name and message; SDK prototypes, custom fields, and object identity are not preserved. Classifier exceptions or malformed decisions terminate with `RetryClassificationError`. Storage failures and replay errors never enter the classifier.

**History and manual recovery.** Each failed attempt has a `step.attempt.failed` journal record. Retried failures emit `step.retry.scheduled` with the failed attempt number, error, wait ID, chosen delay, and wake time. A terminal `step.failed` additionally includes `attempt` and `reason`: `not-retryable`, `attempts-exhausted`, `classifier-failed`, or `invalid-operation`. Successful automatic retries retain their failed-attempt history.

Explicitly calling `resume(workflow, { runId })` after a terminal tail-step failure rewinds that step and starts a fresh budget, preserving the existing code-repair behavior. That destructive rewind removes the old budget's attempts and internal waits. Timer deliveries do not reset exhausted budgets; an old timer ID cannot resolve a replacement budget. While a retry is pending, resumes preserve its budget and schedule.

**Execution contract.** Retry-enabled callbacks perform external work and cannot contain `step()`, `sleep()`, or `waitFor()` calls, nor be nested inside another step. Keep one execution active per run; hosts must serialize concurrent resume requests. Sequential duplicate deliveries are safe. As with any durable step, a crash before recording the callback's result can cause the current attempt to execute again. `maxAttempts` bounds recorded failed attempts, not physical API calls across that crash window. Use provider idempotency keys for writes and account for retries already performed by the SDK.

**Custom journal stores.** The `JournalStore` methods are unchanged, and old journal records remain readable. Adapters must accept the new attempt event and optional retry fields. Their `popStep()` implementation must rewind the terminal step's attempt events and its associated internal timer requests/resolutions as well as its start/failure markers, while preserving earlier completed work. The file store implements this behavior. Older library versions cannot read journals containing the new retry events.

You simply nest it in your workflow:

```ts
const workflow = defineWorkflow({
    name: "test-workflow",
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
                // pretend this needs to reach out to github
                return `Welcome, ${name}!`
            }
        })
    }
})
```

## Pausing a Workflow

Pausing a workflow is done with `sleep()`.

```ts
const workflow = defineWorkflow({
    name: "test-workflow",
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
                // pretend this needs to reach out to github
                return `Welcome, ${name}!`
            }
        })

        await sleep("1d")

        const message2 = await step({
            name: "prepare-message",
            input: {
                name: input.name
            },
            run: async ({ name }) => {
                // pretend this needs to reach out to github
                return `Welcome, ${name}. first message was ${message}!`
            }
        })
    }
})
```

You can do as many sleep() in a workflow as you want. (even in a for loop!).

The input is a human readable string duration:

```ts
await sleep("30s")
await sleep("5m")
await sleep("2h")
await sleep("1d")
```

## Defining a Hook

Probably the most important part of this project is how hooks are made.

Defining a hook comes down to specifying the **Request Schema** and the **Resolution Schema**. The Request Schema, is what gets sent out to the control plane. Ex: for requesting approval in slack, you would want to list options here + a message.

The Resolution Schema would be what slack provides back and what you would use in a later step in your workflow.

```ts
const SlackDisambiguationRequestSchema = z.object({
    message: z.string(),
    options: z.array(z.string()).min(2)
})

const SlackDisambiguationResponseSchema = z.object({
    selectedOption: z.number().int().nonnegative()
})

const SlackDisambiguationHook = defineHook({
    name: "slack-disambiguation",
    request: SlackDisambiguationRequestSchema,
    resolution: SlackDisambiguationResponseSchema
})
```

Now that your hook is defined, you can use it to suspend a workflow and read the response!

```ts
const DeploymentWorkflow = defineWorkflow({
    name: "deploy-application",
    input: z.object({}),
    run: async () => {
        const response = await waitFor(SlackDisambiguationHook, {
            message: "Which environment should we deploy to?",
            options: ["Development", "Staging", "Production"]
        })

        console.log(response)
    }
})
```

> Note: You need to handle how this communicates with slack here! More on this in the next section

## Hot Swapping Failing Workflows

The astute reader may have paused at:

```ts
// Replay an interrupted run without resolving a wait.
// This will pop a failed/incomplete step so the workflow can "try again".
// This supports swapping out the actual code of the workflow as well!
const resumeEvents = runtime.resume(workflow, { runId })
```

Indeed, this was a frustration of mine with other Workflow systems. What if you find a bug and want to change the code then retry?

With little-durable, this is how you can do it:

```ts
const broken = defineWorkflow({
    name: "test-workflow",
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
                throw new Error("Broken")
            }
        })
    }
})

const failedOutcome = await runtime
    .start(broken, {
        runId: "run-123",
        input: {
            recipient: "ada@example.com",
            name: "Ada"
        }
    })
    .waitForOutcome()

if (failedOutcome.status !== "failed") {
    throw new Error("Expected the original workflow to fail")
}

const fixed = defineWorkflow({
    name: "test-workflow", // notice same name!
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

        console.log(message)
    }
})

const outcome = await runtime
    .resume(fixed, {
        runId: "run-123" // Notice same runId!
    })
    .waitForOutcome()

if (outcome.status === "completed") {
    console.log("Workflow completed")
}
```
