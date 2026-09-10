export function resizeAudioGuestSeats(seats, totalSlots) {
  const nextGuestSlots = Math.max(1, Math.min(11, Number(totalSlots) - 1));
  const next = Array.isArray(seats) ? seats.slice(0, nextGuestSlots) : [];
  while (next.length < nextGuestSlots) next.push(null);
  return next;
}

export function shouldApplyRealtimeRevision(currentRevision, incomingRevision) {
  const current = Number(currentRevision) || 0;
  const incoming = Number(incomingRevision) || 0;

  if (incoming === 0) return current === 0;
  return incoming >= current;
}
