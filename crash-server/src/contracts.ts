import { z } from 'zod';
export const PROTOCOL_VERSION = 2 as const;
export const GAME_ID = 'crash' as const;
export const placeBetSchema = z.object({ requestId: z.string().min(8).max(160), roundId: z.string().uuid(), amount: z.number().int().positive(), autoCashoutBp: z.number().int().min(101).optional() }).strict();
export const cashoutSchema = z.object({ requestId: z.string().min(8).max(160), roundId: z.string().uuid(), betId: z.string().uuid() }).strict();
export const syncSchema = z.object({ knownRoundId: z.string().uuid().optional(), knownSequence: z.number().int().nonnegative().optional() }).strict();
export type Envelope = { protocolVersion: 2; eventId: string; gameId: 'crash'; tableId: string; roundId: string | null; sequence: number; serverTime: string; payload: unknown };
export type Ack = { requestId: string; accepted: boolean; code: string; roundRevision: number; wallet?: number; result: unknown };
export function readHandshakeToken(auth: unknown): string {
  if (!auth || typeof auth !== 'object') return '';
  const value = (auth as Record<string, unknown>).accessToken ?? (auth as Record<string, unknown>).token;
  return typeof value === 'string' ? value : '';
}
export function commandAck(requestId: string, value: Record<string, unknown>): Ack {
  return { requestId, accepted: value.success === true, code: value.success === true ? 'OK' : String(value.code || 'REJECTED'), roundRevision: Number(value.stateVersion || 0), wallet: typeof value.wallet === 'number' ? value.wallet : undefined, result: value };
}
