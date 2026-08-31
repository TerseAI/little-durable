# Little Durable workflow example

This is a sample project showing a minimal Control Plane driving little-durable.

It contains three workflows:

- Order Approval: shows a custom hook working.
- Delayed order followup: shows how sleep() works and can be handled in the control plane.
- Order Fulfillment: shows a failed step recovering with resume() without repeating completed work.

To use, simply clone little-durable, then cd into the folder

```bash
cd examples/order-approval
```

From there we have a very interactive prompt that should explain itself to you.

```bash
npm run workflow
```

To run the failure recovery story directly:

```bash
npm run --silent workflow -- run order-fulfillment fulfillment-1001 2
npm run --silent workflow -- resume fulfillment-1001
```

The first command intentionally exits with a failure. The second starts a new process, prints the persisted journal, reuses `prepare-shipment`, and retries only `book-carrier-pickup`.
