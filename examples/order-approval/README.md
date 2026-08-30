# Little Durable workflow example

A plain TypeScript/npm project that consumes `little-durable` from the root of this repository.

The sample demonstrates:

- a typed workflow created with `defineWorkflow`
- durable work wrapped in `step`
- a numbered runtime event ledger, including hook requests and resolutions
- a typed human-approval hook using `defineHook` and `waitFor`
- a timer suspension using `sleep` and `Runtime.resumeTimer`
- a workflow registry that resolves persisted workflow names before resuming
- a tiny CLI control plane that schedules timer wake-ups and consumes each execution stream
- process-independent resume with `Runtime.resumeHook`
- filesystem persistence with `FileJournalStore`
- journal and status inspection

## Install and verify

Build Little Durable from the repository root, then install and test the example:

```bash
pnpm install
pnpm build
cd examples/order-approval
npm install
npm test
```

## Run the workflow

Start a sample order. The CLI prints each streamed runtime event as the preparation step executes and the run suspends on approval:

```bash
npm run workflow -- start order-1001 12500
```

Inspect the persisted run from a separate process:

```bash
npm run workflow -- status order-1001
npm run workflow -- journal order-1001
```

Approve or reject it. Either command first prints the persisted pre-approval journal, marks the incoming approval boundary, then streams the resumed execution that records the decision:

```bash
npm run workflow -- approve order-1001 Grace
# or: npm run workflow -- reject order-1001 Grace
```

The journal is stored in `.data/journals/` and the final result in `.data/results/`.

## Run the delayed follow-up workflow

Start a second workflow that schedules a follow-up and sleeps for three seconds. The CLI prints an animated countdown, resolves the persisted workflow name when the timer fires, and resumes it automatically:

```bash
npm run workflow -- start-follow-up follow-up-1001 3000
```

If the CLI process is interrupted while waiting, recover the run from a new process:

```bash
npm run workflow -- resume follow-up-1001
```

The CLI reads the run metadata, looks up `delayed-order-follow-up` in its workflow registry, prints the persisted pre-resume journal, and streams the new execution events. This is the same scheduling and dispatch role a production control plane would perform with a durable timer service instead of an in-process timeout.

To use a different local data directory:

```bash
DURABLE_SAMPLE_DATA_DIR=/tmp/durable-sample npm run workflow -- start order-1002
```
