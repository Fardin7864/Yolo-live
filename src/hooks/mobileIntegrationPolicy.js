const DEFAULT_LUCKY_BAG_VISIBLE_MS = 75000;

export function createClientRequestUuid(randomSource = Math.random) {
  const bytes = new Uint8Array(16);
  const cryptoObject = globalThis?.crypto;
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(randomSource() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function luckyBagExpiryDelayMs(expiryOrDelay, now = Date.now()) {
  if (typeof expiryOrDelay === 'number' && Number.isFinite(expiryOrDelay)) {
    return Math.max(0, expiryOrDelay);
  }
  const expiresAt = new Date(expiryOrDelay || '').getTime();
  return Number.isFinite(expiresAt)
    ? Math.max(0, expiresAt - now + 250)
    : DEFAULT_LUCKY_BAG_VISIBLE_MS;
}
