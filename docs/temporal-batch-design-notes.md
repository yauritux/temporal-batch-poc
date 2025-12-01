---

## Batch Processing with Temporal – Findings & Lessons

This POC surfaced a few useful patterns and pitfalls when building batch workflows with Temporal.

### 1. Workflows orchestrate, activities do the work

- **Best practice**
  - Keep workflows **pure and deterministic**.
  - Put I/O, CPU‑heavy work, and non‑deterministic logic (HTTP calls, file access, randomness) in **activities**, not workflows.
- **What we did**
  - [batchWorkflow](../src/workflows/batch.ts) and [loadChunksWorkflow](../src/workflows/batch.ts) only orchestrate:
    - Child workflows
    - Activities ([loadCsvChunks](../src/activities/load.ts), [enrichChunk](../src/activities/enrich.ts), [saveChunk](../src/activities/save.ts))
  - CSV reading and parsing is in the [loadCsvChunks](../src/activities/load.ts) **activity**, not in workflow code.
- **Anti‑pattern to avoid**
  - Opening files or calling HTTP directly in a workflow function. This breaks determinism and makes replay unreliable.

---

### 2. Child workflows for decomposition & observability

- **Best practice**
  - Use **child workflows** to break a large batch into smaller, independently observable units:
    - Better visibility in Temporal Web (each child has its own history).
    - Better failure isolation and retry behavior.
- **What we did**
  - [batchWorkflow](../src/workflows/batch.ts):
    - Starts a child [loadChunksWorkflow](../src/workflows/batch.ts) to handle CSV loading and chunking.
    - For each chunk, starts a child [enrichAndSaveWorkflow](../src/workflows/batch.ts).
  - Each [enrichAndSaveWorkflow](../src/workflows/batch.ts) then runs [enrichChunk](../src/activities/enrich.ts) + [saveChunk](../src/activities/save.ts).
- **Anti‑pattern to avoid**
  - Doing an entire large batch in a single workflow run with a giant loop. You lose granularity in retries and observability and risk history limits.

---

### 3. Activity retries & timeouts matter

- **Best practice**
  - Always configure **timeouts** and **retry policies** on activities that talk to external services:
    - `startToCloseTimeout`
    - `heartbeatTimeout`
    - Reasonable retry policy (`maximumAttempts`, `initialInterval`, `backoffCoefficient`, `maximumInterval`).
- **What we did**
  - Proxied activities with:

    ```ts
    const { loadCsvChunks, enrichChunk, saveChunk } = wf.proxyActivities<...>({
      startToCloseTimeout: '5 minutes',
      heartbeatTimeout: '15 seconds',
      retry: {
        maximumAttempts: 3,
        initialInterval: '1 second',
        backoffCoefficient: 2.0,
        maximumInterval: '30 seconds',
      },
    });
    ```

- **Anti‑patterns to avoid**
  - No retry policy for flaky dependencies → transient errors fail the whole workflow needlessly.
  - Unbounded retries or no backoff → can overload downstream systems during incidents.

---

### 4. Heartbeats for long‑running activities

- **Best practice**
  - Use **`heartbeat()`** for long‑running activities to:
    - Report progress.
    - Detect worker crashes more quickly.
    - Allow Temporal to handle timeouts and retries gracefully.
- **What we did**
  - In [enrichChunk](../src/activities/enrich.ts), we call `heartbeat()` per user:

    ```ts
    heartbeat(`${i + 1}/${chunk.length} processed`);
    ```

- **Anti‑pattern to avoid**
  - A multi‑minute activity without heartbeats. If the worker dies, Temporal waits until full timeout before retrying; you lose visibility into where it was.

---

### 5. Handling downstream failures without killing the workflow

- **Best practice**
  - Decide *per use case* whether a downstream failure should:
    - Fail the activity/workflow, **or**
    - Be handled gracefully (log + mark record as “failed”).
- **What we did**
  - Mock API intentionally fails ~10% of the time:
    ```ts
    const fail = Math.random() < 0.10;
    ```
  - Initially we threw on any error → activities failed and cascaded to workflow failures.
  - Then we changed [enrichChunk](../src/activities/enrich.ts) to:
    - Log the error.
    - Push a fallback [EnrichedUser](../src/activities/enrich.ts) with `enriched: false` and `region: 'UNKNOWN'`.
- **Anti‑patterns to avoid**
  - Always throwing on every external error in batch jobs. For large batches, a few bad records shouldn’t necessarily kill the entire job.
  - Swallowing errors *silently* – you need logging or counters for failed records.

---

### 6. Managing parent / child relationships

- **Best practice**
  - Understand **parent close policies**:
    - If the parent fails or completes, what happens to children?
    - Default behavior often is to terminate children when the parent closes.
- **What we observed**
  - When [enrichChunk](../src/activities/enrich.ts) threw errors repeatedly, a child workflow failed, which then caused:
    - `ChildWorkflowFailure` → parent workflow failure.
    - Other workflows closed according to parent close policy (terminated “by parent close policy”).
- **Anti‑pattern to avoid**
  - Ignoring parent/child failure propagation. Design your error handling so you know when you expect a parent to fail vs. continue despite child issues.

---

### 7. File handling & output design

- **Best practice**
  - Use **activities** to interact with the filesystem.
  - Use per‑workflow output directories and idempotent-ish file naming.
- **What we did**
  - [saveChunk](../src/activities/save.ts) writes to:

    ```ts
    const outDir = path.join('/tmp', `batch-${wfId}`);
    const outFile = path.join(outDir, `chunk-${Date.now()}.json`);
    ```

- **Anti‑patterns to avoid**
  - Writing directly from workflow code.
  - Using shared file names without workflow‑specific prefixes (risk collisions when rerunning or overlapping workflows).

---

### 8. Type safety & determinism gotchas

- **Best practice**
  - Keep workflow types and activity signatures **in sync** with implementation.
  - Export every workflow function actually used by the worker:
    - If a child workflow isn’t exported from the workflow bundle, Temporal cannot run it.
- **What we hit**
  - [loadChunksWorkflow](../src/workflows/batch.ts) initially not exported → `no such function is exported by the workflow bundle`.
  - Activity type mismatches in `proxyActivities` (e.g. using [loadCsvChunks](../src/activities/load.ts) without declaring it in the type).
- **Anti‑pattern to avoid**
  - Relying on `as any` / forced casts around activities and workflows.
  - Forgetting to export workflows used with `executeChild`.

---

### 9. Testing & observability (future improvements)

Some natural next steps this POC suggests:

- Add **unit tests** for:
  - [loadCsvChunks](../src/activities/load.ts) (correct chunking & parsing).
  - [enrichChunk](../src/activities/enrich.ts) (happy path vs. failure path).
- Use **Temporal Web** or CLI to:
  - Inspect workflow histories.
  - Verify heartbeats, retries, and failure reasons.

These will help validate and evolve batch logic safely as you scale up.

---