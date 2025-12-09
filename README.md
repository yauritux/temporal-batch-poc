# Temporal Batch Processing POC

This project is a **Temporal** proof‑of‑concept that:

- Activities for I/O: Reads a CSV of users (dummy-data/users.csv). I generated this file with 1000 users using [this](https://mockaroo.com/?spm=a2ty_o01.29997173.0.0.606ec921SiarAB) tool.
- Chunking: Chunks the records.
- Data Processing (Enrichment) with Network Call: Calls a mock HTTP enrichment API for each user.
- I/O Operation: Saves enriched chunks to JSON files under `/tmp`.
- Uses **child workflows**, **activities**, **retries**, and **heartbeats**.

For detailed design notes and lessons learned, see
[docs/temporal-batch-design-notes.md](docs/temporal-batch-design-notes.md).

---

## Project structure

Key files:

- `src/worker.ts`  
  Temporal worker. Registers workflows and activities and polls the `batch-task` queue. Uses `workflowsPath: require.resolve('./workflows')` to load all workflows exported from [ `src/workflows/index.ts` ]

- `src/client.ts`  
  CLI client that starts either:
  - [batchWorkflow](`src/workflows/batch_all_in_memory.ts`)
  - [cursorBatchWorkflow](`src/workflows/batch_cursor_based.ts`)
  depending on the CLI argument (i.e., `in-memory` or `cursor`)

- `src/workflows/batch_all_in_memory.ts`
  "Pattern A - all-in-memory" workflow:
  - `batchWorkflow` - top level workflow.
  - `loadChunksWorkflow` – child workflow that orchestrates CSV loading.
  - Uses activities `loadCsvChunks`, `enrichChunk`, `saveChunk`.
  - Load all chunks into memory / workflow history at once (simple, but not scalable).

- `src/workflows/batch_cursor_based.ts`
  "Pattern B - cursor-based" workflow:
  - `cursorBatchWorkflow` - top level workflow.
  - Uses activity `loadNextCsvPage` to fetch one page at a time using a cursor.
  - Uses activities `enrichChunk`, `saveChunk`.
  - Keeps workflow history small and works better for large datasets.

- `src/workflows/index.ts`
  Barrel file exporting all workflows:

- `src/activities/load.ts`  
  Activities for loading data:
  - `loadCsvChunks` - reads full CSV, parses to `User[]`, splits into `User[][]`.
  - `loadNextCsvPage` - CSV paging with a cursor (`start index`, `pageSize`).

- `src/activities/enrich.ts`  
  Activity `enrichChunk`:
  - Iterates through a chunk/page of users.
  - Calls the mock API `POST /enrich`.
  - Uses `heartbeat()` to report progress.
  - On API failure:
    - Logs the error.
    - Returns a fallback `EnrichedUser` with `enriched: false` and `region: 'UNKNOWN'`.

- `src/activities/save.ts`  
  Activity `saveChunk`:
  - Writes each enriched chunk to `/tmp/batch-<workflowId>/chunk-<timestamp>.json`.

- `src/activities/index.ts`  
  Barrel file exporting `load`, `enrich`, and `save` activities.

- `src/mocks/api-server.ts`  
  Mock enrichment API on `http://localhost:3001/enrich` with a configurable failure rate.

- `src/utils/chunker.ts`  
  `User` type and CSV chunking helpers (used by activities).

- `dummy-data/users.csv`  
  Sample users to drive the batch workflow (1000 rows generated via Mockaroo).

---

## Prerequisites

- Node.js (compatible with TypeScript and Temporal SDK v1.13.x).
- npm.
- [Temporal CLI](https://docs.temporal.io/) (or another way to run a Temporal server, such as Docker compose).

---

## Installation

From the project root:

```bash
npm install
npm run build

## Running the project

1. Run the temporal server:

```bash
temporal server start-dev
```

OR, (if using Docker compose)

```bash
docker compose up -d
```

2. Run the worker:

```bash
npm run start.watch
```

3. Run the API server:

```bash
npm run api
```

4. Run the client:

```bash
npm run workflow
```
By default, this runs the **cursor-based workflow**. You can also run the **all-in-memory workflow** by passing the `in-memory` argument:

```bash
npm run workflow -- in-memory
```