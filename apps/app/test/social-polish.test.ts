// SPDX-License-Identifier: AGPL-3.0-only
// The small Social leftovers of the Engage audit (#3659: SO-26 to SO-30): the test channel reads from the catalog, the
// import template carries the product name, one spelling set, plain labels for tokens, webhooks and UTM tags.
import { describe, expect, it } from 'vitest';
import { brandFileName } from '../src/i18n/brand.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { providerName, PROVIDER_NAMES } from '../src/lib/social.ts';

describe('the test channel name (SO-27)', () => {
  it('is Kênh thử in Vietnamese and Test channel in English, not the English word Sandbox', () => {
    setActiveLocale('vi');
    expect(providerName('sandbox')).toBe('Kênh thử');
    setActiveLocale('en');
    expect(providerName('sandbox')).toBe('Test channel');
    setActiveLocale('vi');
  });

  it('keeps product names as they are', () => {
    expect(providerName('facebook_page')).toBe('Facebook');
    expect(providerName('whatsapp')).toBe('WhatsApp');
    expect(providerName('something_else')).toBe('something_else');
    expect(Object.values(PROVIDER_NAMES)).not.toContain('Sandbox');
  });

  it('names the import template with the product, never the retired code name', () => {
    expect(brandFileName('crove-mau-nhap-bai.csv', 'Ludy')).toBe('ludy-mau-nhap-bai.csv');
  });
});

describe('one spelling set and plain Social labels (SO-26, SO-28)', () => {
  const text = JSON.stringify(vi.social);

  it('writes Hủy, Xóa and Khung giờ trống the way the rest of the app does', () => {
    expect(text).not.toMatch(/Huỷ|Xoá|Ô Trống/);
    expect(vi.social.views.cancel).toBe('Hủy');
    expect(vi.social.views.remove).toBe('Xóa');
  });

  it('has one back label, to the Posts list, in both languages', () => {
    expect(vi.social.back).toBe('Về Bài đăng');
    expect(en.social.back).toBe('Back to Posts');
  });

  it('drops the English technical words from the labels an owner reads', () => {
    expect(text).not.toMatch(/\(bot token\)|\(TB |Địa chỉ webhook|vạch giữa|"UTM campaign"/);
    expect(vi.social.chatAlert.botToken).toContain('@BotFather');
    expect(vi.social.labels.campaign).toBe('Theo dõi chiến dịch (nâng cao)');
    expect(en.social.labels.campaign).toBe('Campaign tracking (advanced)');
  });
});
