import fs from 'fs';
import path from 'path';
import { EnrichedUser } from './enrich';

export async function saveChunk(chunk: EnrichedUser[], wfId: string): Promise<void> {
  const outDir = path.join('/tmp', `batch-${wfId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `chunk-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(chunk, null, 2));
  console.log(`✅ Saved ${chunk.length} records to ${outFile}`);
}