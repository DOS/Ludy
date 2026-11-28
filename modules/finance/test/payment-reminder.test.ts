// SPDX-License-Identifier: AGPL-3.0-only
// The rules of customer payment reminders (#2488): due dates and what is still owed per invoice (the customer's 131 balance laid over its
// invoices newest first), the notice level, the language, the fixed words, and the mail as rendered from its stored facts.
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_TERMS_DAYS,
  addDays,
  allForeignAmountsOf,
  allocateReceivable,
  daysBetween,
  foreignTotalsOf,
  isCollectionPaused,
  noticeLevel,
  overdueOf,
  paymentReminderSource,
  paymentReminderSourceLevel,
  reminderLang,
  renderPaymentReminderMail,
  templateWords,
  totalOf,
  type SaleInvoice,
} from '../src/index.ts';

const inv = (n: string, date: string, total: string, currency = 'VND'): SaleInvoice => ({ id: `00000000-0000-7000-8000-0000000000${n.padStart(2, '0')}`, series: 'C26TAA', number: n, date, total, currency });

describe('dates', () => {
  it('adds days across months and leap days, and counts them back', () => {
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-11-03', '2026-11-20')).toBe(17);
    expect(daysBetween('2026-11-20', '2026-11-03')).toBe(-17);
  });
});

describe('allocateReceivable', () => {
  const today = '2026-11-03';

  it('leaves the newest invoices open when the balance is less than everything invoiced (oldest paid first)', () => {
    const r = allocateReceivable([inv('1', '2026-08-01', '1000000'), inv('2', '2026-09-01', '2000000'), inv('3', '2026-10-01', '3000000')], '3500000', today);
    expect(r.open.map((i) => [i.number, i.amountDue])).toEqual([
      ['2', '500000'],
      ['3', '3000000'],
    ]);
    expect(r.other).toBe('0');
  });

  it('counts a partial payment against the oldest invoice still open', () => {
    // 4,000,000 invoiced, 1,500,000 received: invoice 1 (1,000,000) and half of invoice 2 are settled.
    const r = allocateReceivable([inv('1', '2026-08-01', '1000000'), inv('2', '2026-08-15', '1000000'), inv('3', '2026-09-01', '2000000')], '2500000', today);
    expect(r.open.map((i) => [i.number, i.amountDue])).toEqual([
      ['2', '500000'],
      ['3', '2000000'],
    ]);
  });

  it('dates each invoice against the terms and today', () => {
    const [only] = allocateReceivable([inv('1', '2026-09-20', '1000000')], '1000000', today).open;
    expect(only?.dueDate).toBe(addDays('2026-09-20', PAYMENT_TERMS_DAYS));
    expect(only?.dueDate).toBe('2026-10-20');
    expect(only?.daysOverdue).toBe(14);
    // The same invoice with longer terms is not due yet.
    const [later] = allocateReceivable([inv('1', '2026-09-20', '1000000')], '1000000', today, 60).open;
    expect(later?.daysOverdue).toBe(-16);
  });

  it('keeps a balance no invoice covers as other, never as an invoice', () => {
    const r = allocateReceivable([inv('1', '2026-09-01', '1000000')], '1800000', today);
    expect(r.open.map((i) => [i.number, i.amountDue])).toEqual([['1', '1000000']]);
    expect(r.other).toBe('800000');
  });

  it('leaves nothing open for a settled or credit balance', () => {
    expect(allocateReceivable([inv('1', '2026-09-01', '1000000')], '0', today).open).toEqual([]);
    expect(allocateReceivable([inv('1', '2026-09-01', '1000000')], '-250000', today)).toEqual({ open: [], other: '0' });
  });

  it('orders ties by number as a number and never depends on the input order', () => {
    const a = allocateReceivable([inv('9', '2026-09-01', '100'), inv('10', '2026-09-01', '100')], '100', today);
    const b = allocateReceivable([inv('10', '2026-09-01', '100'), inv('9', '2026-09-01', '100')], '100', today);
    expect(a.open.map((i) => i.number)).toEqual(['10']);
    expect(b).toEqual(a);
  });

  it('adds fractions exactly', () => {
    const r = allocateReceivable([inv('1', '2026-09-01', '0.1'), inv('2', '2026-09-02', '0.2')], '0.3', today);
    expect(totalOf(r.open)).toBe('0.3');
  });

  it('skips invoices with no amount', () => {
    expect(allocateReceivable([inv('1', '2026-09-01', '0'), inv('2', '2026-09-02', '-5')], '10', today)).toEqual({ open: [], other: '10' });
  });

  it('keeps exact foreign amounts on unpaid invoices and leaves foreignAmountDue null on partially paid invoices', () => {
    const r = allocateReceivable(
      [
        { ...inv('1', '2026-08-01', '25450000', 'USD'), foreignTotal: '1000.0000' },
        { ...inv('2', '2026-09-01', '5090000', 'USD'), foreignTotal: '200.0000' },
        inv('3', '2026-09-15', '1000000', 'VND'),
      ],
      '18815000',
      today,
    );
    expect(r.open.map((i) => [i.number, i.amountDue, i.foreignTotal, i.foreignAmountDue])).toEqual([
      ['1', '12725000', '1000', null],
      ['2', '5090000', '200', '200'],
      ['3', '1000000', null, null],
    ]);
    expect(foreignTotalsOf(r.open, 'VND')).toEqual([{ currency: 'USD', amountDue: '200' }]);
    expect(allForeignAmountsOf(r.open, 'VND')).toBe(false);
  });

  it('sums foreign totals per currency accurately and sorts deterministically', () => {
    const r = allocateReceivable(
      [
        { ...inv('1', '2026-08-01', '2545000', 'USD'), foreignTotal: '0.1' },
        { ...inv('2', '2026-08-02', '5090000', 'USD'), foreignTotal: '0.2' },
        { ...inv('3', '2026-08-03', '2800000', 'EUR'), foreignTotal: '100.50' },
      ],
      '10435000',
      today,
    );
    expect(foreignTotalsOf(r.open, 'VND')).toEqual([
      { currency: 'EUR', amountDue: '100.5' },
      { currency: 'USD', amountDue: '0.3' },
    ]);
    expect(allForeignAmountsOf(r.open, 'VND')).toBe(true);
    expect(allForeignAmountsOf([], 'VND')).toBe(false);
  });

  it('never estimates fractional foreign amounts for partially paid zero-decimal currencies such as CLP', () => {
    const r = allocateReceivable(
      [{ ...inv('1', '2026-08-01', '1000', 'CLP'), foreignTotal: '1' }],
      '500',
      today,
    );
    expect(r.open[0]).toMatchObject({ amountDue: '500', foreignTotal: '1', foreignAmountDue: null });
    expect(foreignTotalsOf(r.open, 'VND')).toEqual([]);
    expect(allForeignAmountsOf(r.open, 'VND')).toBe(false);
  });

  it('treats zero foreign_total (such as "0.0000") as absent so booked amounts are shown instead of 0 USD', () => {
    const r = allocateReceivable(
      [{ ...inv('1', '2026-08-01', '25450000', 'USD'), foreignTotal: '0.0000' }],
      '25450000',
      today,
    );
    expect(r.open[0]).toMatchObject({ amountDue: '25450000', foreignTotal: null, foreignAmountDue: null });
    expect(foreignTotalsOf(r.open, 'VND')).toEqual([]);
    expect(allForeignAmountsOf(r.open, 'VND')).toBe(false);
  });
});

