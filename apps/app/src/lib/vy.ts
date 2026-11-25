// SPDX-License-Identifier: AGPL-3.0-only
// Display gate and AI status helpers for the Global Top Bar's Vy quick drawer (#4926).
// The server re-checks vy.use, kill switches, and budgets on every Vy command.
import { VY_USE_PERMISSION, type AiMeter } from '@ludy/kernel-contract';

/** True when the member's resolved permissions include `vy.use`. */
export function canUseVy(permissions: readonly string[] | undefined): boolean {
  return Boolean(permissions?.includes(VY_USE_PERMISSION));
}

export type VyDrawerStatus = 'ready' | 'noPermission' | 'aiOff' | 'budgetStop';

/** Resolve the non-blocking status banner shown inside the Vy quick drawer. */
export function resolveVyDrawerStatus(input: {
  canUseVy: boolean;
  permissionsLoaded: boolean;
  meter: Pick<AiMeter, 'aiOn' | 'state'> | undefined;
}): VyDrawerStatus {
  if (input.permissionsLoaded && !input.canUseVy) return 'noPermission';
  if (input.meter && !input.meter.aiOn) return 'aiOff';
  if (input.meter?.state === 'stop') return 'budgetStop';
  return 'ready';
}

/** True when the compact Global Top Bar AI budget pill should render. */
export function showTopBarAiPill(
  meter: Pick<AiMeter, 'aiOn' | 'state' | 'percent'> | undefined,
): meter is Pick<AiMeter, 'aiOn' | 'state'> & { percent: number } {
  return Boolean(meter && meter.aiOn && meter.state !== 'none' && meter.percent !== null);
}
