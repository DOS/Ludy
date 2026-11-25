// SPDX-License-Identifier: AGPL-3.0-only
// The code-first half of suggesting a minutes template (#4772): the words of a title, and the vote of the four signals. Pure functions, no database: the query that reads the signals is in the database test.
import { describe, expect, it } from 'vitest';
import { suggestTemplateFrom, titleTemplates, type TemplateSignals } from '../src/template-suggest.ts';

const signals = (over: Partial<TemplateSignals> = {}): TemplateSignals => ({ seriesTemplate: null, hasDeal: false, title: 'Họp', people: 3, ...over });

describe('titleTemplates', () => {
  it('finds the kind of meeting a title names, with or without accents and in any case', () => {
    expect(titleTemplates('Họp giao ban đầu tuần')).toEqual(['briefing']);
    expect(titleTemplates('GIAO BAN tuần 47')).toEqual(['briefing']);
    expect(titleTemplates('Daily stand-up')).toEqual(['briefing']);
    expect(titleTemplates('1:1 với Lan')).toEqual(['one_on_one']);
    // A date is no 1:1: "1-1" is left out of the list.
    expect(titleTemplates('Họp ngày 1-1')).toEqual([]);
    expect(titleTemplates('One on one')).toEqual(['one_on_one']);
    expect(titleTemplates('Báo giá cho khách A')).toEqual(['customer']);
    expect(titleTemplates('Demo sản phẩm')).toEqual(['customer']);
    expect(titleTemplates('Gặp nhà cung cấp vải')).toEqual(['supplier']);
    expect(titleTemplates('Họp NCC bao bì')).toEqual(['supplier']);
    expect(titleTemplates('Nhập hàng tháng 12')).toEqual(['supplier']);
  });
  it('counts a word whole, never inside another word', () => {
    // "sprinter" is no sprint and "nccx" is no ncc; a bare "khách" is left out of the list, so a "khách sạn" (a hotel) is no customer meeting.
    expect(titleTemplates('Sprinter van')).toEqual([]);
    expect(titleTemplates('Mã nccx')).toEqual([]);
    expect(titleTemplates('Khách sạn Bình Minh')).toEqual([]);
    expect(titleTemplates('Họp khách hàng Bình Minh')).toEqual(['customer']);
    expect(titleTemplates('Họp')).toEqual([]);
    expect(titleTemplates('')).toEqual([]);
  });
  it('lists every kind a title names, so a title that names two is a conflict for the vote', () => {
    expect(titleTemplates('Giao ban khách hàng')).toEqual(['briefing', 'customer']);
  });
});

describe('suggestTemplateFrom', () => {
  it('suggests when exactly one template has votes, with the reasons that voted', () => {
    expect(suggestTemplateFrom(signals({ title: 'Họp giao ban' }))).toEqual({ state: 'suggested', template: 'briefing', reasons: ['title'] });
    expect(suggestTemplateFrom(signals({ hasDeal: true }))).toEqual({ state: 'suggested', template: 'customer', reasons: ['deal'] });
    expect(suggestTemplateFrom(signals({ seriesTemplate: 'supplier' }))).toEqual({ state: 'suggested', template: 'supplier', reasons: ['series'] });
    // Several signals for the same template add up.
    expect(suggestTemplateFrom(signals({ hasDeal: true, title: 'Báo giá khách A', seriesTemplate: 'customer' }))).toEqual({ state: 'suggested', template: 'customer', reasons: ['series', 'deal', 'title'] });
  });
  it('cannot tell with no signal, or with two templates in conflict', () => {
    expect(suggestTemplateFrom(signals())).toEqual({ state: 'unknown', template: null, reasons: [] });
    expect(suggestTemplateFrom(signals({ hasDeal: true, title: 'Giao ban tuần' }))).toEqual({ state: 'unknown', template: null, reasons: [] });
    expect(suggestTemplateFrom(signals({ seriesTemplate: 'briefing', hasDeal: true }))).toEqual({ state: 'unknown', template: null, reasons: [] });
    expect(suggestTemplateFrom(signals({ title: 'Giao ban khách hàng' }))).toEqual({ state: 'unknown', template: null, reasons: [] });
  });
  it('lets exactly two people only corroborate a one-to-one another signal chose, never decide alone', () => {
    expect(suggestTemplateFrom(signals({ people: 2 }))).toEqual({ state: 'unknown', template: null, reasons: [] });
    expect(suggestTemplateFrom(signals({ people: 2, title: '1:1 Lan' }))).toEqual({ state: 'suggested', template: 'one_on_one', reasons: ['title', 'people'] });
    // Two people do not add a reason to another template.
    expect(suggestTemplateFrom(signals({ people: 2, hasDeal: true }))).toEqual({ state: 'suggested', template: 'customer', reasons: ['deal'] });
    // More people do not add the reason to a one-to-one.
    expect(suggestTemplateFrom(signals({ people: 3, title: '1:1 Lan' }))).toEqual({ state: 'suggested', template: 'one_on_one', reasons: ['title'] });
  });
});
