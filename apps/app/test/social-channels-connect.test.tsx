// SPDX-License-Identifier: AGPL-3.0-only
// The Channels screen's connect path (#3651): only what can be connected is offered, a time zone reads as a place and an
// offset, and the settings of the whole line sit in one group that is folded on a phone and open on a wide screen.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GeneralSettings } from '../src/components/social-general-settings.tsx';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { connectSplit, zoneLabel } from '../src/lib/social.ts';

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};

describe('what the connect card offers', () => {
  it('lists what this server has set up first, Facebook and Instagram before the rest, and folds the others away', () => {
    const none = connectSplit([]);
    expect(none.ready).toEqual([]);
    expect(none.unavailable.slice(0, 2)).toEqual(['facebook_page', 'instagram']);
    const some = connectSplit(['instagram', 'facebook_page', 'tiktok']);
    expect(some.ready).toEqual(['facebook_page', 'instagram', 'tiktok']);
    expect(some.unavailable).not.toContain('facebook_page');
    expect(some.unavailable).toContain('x');
    // LinkedIn Company Pages are listed only where the server offers them.
    expect(connectSplit([]).unavailable).not.toContain('linkedin_page');
    expect(connectSplit(['linkedin_page']).ready).toEqual(['linkedin_page']);
  });

  it('says in plain words who connects and what is not available yet, with no setting names, in both languages', () => {
    expect(vi.social.adminsConnect).toContain('Chỉ chủ sở hữu hoặc quản trị viên kết nối kênh');
    expect(en.social.adminsConnect).toContain('Only an owner or admin can connect a channel');
    expect(vi.social.otherPlatforms).toBe('Nền tảng khác (chưa dùng được)');
    expect(vi.social.noChannelsMember).toContain('Nhờ chủ sở hữu hoặc quản trị viên');
    for (const copy of [vi.social, en.social]) {
      for (const key of ['adminsConnect', 'sandboxTitle', 'nothingToConnect', 'otherPlatforms', 'otherPlatformsHint', 'generalSettingsTitle', 'generalSettingsHint', 'noChannelsMember', 'whatsappAccessToken', 'whatsappPhoneNumberId', 'whatsappWabaId', 'telegramBotToken', 'discordWebhook', 'mastodonToken'] as const) {
        expect(copy[key], key).not.toMatch(/token|WABA|webhook|system user|Phone number ID|[A-Z]{3,}_[A-Z_]+/i);
      }
    }
    expect(vi.social.telegramBotToken).toContain('@BotFather');
  });
});

describe('a time zone for a person', () => {
  it('names Viet Nam with its offset and other zones by city and offset', () => {
    expect(zoneLabel('Asia/Ho_Chi_Minh', 'vi')).toBe('Việt Nam (UTC+7)');
    expect(zoneLabel('Asia/Ho_Chi_Minh', 'en')).toBe('Vietnam (UTC+7)');
    expect(zoneLabel('Asia/Singapore', 'vi')).toBe('Singapore (UTC+8)');
    expect(zoneLabel('Asia/Tokyo', 'en')).toBe('Tokyo (UTC+9)');
    expect(zoneLabel('UTC', 'en')).toBe('UTC');
    expect(zoneLabel('America/New_York', 'en')).toMatch(/^New York \(UTC-[45]\)$/);
    // A name the runtime does not know is shown as its city, with no offset.
    expect(zoneLabel('Mars/Olympus_Mons', 'en')).toBe('Olympus Mons');
  });
});

describe('the general settings group', () => {
  const group = (open?: boolean) => render(<GeneralSettings {...(open === undefined ? {} : { open })}><p>giọng văn</p></GeneralSettings>);

  it('is folded where it starts folded, with its cards kept in the page but hidden', () => {
    const html = group(false);
    expect(html).toContain('Cài đặt chung');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<div id="[^"]+" hidden=""[^>]*><p>giọng văn<\/p>/);
  });

  it('is open where it starts open', () => {
    const html = group(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('hidden=""');
  });

  it('starts folded with no window to ask about the screen width (server render)', () => {
    expect(group()).toContain('aria-expanded="false"');
  });
});
