import * as wf from '@temporalio/workflow';
import { User } from '../utils/chunker';
import { EnrichedUser } from '../activities/enrich';

interface PageResult<T> {
  items: T[];
  nextCursor: number | null;
}

// Cursor-based activities interface
const { loadNextCsvPage, enrichChunk, saveChunk } = wf.proxyActivities<{
  loadNextCsvPage: (
    csvPath: string,
    cursor: number | null,
    pageSize: number,
  ) => Promise<PageResult<User>>;
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

export interface CursorBatchInput {
  csvPath: string;
  pageSize: number;
}

// Cursor-based version: processes one page at a time using a cursor
export async function cursorBatchWorkflow(
  input: CursorBatchInput,
): Promise<{ processed: number }> {
  const { csvPath, pageSize } = input;
  const wfInfo = wf.workflowInfo();

  let cursor: number | null = null;
  let totalProcessed = 0;

  while (true) {
    const { items, nextCursor }: PageResult<User> = await loadNextCsvPage(csvPath, cursor, pageSize);

    if (items.length === 0) {
      break; // nothing left
    }

    // Option A: process page in this workflow via activities
    const enriched = await enrichChunk(items);
    await saveChunk(enriched, wfInfo.workflowId);
    totalProcessed += enriched.length;

    cursor = nextCursor;
    if (cursor === null) {
      break; // paging activity says we're done
    }
  }

  return { processed: totalProcessed };
}