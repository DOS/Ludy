// SPDX-License-Identifier: AGPL-3.0-only
// What a saved view's chips say (CR-27, #3659): words from the catalog in both languages, amounts and dates in the
// person's format, ids by name, and every condition that cannot be said folded into "Điều kiện khác (n)", never a raw
// operator or uuid.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FilterCondition } from '@ludy/kernel-contract';
import { ConditionChips } from '../src/components/condition-chips.tsx';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale, translatorFor } from '../src/i18n/runtime.ts';
import { conditionChips, conditionText, type ChipTranslate, type ConditionWords } from '../src/lib/condition-label.ts';

const STAGE = '11111111-1111-4111-8111-111111111111';
const words = (locale: 'vi' | 'en', names?: ReadonlyMap<string, string>): ConditionWords => ({
  t: translatorFor(locale) as unknown as ChipTranslate,
  money: (v) => `${v} đ`,
  date: (v) => v.split('-').reverse().join('/'),
  ...(names ? { names } : {}),
});
const c = (field: string, op: string, value?: unknown): FilterCondition => ({ field, op, ...(value === undefined ? {} : { value }) }) as FilterCondition;

describe('one condition in words', () => {
  it('says a value range, a date and a count of days without an operator name', () => {
    expect(conditionText('deal', c('amount', 'gte', '1000000'), words('vi'))).toBe('Giá trị: từ 1000000 đ');
    expect(conditionText('deal', c('amount', 'lte', '5000000'), words('en'))).toBe('Value: up to 5000000 đ');
    expect(conditionText('deal', c('expected_close', 'before', '2026-12-31'), words('vi'))).toBe('Dự kiến chốt: trước 31/12/2026');
    expect(conditionText('deal', c('expected_close', 'overdue'), words('vi'))).toBe('Dự kiến chốt: quá hạn');
    expect(conditionText('deal', c('created', 'within_last_days', 30), words('vi'))).toBe('Ngày tạo: trong 30 ngày qua');
    expect(conditionText('party', c('created', 'within_last_days', 1), words('en'))).toBe('Created: in the last 1 day');
    expect(conditionText('deal', c('owner', 'is_me'), words('vi'))).toBe('Người phụ trách: tôi');
  });

  it('says yes and no, a kind and a status by name', () => {
    expect(conditionText('party', c('has_email', 'is', true), words('vi'))).toBe('Có email: có');
    expect(conditionText('party', c('has_phone', 'is', false), words('en'))).toBe('Has phone: no');
    expect(conditionText('party', c('kind', 'is', 'organization'), words('vi'))).toBe('Loại: công ty');
    expect(conditionText('deal', c('status', 'is', 'won'), words('vi'))).toBe('Trạng thái: thắng');
  });

  it('names a stage by its name, and says nothing of an id it cannot name', () => {
    const names = new Map([[STAGE, 'Báo giá']]);
    expect(conditionText('deal', c('stage', 'in', [STAGE]), words('vi', names))).toBe('Giai đoạn: Báo giá');
    expect(conditionText('deal', c('stage', 'in', [STAGE]), words('vi'))).toBeNull();
    expect(conditionText('deal', c('stage', 'in', [STAGE, '22222222-2222-4222-8222-222222222222']), words('vi', names))).toBeNull();
  });

  it('has no words for an unknown field, an operator or a bad value', () => {
    expect(conditionText('deal', c('mystery', 'is', 'x'), words('vi'))).toBeNull();
    expect(conditionText('deal', c('amount', 'near', '5'), words('vi'))).toBeNull();
    expect(conditionText('deal', c('amount', 'gte'), words('vi'))).toBeNull();
    expect(conditionText('deal', c('created', 'within_last_days', 0), words('vi'))).toBeNull();
  });
});

describe('the chips of a view', () => {
  it('folds what cannot be said into one chip and keeps the others', () => {
    const rest = [c('amount', 'gte', '1000000'), c('stage', 'in', [STAGE]), c('mystery', 'is', 'x'), c('has_email', 'is', true)];
    const chips = conditionChips('deal', rest, words('vi'));
    expect(chips.map((x) => x.label)).toEqual(['Giá trị: từ 1000000 đ', 'Có email: có', 'Điều kiện khác (2)']);
    expect(chips[2]?.indexes).toEqual([1, 2]);
    for (const chip of chips) expect(chip.label).not.toMatch(/gte|lte|\bin\b|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('has the same keys in English as in Vietnamese', () => {
    const rest = [c('amount', 'gte', '1'), c('expected_close', 'within_next_days', 7), c('company', 'is_empty'), c('kind', 'is', 'person')];
    expect(conditionChips('party', rest, words('en')).map((x) => x.label)).toEqual(['Value: from 1 đ', 'Expected close: in the next 7 days', 'Company: empty', 'Type: person']);
  });
});

describe('the chip strip', () => {
  const render = (rest: FilterCondition[], locale: 'vi' | 'en' = 'vi') => {
    setActiveLocale(locale);
    return renderToStaticMarkup(
      <I18nProvider>
        <ConditionChips scope="deal" rest={rest} onChange={() => undefined} listLabel="Điều kiện khác của chế độ xem" removeLabel={(label) => `Bỏ điều kiện ${label}`} />
      </I18nProvider>,
    );
  };

  it('draws nothing without conditions, one removable chip per condition and one for the folded ones', () => {
    expect(render([])).toBe('');
    const html = render([c('amount', 'gte', '1000000'), c('mystery', 'is', 'x'), c('other', 'is', 'y')]);
    expect(html).toContain('Giá trị: từ 1.000.000');
    expect(html).toContain('Điều kiện khác (2)');
    expect(html).toContain('aria-label="Bỏ 2 điều kiện khác"');
    expect(html).not.toMatch(/gte|mystery/);
  });
});