describe('notice level and language', () => {
  it('goes by the oldest overdue invoice', () => {
    expect(noticeLevel([])).toBeNull();
    expect(noticeLevel([{ daysOverdue: 1 }])).toBe(1);
    expect(noticeLevel([{ daysOverdue: 14 }, { daysOverdue: 3 }])).toBe(1);
    expect(noticeLevel([{ daysOverdue: 15 }])).toBe(2);
    expect(noticeLevel([{ daysOverdue: 29 }, { daysOverdue: 2 }])).toBe(2);
    expect(noticeLevel([{ daysOverdue: 30 }])).toBe(3);
  });

  it('reads overdue as at least one day late', () => {
    const r = allocateReceivable([inv('1', '2026-10-04', '100')], '100', '2026-11-03');
    // Due 2026-11-03 itself: not late yet.
    expect(r.open[0]?.daysOverdue).toBe(0);
    expect(overdueOf(r)).toEqual([]);
  });

  it('writes English only when every invoice is in a foreign currency', () => {
    expect(reminderLang([{ currency: 'VND' }])).toBe('vi');
    expect(reminderLang([{ currency: 'USD' }, { currency: 'VND' }])).toBe('vi');
    expect(reminderLang([{ currency: 'USD' }, { currency: 'EUR' }])).toBe('en');
    expect(reminderLang([])).toBe('vi');
    // Documents recorded before the currency rules may spell the book currency in lower case.
    expect(reminderLang([{ currency: 'vnd' }, { currency: ' VND ' }])).toBe('vi');
  });
});

