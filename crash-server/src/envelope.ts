import { GAME_ID, PROTOCOL_VERSION, type Envelope } from './contracts.js';
import type { Sequencer } from './sequencer.js';
export async function envelope(seq: Sequencer, tableId: string, roundId: string | null, payload: unknown): Promise<Envelope> {
  return { protocolVersion: PROTOCOL_VERSION, eventId: crypto.randomUUID(), gameId: GAME_ID, tableId, roundId, sequence: await seq.next(), serverTime: new Date().toISOString(), payload };
}
