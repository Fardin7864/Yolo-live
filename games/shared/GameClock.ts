import type { GameSnapshot } from './types';

export function getRoundSecondsLeft(snapshot: GameSnapshot, now = Date.now()) {
  const endsAt = Date.parse(snapshot.round?.endsAt || '');
  if (!Number.isFinite(endsAt)) return 0;
  const serverNow = Date.parse(snapshot.serverNow);
  const clockOffset = snapshot.receivedAt - (Number.isFinite(serverNow) ? serverNow : snapshot.receivedAt);
  return Math.max(0, Math.ceil((endsAt + clockOffset - now) / 1000));
}

export function getResultSecondsLeft(snapshot: GameSnapshot, now = Date.now()) {
  const settledAt = Date.parse(String(snapshot.round?.result?.settled_at || ''));
  const roundEndsAt = Date.parse(snapshot.round?.endsAt || '');
  const resultStartedAt = Number.isFinite(settledAt)
    ? settledAt
    : roundEndsAt + snapshot.settlementSeconds * 1000;
  if (!Number.isFinite(resultStartedAt)) return 0;
  const serverNow = Date.parse(snapshot.serverNow);
  const clockOffset = snapshot.receivedAt - (Number.isFinite(serverNow) ? serverNow : snapshot.receivedAt);
  const resultEndsAt = resultStartedAt + snapshot.resultDisplaySeconds * 1000;
  return Math.max(0, Math.ceil((resultEndsAt + clockOffset - now) / 1000));
}
