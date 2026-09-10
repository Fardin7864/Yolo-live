export interface LedgerBetRequest {
  requestId: string;
  roundId: string;
  optionId: string;
  amount: number;
}

export interface LedgerBetResponse {
  requestId: string;
  accepted: boolean;
  queued?: boolean;
  balance?: number;
  betId?: string;
  message?: string;
}

type SubmissionState = 'reserved' | 'submitting' | 'accepted' | 'rejected';

interface SubmissionRecord {
  request: LedgerBetRequest;
  response: LedgerBetResponse;
  state: SubmissionState;
  createdAt: number;
}

export type RegisterSubmissionResult =
  | { kind: 'registered' }
  | { kind: 'duplicate'; response: LedgerBetResponse }
  | { kind: 'conflict'; response: LedgerBetResponse };

const sameRequest = (left: LedgerBetRequest, right: LedgerBetRequest) => (
  left.roundId === right.roundId
  && left.optionId === right.optionId
  && left.amount === right.amount
);

/**
 * Tracks client bet requests from local reservation through authoritative
 * settlement. The request id is the idempotency boundary used by the UI;
 * retries with the same payload receive the original response and can never
 * reserve the wallet twice.
 */
export class BetSubmissionLedger {
  private readonly records = new Map<string, SubmissionRecord>();

  register(request: LedgerBetRequest, response: LedgerBetResponse): RegisterSubmissionResult {
    const existing = this.records.get(request.requestId);
    if (existing) {
      if (sameRequest(existing.request, request)) {
        return { kind: 'duplicate', response: existing.response };
      }
      return {
        kind: 'conflict',
        response: {
          requestId: request.requestId,
          accepted: false,
          message: 'Duplicate bet request does not match the original bet.',
        },
      };
    }
    this.records.set(request.requestId, {
      request: { ...request },
      response: { ...response },
      state: 'reserved',
      createdAt: Date.now(),
    });
    this.prune();
    return { kind: 'registered' };
  }

  lookup(request: LedgerBetRequest): LedgerBetResponse | null {
    const existing = this.records.get(request.requestId);
    if (!existing) return null;
    if (!sameRequest(existing.request, request)) {
      return {
        requestId: request.requestId,
        accepted: false,
        message: 'Duplicate bet request does not match the original bet.',
      };
    }
    return existing.response;
  }

  markSubmitting(requestIds: Iterable<string>) {
    for (const requestId of requestIds) {
      const record = this.records.get(requestId);
      if (record && record.state === 'reserved') record.state = 'submitting';
    }
  }

  settle(
    requestIds: Iterable<string>,
    accepted: boolean,
    details: Omit<LedgerBetResponse, 'requestId' | 'accepted'> = {},
  ) {
    for (const requestId of requestIds) {
      const record = this.records.get(requestId);
      if (!record) continue;
      record.state = accepted ? 'accepted' : 'rejected';
      record.response = { requestId, accepted, ...details };
    }
    this.prune();
  }

  reservedTotal(roundId?: string) {
    let total = 0;
    for (const record of this.records.values()) {
      if ((record.state === 'reserved' || record.state === 'submitting')
        && (!roundId || record.request.roundId === roundId)) {
        total += record.request.amount;
      }
    }
    return total;
  }

  reservedByOption(roundId: string) {
    const totals = new Map<string, number>();
    for (const record of this.records.values()) {
      if ((record.state === 'reserved' || record.state === 'submitting')
        && record.request.roundId === roundId) {
        totals.set(record.request.optionId, (totals.get(record.request.optionId) || 0) + record.request.amount);
      }
    }
    return totals;
  }

  reservedOptionIds(roundId: string) {
    return this.reservedByOption(roundId).keys();
  }

  /** Releases oldest reservations already proven committed by a canonical snapshot. */
  acknowledgeCommitted(roundId: string, amount: number) {
    let remaining = Math.max(0, amount);
    const pending = [...this.records.values()]
      .filter((record) => record.request.roundId === roundId
        && (record.state === 'reserved' || record.state === 'submitting'))
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const record of pending) {
      if (remaining < record.request.amount) break;
      remaining -= record.request.amount;
      record.state = 'accepted';
      record.response = { ...record.response, accepted: true, queued: false };
    }
    this.prune();
  }

  clear() {
    this.records.clear();
  }

  private prune() {
    if (this.records.size <= 300) return;
    const completed = [...this.records.entries()]
      .filter(([, record]) => record.state === 'accepted' || record.state === 'rejected')
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    for (const [requestId] of completed) {
      if (this.records.size <= 200) break;
      this.records.delete(requestId);
    }
  }
}
