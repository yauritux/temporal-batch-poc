import fs from 'fs';
import { parse } from 'csv-parse/sync';

export interface User {
  id: number;
  firstName: string;
  lastName: string;  
  email: string;
  gender: string;
  ipAddress: string;
}

export function loadAndChunkCSV(filePath: string, chunkSize = 10): User[][] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as User[];

  const chunks: User[][] = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize));
  }
  return chunks;
}