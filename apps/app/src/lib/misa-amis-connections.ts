// SPDX-License-Identifier: AGPL-3.0-only
// Pure rules of the MISA AMIS card (#3875): when it draws, and which entities can still be connected. The server enforces every rule; the screen offers only what can succeed.
import type { LegalEntity, MisaAmisConnection } from '@ludy/kernel-contract';

/** The card draws when the deployment offers the connector, or when the org already has a connection (so it can still be seen and disconnected). */
export function misaAmisCardShown(offered: boolean | undefined, connections: readonly MisaAmisConnection[] | undefined): boolean {
  return offered === true || (connections?.length ?? 0) > 0;
}

/** The entities that have no connection yet (one connection per entity). */
export function connectableEntities(entities: readonly LegalEntity[], connections: readonly MisaAmisConnection[]): LegalEntity[] {
  const taken = new Set(connections.map((c) => c.legalEntityId));
  return entities.filter((e) => !taken.has(e.id));
}
