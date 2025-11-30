import * as wf from '@temporalio/workflow';
import { User } from '../utils/chunker';
import { EnrichedUser } from '../activities/enrich';

const { loadCsvChunks, enrichChunk, saveChunk } = wf.proxyActivities<{
  loadCsvChunks: (csvPath: string, chunkSize: number) => Promise<User[][]>;
  enrichChunk: (chunk: User[]) => Promise<EnrichedUser[]>;
  saveChunk: (chunk: EnrichedUser[], wfId: string) => Promise<void>;
}>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '15 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2.0,
    maximumInterval: '30 seconds',
  },
});

export interface BatchInput {
  csvPath: string;
  chunkSize: number;
}

export async function batchWorkflow(input: BatchInput): Promise<{ processed: number }> {
  const { csvPath, chunkSize } = input;
  const wfInfo = wf.workflowInfo();

  // IMPORTANT: Don't read CSV in workflow! Delegate to activity or pre-stage.
  // For simplicity here, assume CSV is small & local; in prod, use activity to fetch from S3.
  const chunkedData = wf.executeChild(loadChunksWorkflow, {
    workflowId: `${wfInfo.workflowId}-chunks`,
    args: [csvPath, chunkSize],
  });

  const chunks = await chunkedData;

  const futures = [];
  for (const chunk of chunks) {
    const future = wf.executeChild(enrichAndSaveWorkflow, {
      workflowId: `${wfInfo.workflowId}-chunk-${Math.random().toString(36).slice(2, 6)}`,
      args: [chunk, wfInfo.workflowId],
    });
    futures.push(future);
  }

  const results = await Promise.all(futures);
  const total = results.reduce((sum, r) => sum + r.processed, 0);

  return { processed: total };
}

// Helper sub-workflow to isolate I/O (best practice)
export async function loadChunksWorkflow(csvPath: string, chunkSize: number): Promise<User[][]> {
  // // In prod: fetch from S3 via activity → return chunk metadata (e.g., S3 keys)
  // // Here: just simulate
  return await loadCsvChunks(csvPath, chunkSize);
}

// Note: Using child workflows for chunk processing gives better observability, 
// retry isolation, and avoids long-running single workflows.
export async function enrichAndSaveWorkflow(chunk: User[], wfId: string): Promise<{ processed: number }> {
  const enriched = await enrichChunk(chunk);
  await saveChunk(enriched, wfId);
  return { processed: enriched.length };
}