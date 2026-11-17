// SPDX-License-Identifier: AGPL-3.0-only
// No environment variable name or operator jargon in a string an owner reads (#3652): an owner cannot set CREDENTIAL_KEY,
// AI_BASE_URL or PUBLIC_URL, and "the background process" means nothing to them. A feature the server has not turned on
// is said in plain words, with who to ask. Operator text (the names of settings, the logs) lives outside these catalogs.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

// An upper-case name with an underscore, such as CREDENTIAL_KEY, AI_BASE_URL or S3_PRESIGNED_URLS.
const ENV_NAME = /[A-Z]{3,}_[A-Z_]{2,}/;
// Words that name the operator's machinery.
const JARGON = /tiến trình nền|background process/i;

// Namespaces that are for the operator and not the owner may be listed here with the reason; none today.
const OPERATOR_NAMESPACES: readonly string[] = [];

function strings(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof node === 'string') out.push({ path, text: node });
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) strings(value, path ? `${path}.${key}` : key, out);
}

describe('owner-facing copy names no environment variable', () => {
  for (const [name, catalog] of [['vi', vi], ['en', en]] as const) {
    const all: { path: string; text: string }[] = [];
    strings(catalog, '', all);
    const owner = all.filter((s) => !OPERATOR_NAMESPACES.some((ns) => s.path === ns || s.path.startsWith(`${ns}.`)));

    it(`has no setting name in the ${name} catalog`, () => {
      expect(owner.filter((s) => ENV_NAME.test(s.text)).map((s) => `${s.path}: ${s.text}`)).toEqual([]);
    });

    it(`has no operator jargon in the ${name} catalog`, () => {
      expect(owner.filter((s) => JARGON.test(s.text)).map((s) => `${s.path}: ${s.text}`)).toEqual([]);
    });
  }

  it('says what to do when a feature is not turned on: who to ask, in both languages', () => {
    const ask = { vi: 'Liên hệ người quản trị hệ thống', en: 'Ask your system administrator' };
    for (const [path, pick] of [
      ['social.aiOff', (c: typeof vi | typeof en) => c.social.aiOff],
      ['social.telegramChatsNoKey', (c: typeof vi | typeof en) => c.social.telegramChatsNoKey],
      ['social.telegramChatsNoWorker', (c: typeof vi | typeof en) => c.social.telegramChatsNoWorker],
      ['social.telegramChatsNeedsHttps', (c: typeof vi | typeof en) => c.social.telegramChatsNeedsHttps],
    ] as const) {
      expect(pick(vi), `vi ${path}`).toContain(ask.vi);
      expect(pick(en), `en ${path}`).toContain(ask.en);
    }
    // The composer's AI card names the coworker, not a setting.
    expect(vi.social.aiOff).toContain('{marketing} chưa sẵn sàng');
    expect(en.social.aiOff).toContain('{marketing} is not ready');
  });
});
