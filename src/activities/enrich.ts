import { heartbeat } from "@temporalio/activity";
import axios from "axios";
import { User } from "../utils/chunker";

export interface EnrichedUser extends User {
    enriched: boolean;
    region: string;
}

export async function enrichChunk (
    chunk: User[],
    // Uses heartbeat() for progress + auto-failure on error → leverages Temporal’s retry. 
): Promise<EnrichedUser[]> {
    const results: EnrichedUser[] = [];

    for (let i = 0; i < chunk.length; i++) {
        heartbeat(`${i + 1}/${chunk.length} processed`);

        try {
            const resp = await axios.post<EnrichedUser>(
                'http://localhost:3001/enrich',
                chunk[i],
                { timeout: 2000 }
            );
            results.push(resp.data);
        } catch (err: any) {
            const msg = err.response?.data?.error || err.message;
            // throw new Error(`Enrichment failed for user ${chunk[i].id}: ${msg}`);
            // Log error and continue workflow
            console.error(
                `Enrichment failed for user ${chunk[i].id}, marking as unenriched: ${msg}`
            );
            results.push({
                ...chunk[i],
                enriched: false,
                region: 'UNKNOWN',                
            } as EnrichedUser);
        }
    }

    return results;
}