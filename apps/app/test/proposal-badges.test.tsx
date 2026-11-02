// SPDX-License-Identifier: AGPL-3.0-only
// The badges of an Inbox row (#2054): a posting a reversal voided says so in both languages, in the error chip, and
// carries no "all checks pass" success badge beside it; a standing posting keeps it.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ProposalBadges, type ProposalBadgesItem } from '../src/components/proposal-badges.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const posted: ProposalBadgesItem = {
  kind: 'finance.purchase',
  direction: 'purchase',
  duplicateOf: null,
  signatureStatus: 'verified',
  failedChecks: 0,
  warnChecks: 0,
  requestedByAgent: null,
  extracted: true,
  voided: false,
};

function render(item: ProposalBadgesItem, locale: 'vi' | 'en'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <ProposalBadges item={item} />
    </IntlProvider>,
  );
}

// The variant of the badge holding `label`, as the chip's data attribute gives it: read from the tag that opens it.
function variantOf(html: string, label: string): string | undefined {
  const at = html.indexOf(`>${label}<`);
  if (at < 0) return undefined;
  const tag = html.slice(0, at).split('<span').at(-1) ?? '';
  return /data-variant="([a-z]+)"/.exec(tag)?.[1];
}

describe('the badges of an Inbox row', () => {
  it('says a voided posting is voided, in the error chip, and drops the success badge', () => {
    for (const locale of ['vi', 'en'] as const) {
      const words = catalog(locale).inbox;
      const html = render({ ...posted, voided: true }, locale);
      expect(html, locale).toContain(words.voided);
      expect(variantOf(html, words.voided), locale).toBe('destructive');
      expect(html, locale).not.toContain(`>${words.matched}<`);
    }
  });

  it('keeps the success badge on a posting that stands, and shows no voided chip', () => {
    for (const locale of ['vi', 'en'] as const) {
      const words = catalog(locale).inbox;
      const html = render(posted, locale);
      expect(html, locale).toContain(`>${words.matched}<`);
      expect(html, locale).not.toContain(words.voided);
    }
  });

  // #2091: a proposal with a line no rule matched says so in both languages, and is not shown as matched.
  it('shows the count of unclassified lines as a warning, in vi and en, and no success badge', () => {
    const unclassified = { ...posted, warnChecks: 1, unclassifiedLines: 2 };
    expect(render(unclassified, 'vi')).toContain('>2 dòng chưa phân loại<');
    expect(render(unclassified, 'en')).toContain('>2 lines unclassified<');
    expect(render({ ...unclassified, unclassifiedLines: 1 }, 'en')).toContain('>1 line unclassified<');
    for (const locale of ['vi', 'en'] as const) {
      const html = render(unclassified, locale);
      expect(variantOf(html, locale === 'vi' ? '2 dòng chưa phân loại' : '2 lines unclassified'), locale).toBe('warning');
      expect(html, locale).not.toContain(`>${catalog(locale).inbox.matched}<`);
      // A proposal with every line classified shows no such badge.
      expect(render({ ...posted, unclassifiedLines: 0 }, locale), locale).not.toMatch(/unclassified|chưa phân loại/);
    }
  });

  // #2294: a request to open the way to spend on an ad platform has a kind chip of its own and no "matched" badge, since no
  // check ran on it.
  it('gives a request about running ads its own kind chip, in vi and en, and no success badge', () => {
    for (const kind of ['ads.write_enable', 'ads.account_enable', 'ads.cap_set', 'ads.launches_unblock']) {
      for (const locale of ['vi', 'en'] as const) {
        const words = catalog(locale).inbox;
        const html = render({ ...posted, kind, direction: null, signatureStatus: null }, locale);
        expect(html, `${kind} ${locale}`).toContain(`>${words.adsKind}<`);
        expect(variantOf(html, words.adsKind), `${kind} ${locale}`).toBe('secondary');
        expect(html, `${kind} ${locale}`).not.toContain(`>${words.matched}<`);
        // None of the invoice kinds' chips beside it.
        for (const other of [words.reversalKind, words.voucherKind, words.journalVoucherKind, words.saleKind]) expect(html, `${kind} ${locale}`).not.toContain(`>${other}<`);
      }
    }
    expect(catalog('vi').inbox.adsKind).toBe('Chạy quảng cáo');
    expect(catalog('en').inbox.adsKind).toBe('Running ads');
    // An invoice shows no such chip.
    for (const locale of ['vi', 'en'] as const) expect(render(posted, locale)).not.toContain(`>${catalog(locale).inbox.adsKind}<`);
  });

  it("words it as the file's chip does", () => {
    expect(catalog('vi').inbox.voided).toBe('Đã hủy (đảo bút toán)');
    expect(catalog('vi').inbox.voided).toBe(catalog('vi').inbox.fileStatus.voided);
    expect(catalog('en').inbox.voided).toBe(catalog('en').inbox.fileStatus.voided);
  });
});
