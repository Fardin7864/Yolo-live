export interface TeenPattiCard {
  value?: unknown;
  suit?: unknown;
}

export type TeenPattiHandRank = 'Trail' | 'Pure Sequence' | 'Sequence' | 'Color' | 'Pair' | 'High Card';

const valueOf = (value: unknown) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'A') return 14;
  if (normalized === 'K') return 13;
  if (normalized === 'Q') return 12;
  if (normalized === 'J') return 11;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 10 ? parsed : null;
};

const suitOf = (suit: unknown) => {
  const normalized = String(suit ?? '').trim().toUpperCase();
  const first = normalized.charAt(0);
  return ['C', 'D', 'H', 'S'].includes(first) ? first : null;
};

export function evaluateTeenPattiHand(cards: TeenPattiCard[]): TeenPattiHandRank | null {
  if (!Array.isArray(cards) || cards.length !== 3) return null;
  const parsed = cards.map((card) => ({ value: valueOf(card?.value), suit: suitOf(card?.suit) }));
  if (parsed.some((card) => card.value === null || card.suit === null)) return null;
  if (new Set(parsed.map((card) => `${card.value}:${card.suit}`)).size !== 3) return null;

  const values = parsed.map((card) => card.value as number).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const largestGroup = Math.max(...counts.values());
  const flush = parsed.every((card) => card.suit === parsed[0].suit);
  const sequence = new Set(values).size === 3 && (
    values.join(',') === '14,13,12'
    || values.join(',') === '14,3,2'
    || (values[0] === values[1] + 1 && values[1] === values[2] + 1)
  );

  if (largestGroup === 3) return 'Trail';
  if (sequence && flush) return 'Pure Sequence';
  if (sequence) return 'Sequence';
  if (flush) return 'Color';
  if (largestGroup === 2) return 'Pair';
  return 'High Card';
}

export function visibleTeenPattiRank(hand: { cards?: unknown; rank?: unknown } | null | undefined) {
  const cards = Array.isArray(hand?.cards) ? hand.cards as TeenPattiCard[] : [];
  return evaluateTeenPattiHand(cards) || String(hand?.rank || 'High Card');
}
