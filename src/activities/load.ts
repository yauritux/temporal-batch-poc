import fs from 'fs';
import path from 'path';
import { User } from '../utils/chunker';

export async function loadCsvChunks(
    csvPath: string,
    chunkSize: number,
): Promise<User[][]> {
    const absPath = path.resolve(process.cwd(), csvPath);
    const content = fs.readFileSync(absPath, 'utf8');

    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    // If the first line is a header, skip it
    const dataLines = lines[0].startsWith('id,') ? lines.slice(1) : lines;

    const users: User[] = dataLines.map((line) => {
        const [id, firstName, lastName, email, gender, ipAddress] = line.split(',');
        return {
            id: Number(id),
            firstName,
            lastName,
            email,
            gender,
            ipAddress,
        } as User;
    });
    
    const chunks: User[][] = [];
    for (let i = 0; i < users.length; i += chunkSize) {
        chunks.push(users.slice(i, i + chunkSize));
    }

    return chunks;
}