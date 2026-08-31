# Little Durable workflow example

A plain TypeScript/npm project that consumes `little-durable` from the root of this repository.

The sample demonstrates:

- a typed workflow created with `defineWorkflow`
- durable work wrapped in `step`
- a numbered runtime event ledger, including hook requests and resolutions
- a typed human-approval hook using `defineHook` and `waitFor`
- a timer suspension using `sleep` and `Runtime.resumeTimer`
- a workflow registry that resolves persisted workflow names before resuming
- an interactive CLI control plane built with Clack
- workflow discovery, run inspection, readable journals, approvals, and timer wake-ups
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

## Open the control plane

Launch the guided experience with no arguments:

```bash
npm run --silent workflow
```

The control plane lets you:

- choose from the registered workflows
- start a run with guided inputs
- respond to approval hooks as they arrive
- browse persisted runs and inspect their journals
- resume pending approvals or elapsed timers

Choose **Run a workflow**, then **Order approval**. The CLI streams the execution, presents the approval request, and offers **Approve**, **Reject**, or **Leave pending**. Leaving it pending demonstrates that another process can recover the run later.

You can also enter the guided run flow directly. Omitting the workflow name opens the workflow picker:

```bash
npm run --silent workflow -- run
```

## Direct commands

Every interactive action also has a scriptable command:

```bash
npm run --silent workflow -- workflows
npm run --silent workflow -- runs
npm run --silent workflow -- run order-approval order-1001 12500
npm run --silent workflow -- inspect order-1001
npm run --silent workflow -- journal order-1001
npm run --silent workflow -- journal order-1001 --json
npm run --silent workflow -- resume order-1001
```

For non-interactive approval handling, use the hook-specific commands:

```bash
npm run --silent workflow -- approve order-1001 Grace
# or: npm run --silent workflow -- reject order-1001 Grace
```

## Run the delayed follow-up workflow

Start a second workflow that schedules a follow-up and sleeps for three seconds. The CLI prints an animated countdown, resolves the persisted workflow name when the timer fires, and resumes it automatically:

```bash
npm run --silent workflow -- run delayed-order-follow-up follow-up-1001 3000
```

If the CLI process is interrupted while waiting, recover the run from a new process:

```bash
npm run --silent workflow -- resume follow-up-1001
```

The CLI reads the run metadata, looks up `delayed-order-follow-up` in its workflow registry, prints the persisted pre-resume journal, and streams the new execution events. This is the same scheduling and dispatch role a production control plane would perform with a durable timer service instead of an in-process timeout.

The journal is stored in `.data/journals/` and workflow results in `.data/results/`. To use a different local data directory:

```bash
DURABLE_SAMPLE_DATA_DIR=/tmp/durable-sample npm run --silent workflow
```
