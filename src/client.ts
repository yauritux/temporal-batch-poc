import { Connection, Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { batchWorkflow } from './workflows/batch_all_in_memory';
import { cursorBatchWorkflow } from './workflows/batch_cursor_based';
import { nanoid } from 'nanoid';

async function run() {
  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  const client = new Client({ connection });

  // `npm run workflow -- cursor` or `npm run workflow -- in-memory`
  // default to cursor-based
  const [mode = 'cursor'] = process.argv.slice(2);

  const csvPath = 'dummy-data/users.csv';

  if (mode === 'in-memory') {
    // Pattern A: load all-in-memory batch
    const handle = await client.workflow.start(batchWorkflow, {
      taskQueue: 'batch-task',
      args: [
        {
          csvPath,
          chunkSize: 100,
        },
      ],
      workflowId: 'batch-in-memory-' + nanoid(),
    });

    console.log(`Started in-memory batch workflow ${handle.workflowId}`);
    const result = await handle.result();
    console.log('In-memory workflow result:', result);
  } else {
    // Pattern B: cursor-based batch (default)
    const handle = await client.workflow.start(cursorBatchWorkflow, {
      taskQueue: 'batch-task',
      args: [
        {
          csvPath,
          pageSize: 100,
        },
      ],
      workflowId: 'batch-cursor-' + nanoid(),
    });

    console.log(`Started cursor batch workflow ${handle.workflowId}`);
    const result = await handle.result();
    console.log('Cursor workflow result:', result);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
