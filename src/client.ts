import { Connection, Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { batchWorkflow } from './workflows/batch';
import { nanoid } from 'nanoid';

async function run() {
  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  const client = new Client({ connection });

  const handle = await client.workflow.start(batchWorkflow, {
    taskQueue: 'batch-task',
    args: [
      {
        csvPath: 'dummy-data/users.csv',
        chunkSize: 100,
      },
    ],
    workflowId: 'batch-' + nanoid(),
  });

  console.log(`Started workflow ${handle.workflowId}`);

  const result = await handle.result();
  console.log('Workflow result:', result);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
