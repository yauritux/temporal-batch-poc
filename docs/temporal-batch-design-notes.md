---

## Batch Processing with Temporal – Findings & Lessons

This POC surfaced a few useful patterns and pitfalls when building batch workflows with Temporal.

### Patterns in this POC

This POC intentionally implements **two** batch patterns:

- **Pattern A - all-in-memory batch**
  - Workflow: [`batchWorkflow`](../src/workflows/batch_all_in_memory.ts)
  - Behavior:
    - Uses activity `loadCsvChunks` to load and chunk the **entire dataset** (CSV) upfront.
    - The workflow then fans out child workflows `loadChunksWorkflow`.
  - Trade-offs:
    - Simple and easy to understand.
    - For large datasets, the complete `User[][]` ends up in workflow history → **large histories, slower replay, potential size limits**.

- **Pattern B - Cursor-based batch**
  - Workflow: [`cursorBatchWorkflow`](../src/workflows/batch_cursor_based.ts)
  - Behavior:
    - Uses activity `loadNextCsvPage(csvPath, cursor, pageSize)` to fetch **one page at a time**.
    - Workflow keeps only:
      - Current `cursor` (e.g., starting index).
      - Current page `items: User[]`.
    - Calls `enrichChunk` and `saveChunk` per page.
  - Trade-offs:
    - More boilerplate, but **scales better** to large datasets.
    - Workflow history remains small; You never materialize the full dataset in memory at once.

### 1. Workflows orchestrate, activities do the work

- **Best practice**
  - Keep workflows **pure and deterministic**.
  - Put I/O, CPU‑heavy work, and non‑deterministic logic (HTTP calls, file access, randomness) in **activities**, not workflows.
- **What we did**
  - In the **all-in-memory** pattern:
    - [batchWorkflow](../src/workflows/batch-all-in-memory.ts) and [loadChunksWorkflow](../src/workflows/batch-all-in-memory.ts) only orchestrate:
      - Child workflows
      - Activities ([loadCsvChunks](../src/activities/load.ts), [enrichChunk](../src/activities/enrich.ts), [saveChunk](../src/activities/save.ts))
      - CSV reading and parsing is in the [loadCsvChunks](../src/activities/load.ts) **activity**, not in workflow code.
  - In the **cursor-based** pattern:
    - [cursorBatchWorkflow](../src/workflows/batch_cursor_based.ts) orchestrates paging via the `loadNextCsvPage` activity and then calls `enrichChunk` and `saveChunk` for each page.
  - CSV reading and parsing is in the `loadCsvChunks` / `loadNextCsvPage` **activities**, not in the workflow code.
- **Anti‑pattern to avoid**
  - Opening files or calling HTTP directly in a workflow function. This breaks determinism and makes replay unreliable.

---

### 2. Child workflows for decomposition & observability

- **Best practice**
  - Use **child workflows** to break a large batch into smaller, independently observable units:
    - Better visibility in Temporal Web (each child has its own history).
    - Better failure isolation and retry behavior.
- **What we did**
  - In the **all-in-memory** pattern:  
    - [batchWorkflow](../src/workflows/batch_all_in_memory.ts):
      - Starts a child [loadChunksWorkflow](../src/workflows/batch_all_in_memory.ts) to handle CSV loading and chunking.
      - For each chunk, starts a child [enrichAndSaveWorkflow](../src/workflows/batch_all_in_memory.ts).
    - Each [enrichAndSaveWorkflow](../src/workflows/batch.ts) then runs [enrichChunk](../src/activities/enrich.ts) + [saveChunk](../src/activities/save.ts).
  - In the **cursor-based** pattern:
    - [cursorBatchWorkflow](../src/workflows/batch_cursor_based.ts) does not create additional child workflows per chunk in this POC; instead it:
      - Iterates in a loop, calling the `loadNextCsvPage` activity to fetch the next page.
      - For each page, calls `enrichChunk` and `saveChunk` directly for each page.
    - This still follows the same principle: workflows orchestrate pages/chunks; activites perform I/O and enrichment.
    - We don't use child workflows in this POC since the main goal is to keep workflow history small by paging through data via `loadNextCsvPage`. For many use cases, a single workflow with a loop + activities is sufficient.
    - However, you might combine both patterns (i.e., add child workflows to a cursor pattern) when you also want:
      - **Per-page child workflows** for observability and isolation, e.g.,:
      ```typescript
      for each page:
        executeChild(processPageWorkflow, args=[cursor, pageItems])
      ```
      - **Different retry semantics per page**
      - **Cross-team ownership**. E.g., Parent owns orchestration, children own "process this page / this merchant / this region".
- **Anti‑pattern to avoid**
  - Doing an entire large batch in a single workflow run with a giant loop that:
    - Loads *all* items into memory inside the workflow, or
    - Iterates over thousands of items without any paging or chunking.
    This leads to very large histories, slow replay, and possibly hitting history limits.
  - Using child workflows or activities that each still process an unbounded amount of data.
  Child workflows help with isolation/visibility, but they do not fix scalability if each child still loads "everything at once". Combine child workflows with **chunking or cursor-based paging**.

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
  - [loadChunksWorkflow](../src/workflows/batch_all_in_memory.ts) initially not exported → `no such function is exported by the workflow bundle`.
  - Activity type mismatches in `proxyActivities` (e.g. using [loadCsvChunks](../src/activities/load.ts) without declaring it in the type).
- **Anti‑pattern to avoid**
  - Relying on `as any` / forced casts around activities and workflows.
  - Forgetting to export workflows used with `executeChild`.

---