describe('templateWords', () => {
  it('holds no digit, so the amounts and dates can only come from the facts', () => {
    for (const lang of ['vi', 'en'] as const) {
      for (const level of [1, 2, 3] as const) {
        const w = templateWords({ level, lang, customer: 'Khách', org: 'Công ty' });
        expect(`${w.greeting} ${w.lead} ${w.closing}`).not.toMatch(/\d/);
        expect(w.subject.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the subject within what a send accepts, however long the name', () => {
    for (const lang of ['vi', 'en'] as const) expect(templateWords({ level: 3, lang, customer: 'A', org: 'X'.repeat(200) }).subject.length).toBeLessThanOrEqual(200);
  });

  it('gets firmer with the level and stays polite', () => {
    const l = (level: 1 | 2 | 3) => templateWords({ level, lang: 'vi', customer: 'A', org: 'B' }).lead;
    expect(new Set([l(1), l(2), l(3)]).size).toBe(3);
    expect(l(3)).toContain('cuối cùng');
  });
});

describe('renderPaymentReminderMail', () => {
  const base = {
    lang: 'vi' as const,
    level: 1 as const,
    org: 'Công ty TNHH Ánh Dương',
    greeting: 'Kính gửi Quý khách <b>Lan</b>,',
    lead: 'Các hóa đơn dưới đây đã đến hạn.',
    closing: 'Trân trọng cảm ơn.',
    invoices: [
      { series: 'C26TAA', number: '12', date: '2026-09-01', dueDate: '2026-10-01', daysOverdue: 33, amountDue: '1234567', currency: 'VND' },
      { series: '', number: '13', date: '2026-09-05', dueDate: '2026-10-05', daysOverdue: 29, amountDue: '500000', currency: 'VND' },
    ],
    count: 2,
    total: '1734567',
    currency: 'VND',
    payTo: { bank: 'Vietcombank', number: '0011223344', holder: 'Công ty TNHH Ánh Dương' },
  };

  it('builds the facts from the stored data, with the bank account and the total', () => {
    const mail = renderPaymentReminderMail(base, { replyTo: 'in@example.test' });
    expect(mail.text).toContain('1.234.567 đồng');
    expect(mail.text).toContain('Tổng cộng: 1.734.567 đồng');
    expect(mail.text).toContain('Số tài khoản: 0011223344');
    expect(mail.text).toContain('01/10/2026');
    expect(mail.replyTo).toBe('in@example.test');
  });

  it('escapes the words in the html', () => {
    const mail = renderPaymentReminderMail(base, { replyTo: null });
    expect(mail.html).toContain('&lt;b&gt;Lan&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Lan</b>');
    expect(mail.replyTo).toBeUndefined();
  });

  it('says how many invoices a cut list leaves out, and leaves the bank block out without an account', () => {
    const mail = renderPaymentReminderMail({ ...base, count: 5, payTo: null }, { replyTo: null });
    expect(mail.text).toContain('Và 3 hóa đơn quá hạn khác');
    expect(mail.text).not.toContain('Thông tin chuyển khoản');
  });

  it('renders English for an English reminder, naming the book currency by its code and English grouping', () => {
    const mail = renderPaymentReminderMail({ ...base, lang: 'en' }, { replyTo: null });
    expect(mail.text).toContain('Total: 1,734,567 VND');
    expect(mail.text).not.toContain('đồng');
    expect(mail.html).toContain('lang="en"');
  });

  it('keeps an invoice series and number on one line', () => {
    const mail = renderPaymentReminderMail({ ...base, invoices: [{ ...base.invoices[0], series: 'C26\nTAA', number: '1\r\n2' }] , count: 1 }, { replyTo: null });
    expect(mail.text).toContain('số 1 2, ký hiệu C26 TAA');
  });

  it('refuses merge data that is not what the template needs', () => {
    expect(() => renderPaymentReminderMail({ ...base, invoices: [] }, { replyTo: null })).toThrow();
    expect(() => renderPaymentReminderMail({ lang: 'fr' }, { replyTo: null })).toThrow();
  });

  it('shows foreign currency amounts alongside booked book-currency amounts in English mail', () => {
    const mail = renderPaymentReminderMail(
      {
        ...base,
        lang: 'en',
        invoices: [
          {
            series: 'C26TAA',
            number: '12',
            date: '2026-09-01',
            dueDate: '2026-10-01',
            daysOverdue: 33,
            amountDue: '25450000',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: '1000',
            foreignAmountDue: '1000',
          },
          {
            series: 'C26TAA',
            number: '14',
            date: '2026-09-10',
            dueDate: '2026-10-10',
            daysOverdue: 24,
            amountDue: '12725000',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: '1000',
            foreignAmountDue: '500',
          },
        ],
        count: 2,
        total: '38175000',
        currency: 'VND',
        foreignTotals: [{ currency: 'USD', amountDue: '1500' }],
        allForeignAmounts: true,
      },
      { replyTo: null },
    );
    expect(mail.text).toContain('1,000 USD (booked: 25,450,000 VND)');
    expect(mail.text).toContain('500 USD (invoice 1,000 USD; booked: 12,725,000 VND)');
    expect(mail.text).toContain('Total: 1,500 USD (booked: 38,175,000 VND)');
    expect(mail.html).toContain('1,000 USD<br><span');
    expect(mail.html).toContain('booked: 25,450,000 VND');
  });

  it('clearly labels booked amounts when a foreign-currency invoice has no foreign total or is partially paid', () => {
    const mail = renderPaymentReminderMail(
      {
        ...base,
        lang: 'en',
        invoices: [
          {
            series: 'C26TAA',
            number: '15',
            date: '2026-09-01',
            dueDate: '2026-10-01',
            daysOverdue: 33,
            amountDue: '25450000',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: null,
            foreignAmountDue: null,
          },
          {
            series: 'C26TAA',
            number: '15b',
            date: '2026-09-02',
            dueDate: '2026-10-02',
            daysOverdue: 32,
            amountDue: '100',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: '1',
            foreignAmountDue: null,
          },
        ],
        count: 2,
        total: '25450100',
        currency: 'VND',
        allForeignAmounts: false,
      },
      { replyTo: null },
    );
    expect(mail.text).toContain('25,450,000 VND (booked; USD invoice)');
    expect(mail.text).toContain('100 VND (booked; 1 USD invoice)');
    expect(mail.text).not.toContain('0 USD');
    expect(mail.text).toContain('Total (booked): 25,450,100 VND');
  });

  it('uses explicit allForeignAmounts: false when a cut list omits a non-foreign tail invoice', () => {
    const mail = renderPaymentReminderMail(
      {
        ...base,
        lang: 'en',
        invoices: [
          {
            series: 'C26TAA',
            number: '18',
            date: '2026-09-01',
            dueDate: '2026-10-01',
            daysOverdue: 33,
            amountDue: '25450000',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: '1000',
            foreignAmountDue: '1000',
          },
        ],
        count: 2,
        total: '26450000',
        currency: 'VND',
        foreignTotals: [{ currency: 'USD', amountDue: '1000' }],
        allForeignAmounts: false,
      },
      { replyTo: null },
    );
    expect(mail.text).toContain('Total (booked): 26,450,000 VND (includes 1,000 USD)');
  });

  it('labels booked total and includes foreign summary when a customer owes mixed VND and foreign invoices', () => {
    const mail = renderPaymentReminderMail(
      {
        ...base,
        lang: 'vi',
        invoices: [
          {
            series: 'C26TAA',
            number: '16',
            date: '2026-09-01',
            dueDate: '2026-10-01',
            daysOverdue: 33,
            amountDue: '25450000',
            currency: 'VND',
            invoiceCurrency: 'USD',
            foreignTotal: '1000',
            foreignAmountDue: '1000',
          },
          {
            series: 'C26TAA',
            number: '17',
            date: '2026-09-05',
            dueDate: '2026-10-05',
            daysOverdue: 29,
            amountDue: '500000',
            currency: 'VND',
            invoiceCurrency: 'VND',
            foreignTotal: null,
            foreignAmountDue: null,
          },
        ],
        count: 2,
        total: '25950000',
        currency: 'VND',
        foreignTotals: [{ currency: 'USD', amountDue: '1000' }],
      },
      { replyTo: null },
    );
    expect(mail.text).toContain('1.000 USD (ghi sổ: 25.450.000 đồng)');
    expect(mail.text).toContain('500.000 đồng');
    expect(mail.text).toContain('Tổng cộng (ghi sổ): 25.950.000 đồng (gồm 1.000 USD)');
  });
});

describe('paymentReminderSource', () => {
  it('encodes notice level and legal entity id safely for mail_message.source and parses both scoped and legacy forms', () => {
    const source = paymentReminderSource(2, '0195a1b2-c3d4-7000-8000-1234567890ab');
    expect(source).toBe('finance.payment_reminder.notice2.e0195a1b2c3d4700080001234567890ab');
    expect(source.length).toBeLessThanOrEqual(100);
    expect(source).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    expect(paymentReminderSourceLevel(source)).toBe(2);
    expect(paymentReminderSourceLevel('finance.payment_reminder.notice1')).toBe(1);
    expect(paymentReminderSourceLevel('finance.payment_reminder.notice4')).toBeNull();
  });
});

describe('isCollectionPaused', () => {
  it('treats today and future pause dates as paused, and null or past dates as active', () => {
    expect(isCollectionPaused(null, '2026-11-28')).toBe(false);
    expect(isCollectionPaused('2026-11-27', '2026-11-28')).toBe(false);
    expect(isCollectionPaused('2026-11-28', '2026-11-28')).toBe(true);
    expect(isCollectionPaused('2026-12-15', '2026-11-28')).toBe(true);
  });
});
