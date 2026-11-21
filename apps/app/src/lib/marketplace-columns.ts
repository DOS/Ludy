// SPDX-License-Identifier: AGPL-3.0-only
// The pure half of the column screen for an unrecognised marketplace order report (#4036, slice 1c of #3850): which field a person (or Ly's first suggestion) put on which column, the mapping that
// choice makes, whether the verdict on screen still belongs to it, and what is held back from a press. Nothing here reads a file or calls the server; the server checks the mapping on the real file.
import { MARKETPLACE_COLUMN_FIELDS, MARKETPLACE_COLUMN_PLATFORMS, MARKETPLACE_COLUMN_RUNNING_MINUTES, type MarketplaceColumnAssignment, type MarketplaceColumnMapping, type MarketplaceColumnSheet, type MarketplaceColumnsStatus } from '@ludy/kernel-contract';

export type ColumnField = (typeof MARKETPLACE_COLUMN_FIELDS)[number];
export type ColumnPlatform = (typeof MARKETPLACE_COLUMN_PLATFORMS)[number];
/** The field a column carries; the empty string is "not used". */
export type FieldChoice = ColumnField | '';
/** Column index -> the field the person chose for it. A column absent from the record is not used. */
export type Selection = Readonly<Record<number, FieldChoice>>;

/** The order the fields are offered in: what identifies a line first, then the dates, the status, the goods and the money. */
export const FIELD_ORDER: readonly ColumnField[] = MARKETPLACE_COLUMN_FIELDS;

const isField = (value: string): value is ColumnField => (MARKETPLACE_COLUMN_FIELDS as readonly string[]).includes(value);
export const isFieldChoice = (value: string): value is FieldChoice => value === '' || isField(value);
export const isPlatform = (value: string): value is ColumnPlatform => (MARKETPLACE_COLUMN_PLATFORMS as readonly string[]).includes(value);

/** The columns a person may assign: every column of the masked sheet except a buyer's (those are never read, and the server refuses one). */
export function assignableIndexes(sheet: MarketplaceColumnSheet): number[] {
  return sheet.columns.filter((c) => !c.buyer).map((c) => c.index);
}

/**
 * A selection from assignments (Ly's first suggestion, or the mapping of the last check). An assignment for a column the sheet does not show as assignable, or for a field already placed, is dropped, so a
 * suggestion can never put a field on a buyer's column or twice.
 */
export function selectionFrom(sheet: MarketplaceColumnSheet, assignments: readonly MarketplaceColumnAssignment[]): Selection {
  const allowed = new Set(assignableIndexes(sheet));
  const placed = new Set<ColumnField>();
  const out: Record<number, FieldChoice> = {};
  for (const a of assignments) {
    if (!allowed.has(a.index) || placed.has(a.field) || out[a.index] !== undefined) continue;
    out[a.index] = a.field;
    placed.add(a.field);
  }
  return out;
}

/** The assignments a selection makes, in column order. */
export function assignmentsFrom(selection: Selection): MarketplaceColumnAssignment[] {
  return Object.entries(selection)
    .filter((e): e is [string, ColumnField] => e[1] !== '' && e[1] !== undefined)
    .map(([index, field]) => ({ index: Number(index), field }))
    .sort((a, b) => a.index - b.index);
}

/** The fields chosen for more than one column: the screen says so before the press (the server refuses it too). */
export function fieldsChosenTwice(selection: Selection): ColumnField[] {
  const seen = new Set<ColumnField>();
  const twice = new Set<ColumnField>();
  for (const field of Object.values(selection)) {
    if (field === '' || field === undefined) continue;
    if (seen.has(field)) twice.add(field);
    seen.add(field);
  }
  return FIELD_ORDER.filter((f) => twice.has(f));
}

/** The mapping to check: null until a platform is picked, at least one column is used and no field is on two columns. The platform is the person's pick, never the model's. */
export function mappingFrom(platform: ColumnPlatform | '', selection: Selection): MarketplaceColumnMapping | null {
  if (platform === '') return null;
  const assignments = assignmentsFrom(selection);
  if (assignments.length === 0 || fieldsChosenTwice(selection).length > 0) return null;
  return { platform, assignments };
}

/** Whether two mappings are the same ask: the platform and every assignment, in column order. */
export function sameMappings(a: MarketplaceColumnMapping | null, b: MarketplaceColumnMapping | null): boolean {
  if (a === null || b === null) return a === b;
  return a.platform === b.platform && a.assignments.length === b.assignments.length && a.assignments.every((x, i) => x.index === b.assignments[i]?.index && x.field === b.assignments[i]?.field);
}

/**
 * The verdict (a refusal or the parsed lines) on screen belongs to the mapping asked last. When the person changes a choice after that, the verdict is for another mapping and is not shown as if it
 * were this one's.
 */
export function verdictIsCurrent(asked: MarketplaceColumnMapping | null, current: MarketplaceColumnMapping | null): boolean {
  return asked !== null && sameMappings(asked, current);
}

/**
 * Whether a check that still waits was asked so long ago that its job is read as lost: the card stops polling and lets the person press again (the server accepts a new request after the same time).
 * A request without a time, or with one that cannot be read, is not stuck.
 */
export function checkIsStuck(status: Pick<MarketplaceColumnsStatus, 'state' | 'requestedAt'> | undefined, nowMs: number): boolean {
  if (status?.state !== 'requested' || status.requestedAt === null) return false;
  const asked = Date.parse(status.requestedAt);
  return Number.isFinite(asked) && nowMs - asked >= MARKETPLACE_COLUMN_RUNNING_MINUTES * 60_000;
}
