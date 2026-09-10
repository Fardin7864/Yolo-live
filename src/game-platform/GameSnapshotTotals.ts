type BackendPayload = Record<string, unknown>;

const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

const isRecord = (value: unknown): value is BackendPayload => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Resolve the shared pot totals for a game snapshot.
 *
 * `bet_totals` is the backend's complete per-position aggregate. `public_bets`
 * is only a recent activity feed and may be truncated or enriched differently
 * on each client, so it is used solely as a compatibility fallback.
 */
export function resolveSnapshotBetTotals(
  payload: BackendPayload,
  publicBets: BackendPayload[],
): Record<string, number> {
  if (isRecord(payload.bet_totals)) {
    return Object.fromEntries(
      Object.entries(payload.bet_totals).map(([position, amount]) => [position, asNumber(amount)]),
    );
  }

  return publicBets.reduce<Record<string, number>>((totals, bet) => {
    if (bet?.position) {
      const position = String(bet.position);
      totals[position] = asNumber(totals[position]) + asNumber(bet.amount);
    }
    return totals;
  }, {});
}
