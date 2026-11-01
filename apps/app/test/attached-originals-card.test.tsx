// SPDX-License-Identifier: AGPL-3.0-only
// The card of the original XML files attached to a posted invoice (#2320), rendered on the server: each file, how its seal
// checked out, a plain "matches" line or the warning that the books are not changed and a person must look; nothing at all
// when no original came.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { InboxOriginal } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('never called')) }));

const { AttachedOriginalsCard } = await import('../src/components/attached-originals-card.tsx');

const FILE = '00000000-0000-4000-8000-0000000000aa';
const original = (over: Partial<InboxOriginal> = {}): InboxOriginal => ({
  fileId: FILE,
  filename: 'hd-1234.xml',
  receivedAt: '2026-11-02T08:00:00.000Z',
  differs: false,
  signature: { status: 'verified', reason: null },
  ...over,
});

function card(originals: InboxOriginal[], locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <AttachedOriginalsCard originals={originals} />
    </IntlProvider>,
  );
}

describe('the attached originals card', () => {
  it('renders nothing when no original came', () => {
    expect(card([])).toBe('');
  });

  it('names the file, its valid signature and that the amounts match', () => {
    const html = card([original()]);
    expect(html).toContain('data-testid="attached-originals-card"');
    expect(html).toContain('hd-1234.xml');
    expect(html).toContain('The digital signature is valid.');
    expect(html).toContain('data-testid="attached-original-matches"');
    expect(html).not.toContain('data-testid="attached-original-differs"');
  });

  it('warns when the amounts differ, and says the books are not changed', () => {
    const html = card([original({ differs: true })]);
    expect(html).toContain('data-testid="attached-original-differs"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The books are not changed');
    expect(html).not.toContain('data-testid="attached-original-matches"');
  });

  it('says so when the signature is unverified or there is no check result, and shows Vietnamese', () => {
    expect(card([original({ signature: { status: 'unverified', reason: 'bad_signature' } })])).toContain('could not be verified');
    expect(card([original({ signature: null })])).toContain('no signature check result');
    const html = card([original({ differs: true })], 'vi');
    expect(html).toContain('Hóa đơn gốc (XML) đã nhận');
    expect(html).toContain('Sổ không bị sửa');
  });
});
