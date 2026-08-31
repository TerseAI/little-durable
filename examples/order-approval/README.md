# Little Durable workflow example

This is a sample project showing a minimal Control Plane driving little-durable.

It contains two workflows:
- Order Approval: shows a custom hook working.
- Delayed order followup: shows how sleep() works and can be handled in the control plane.

To use, simply clone little-durable, then cd into the folder

```bash
cd examples/order-approval
```

From there we have a very interactive prompt that should explain itself to you.

```bash
npm run workflow
```