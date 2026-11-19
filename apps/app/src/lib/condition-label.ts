// SPDX-License-Identifier: AGPL-3.0-only
// What a saved view's condition says on its chip (CR-27, #3659): the words come from the catalog (`filterChips`), the
// amounts and dates through the person's formats, and an id through the names the screen knows. A condition that cannot be
// said in those words (a field the screen has no name for, an id it cannot name) is never printed raw ("gte 1000000", a
// uuid): the chips fold it into one "Điều kiện khác (n)" chip. No browser or API imports, so it is unit tested.
import type { FilterCondition } from '@ludy/kernel-contract';

// A translator over the whole catalog (i18n/runtime.ts `Translate`): the keys below are built at run time, so it is typed by
// its call shape here, and the catalog test checks that every key exists in both languages.
export type ChipTranslate = (key: string, values?: Record<string, string | number>) => string;

export interface ConditionWords {
  t: ChipTranslate;
  money: (amount: string) => string;
  date: (day: string) => string;
  // The names of the ids the screen knows (stages, members, companies), by id.
  names?: ReadonlyMap<string, string>;
}

export type ConditionScope = 'deal' | 'party';

// The catalog key of each field of the two scopes; a field that is not here has no name and is folded.
const FIELD_KEY: Record<string, string> = {
  search: 'search',
  stage: 'stage',
  status: 'status',
  owner: 'owner',
  party: 'party',
  amount: 'amount',
  expected_close: 'expectedClose',
  created: 'created',
  kind: 'kind',
  has_email: 'hasEmail',
  has_phone: 'hasPhone',
  has_tax_code: 'hasTaxCode',
  has_open_deal: 'hasOpenDeal',
  company: 'company',
};

const KINDS = new Set(['organization', 'person']);
const STATUSES = new Set(['open', 'won', 'lost']);

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// The chip text of one condition, or null when it cannot be said without a raw operator or id.
export function conditionText(_scope: ConditionScope, c: FilterCondition, x: ConditionWords): string | null {
  const key = FIELD_KEY[c.field];
  if (!key) return null;
  const field = x.t(`filterChips.field.${key}`);
  const v: unknown = c.value;
  const name = (id: unknown): string | null => (typeof id === 'string' ? (x.names?.get(id) ?? null) : null);
  const chip = (op: string, values: Record<string, string | number> = {}) => x.t(`filterChips.op.${op}`, { field, ...values });
  switch (c.op) {
    case 'contains':
      return isText(v) ? chip('contains', { value: v }) : null;
    case 'gte':
    case 'lte':
      return isText(v) ? chip(c.op, { value: x.money(v) }) : null;
    case 'before':
    case 'after':
      return isText(v) ? chip(c.op, { value: x.date(v) }) : null;
    case 'overdue':
      return chip('overdue');
    case 'is_empty':
      return chip('isEmpty');
    case 'is_me':
      return chip('isMe');
    case 'within_next_days':
      return isDays(v) ? chip('withinNext', { days: v }) : null;
    case 'within_last_days':
      return isDays(v) ? chip('withinLast', { days: v }) : null;
    case 'in': {
      if (!Array.isArray(v) || v.length === 0) return null;
      const names = v.map(name);
      return names.every((n): n is string => n !== null) ? chip('is', { value: names.join(', ') }) : null;
    }
    case 'is': {
      if (typeof v === 'boolean') return chip('is', { value: x.t(v ? 'filterChips.value.yes' : 'filterChips.value.no') });
      if (typeof v === 'string' && c.field === 'kind' && KINDS.has(v)) return chip('is', { value: x.t(`filterChips.value.${v}`) });
      if (typeof v === 'string' && c.field === 'status' && STATUSES.has(v)) return chip('is', { value: x.t(`filterChips.value.${v}`) });
      const n = name(v);
      return n === null ? null : chip('is', { value: n });
    }
    default:
      return null;
  }
}

export interface ConditionChip {
  key: string;
  label: string;
  // The positions in the `rest` list this chip stands for: removing the chip removes them all.
  indexes: number[];
}

// One chip per condition that can be said, and one "Điều kiện khác (n)" chip for all that cannot.
export function conditionChips(scope: ConditionScope, rest: readonly FilterCondition[], x: ConditionWords): ConditionChip[] {
  const chips: ConditionChip[] = [];
  const folded: number[] = [];
  rest.forEach((c, i) => {
    const label = conditionText(scope, c, x);
    if (label === null) folded.push(i);
    else chips.push({ key: `${c.field}:${c.op}:${i}`, label, indexes: [i] });
  });
  if (folded.length > 0) chips.push({ key: 'other', label: x.t('filterChips.other', { count: folded.length }), indexes: folded });
  return chips;
}
