export interface QueuedBetPolicyInput {
  wallet: number;
  pendingTotal: number;
  existingOptionIds: Iterable<string>;
  pendingOptionIds: Iterable<string>;
  optionId: string;
  amount: number;
  maxOptions?: number;
  allowedAmounts?: Iterable<number>;
}

const ALLOWED_CHIPS = new Set([1000, 5000, 50000, 100000]);

export function evaluateQueuedBet(input: QueuedBetPolicyInput) {
  const allowedAmounts = new Set(input.allowedAmounts || ALLOWED_CHIPS);
  if (!Number.isSafeInteger(input.amount) || !allowedAmounts.has(input.amount)) {
    const choices = [...allowedAmounts]
      .sort((left, right) => left - right)
      .map((amount) => amount >= 1000 ? `${amount / 1000}K` : String(amount));
    return { accepted: false, message: `Choose a ${choices.join(', ')} chip.` } as const;
  }
  const selected = new Set([...input.existingOptionIds, ...input.pendingOptionIds, input.optionId]);
  const maxOptions = input.maxOptions ?? 6;
  if (selected.size > maxOptions) {
    return { accepted: false, message: `You can select up to ${maxOptions} options per round.` } as const;
  }
  if (input.wallet - input.pendingTotal < input.amount) {
    return { accepted: false, message: 'Insufficient balance.' } as const;
  }
  return { accepted: true, projectedBalance: input.wallet - input.pendingTotal - input.amount } as const;
}
