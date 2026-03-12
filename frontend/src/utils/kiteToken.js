// Utility to check if Kite token is expired
export function isKiteTokenExpired(tokenUpdatedAt, expiryHours = 24) {
  if (!tokenUpdatedAt) return true;
  const updated = new Date(tokenUpdatedAt);
  if (isNaN(updated.getTime())) return true;
  const now = new Date();
  const diffMs = now - updated;
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours >= expiryHours;
}
