# Little Durable workflow example

This is a sample project showing a minimal Control Plane driving little-durable.

It contains three workflows:

- Order Approval: shows a custom hook working.
- Delayed order followup: shows how sleep() works and can be handled in the control plane.
- Order Fulfillment: shows a failed step recovering with resume() without repeating completed work.

## Run

From the repository root:

```bash
pnpm install
cd examples/order-approval
npm install
npm run workflow
```

The sample automatically builds the linked root package first.

To run the failure recovery story directly:

```bash
npm run --silent workflow -- run order-fulfillment fulfillment-1001 2
npm run --silent workflow -- resume fulfillment-1001
```

The first command intentionally exits with a failure. The second starts a new process, prints the persisted journal, reuses `prepare-shipment`, and retries only `book-carrier-pickup`.
