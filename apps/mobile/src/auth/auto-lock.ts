// SPDX-License-Identifier: AGPL-3.0-only
// When the app locks itself (issue #4880): after it has been in the background for AUTO_LOCK_AFTER_MS, the next time it comes
// to the front it asks for the biometric again. A short trip to another app (a bank's OTP, a phone call) does not. Pure.
export const AUTO_LOCK_AFTER_MS = 60_000;

export function shouldAutoLock(backgroundedAt: number | null, now: number, afterMs: number = AUTO_LOCK_AFTER_MS): boolean {
  if (backgroundedAt === null) return false;
  // A clock that moved backwards is not a short trip: lock.
  return now < backgroundedAt || now - backgroundedAt >= afterMs;
}
