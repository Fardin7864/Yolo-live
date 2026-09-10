/**
 * Number formatting helpers shared by multiple screens.
 *
 * Kept tiny + pure so it imports cleanly into deep components without
 * dragging the rest of the utils tree along.
 */

/**
 * Shorten a positive integer to a compact label suitable for cramped
 * UI (chips, pots, balance pills). Examples:
 *
 *   formatCompactNumber(999)    => "999"
 *   formatCompactNumber(1500)   => "1.5K"
 *   formatCompactNumber(12500)  => "13K"
 *   formatCompactNumber(0)      => "0"
 *
 * The rounding rule (toFixed(1) below 10k, toFixed(0) above) matches
 * the original game formatting exactly so callers don't see a label change.
 */
export function formatCompactNumber(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.trunc(n));
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
}
