// SPDX-License-Identifier: AGPL-3.0-only
// The words an owner reads on the Ads screens (#3641, Engage audit AD-4): no URL, endpoint or API method name, no permission scope, and no instruction for whoever runs the
// Google or Meta developer console. The operator's notes live in the runbooks. A grep over the whole `ads` catalog in both languages, so a new string cannot bring them back.
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

function strings(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => strings(v, [...path, k]));
}

// A host after the slashes (a field hint may say an address "starts with https://"), the Google and Meta endpoint and scope names, the developer consoles and the
// Testing and Production modes of a Google consent screen.
const OPERATOR_TALK = /https?:\/\/[a-z]|googleapis|customers:|googleAds:|searchStream|listAccessibleCustomers|\badwords\b|\bads_read\b|\bads_management\b|\bbusiness_management\b|Cloud Console|Google Cloud|\bTesting\b|\bProduction\b|\bAPI\b/i;

describe('the owner copy of Ads', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`has no URL, API name, scope or console instruction in ${locale}`, () => {
      const all = strings((catalog(locale) as unknown as { ads: unknown }).ads);
      expect(all.length).toBeGreaterThan(200);
      const found = all.filter(([, text]) => OPERATOR_TALK.test(text)).map(([key]) => key);
      expect(found).toEqual([]);
    });
  }

  it('says what Ludy asks the platform for in the owner’s words: Meta reads reports only; Google has one permission for reading and writing and Ludy only reads', () => {
    const vi = catalog('vi').ads as unknown as { connectMeta: { note: string }; connectGoogle: { note: string } };
    expect(vi.connectMeta.note).toBe('Ludy chỉ xin quyền đọc báo cáo quảng cáo; không tạo hay sửa chiến dịch trừ khi bạn bật chạy quảng cáo.');
    // Google's consent screen speaks of managing campaigns, so the note must not claim a read-only permission (the adapter asks the one scope that covers both).
    expect(vi.connectGoogle.note).toContain('một quyền chung cho cả đọc và ghi');
    expect(vi.connectGoogle.note).toContain('chỉ đọc báo cáo');
    expect(vi.connectGoogle.note).not.toContain('chỉ xin quyền đọc');
    const en = catalog('en').ads as unknown as { connectGoogle: { note: string } };
    expect(en.connectGoogle.note).toContain('single permission that covers both reading and writing');
  });
});
