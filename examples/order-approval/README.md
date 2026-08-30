# Little Durable order approval example

A plain TypeScript/npm project that consumes `little-durable` from the root of this repository.

The sample demonstrates:

- a typed workflow created with `defineWorkflow`
- durable work wrapped in `step`
- streamed lifecycle events from both `Runtime.start` and `Runtime.resumeHook`
- a typed human-approval hook using `defineHook` and `waitFor`
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

Approve or reject it. Either command streams the resumed execution, reuses the journaled preparation result, resolves the hook, and records the decision:

```bash
npm run workflow -- approve order-1001 Grace
# or: npm run workflow -- reject order-1001 Grace
```

The journal is stored in `.data/journals/` and the final result in `.data/results/`.

To use a different local data directory:

```bash
DURABLE_SAMPLE_DATA_DIR=/tmp/durable-sample npm run workflow -- start order-1002
```
