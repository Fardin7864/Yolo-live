export const LUCKY_DICE_OPTIONS = [
  { id: 'small', label: 'SMALL', detail: '4-10', multiplier: 2 },
  { id: 'big', label: 'BIG', detail: '11-17', multiplier: 2 },
  { id: 'odd', label: 'ODD', detail: 'No triple', multiplier: 2 },
  { id: 'even', label: 'EVEN', detail: 'No triple', multiplier: 2 },
  { id: 'any_triple', label: 'ANY TRIPLE', detail: 'All equal', multiplier: 31 },
  { id: 'total_6', label: 'TOTAL 6', detail: 'Exact total', multiplier: 15 },
  { id: 'total_9', label: 'TOTAL 9', detail: 'Exact total', multiplier: 7 },
  { id: 'total_12', label: 'TOTAL 12', detail: 'Exact total', multiplier: 7 },
  { id: 'total_15', label: 'TOTAL 15', detail: 'Exact total', multiplier: 15 },
] as const;

export const CHIP_AMOUNTS = [1000, 5000, 50000, 100000] as const;
