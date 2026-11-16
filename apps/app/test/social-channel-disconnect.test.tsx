// SPDX-License-Identifier: AGPL-3.0-only
// The disconnect confirmation of a channel with the choice to delete its conversations too (#3299), in both languages: off by default, and when
// it is turned on the warning and the button name how many threads and messages will be erased, in the right plural form. Drawn on the server
// from the view's props; the calls behind it (disconnect, then the kernel's person-only erase with its second factor) are covered by
// apps/kernel/test/conversations-erase-channel.db.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { DisconnectView, type DisconnectViewProps } from '../src/components/social-channel-disconnect-view.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const props = (over: Partial<DisconnectViewProps> = {}): DisconnectViewProps => ({
  erase: false,
  onErase: () => undefined,
  counts: null,
  countsFailed: false,
  pending: false,
  onConfirm: () => undefined,
  onKeep: () => undefined,
  stepUp: null,
  error: null,
  ...over,
});

const render = (over: Partial<DisconnectViewProps>, locale: 'en' | 'vi'): string =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <DisconnectView {...props(over)} />
    </IntlProvider>,
  );

// Whether the confirm button carries its own `disabled` attribute (the class names hold the word too).
const confirmDisabled = (html: string): boolean => /<button[^>]*data-testid="channel-disconnect-yes"[^>]*>/.exec(html)?.[0].includes(' disabled=""') ?? false;

describe('the channel disconnect confirmation', () => {
  it('offers the delete-too choice unchecked, with a plain disconnect button and no warning, in both languages', () => {
    const en = render({}, 'en');
    expect(en).toContain('Delete the conversations too');
    expect(en).toContain('Off by default');
    expect(en).toContain('>Disconnect<');
    expect(en).not.toContain('channel-erase-warning');
    expect(en).not.toMatch(/data-state="checked"|aria-checked="true"/);
    const vi = render({}, 'vi');
    expect(vi).toContain('Xóa cả cuộc trò chuyện');
    expect(vi).toContain('Mặc định tắt');
    expect(vi).toContain('>Ngắt kết nối<');
    expect(vi).not.toContain('channel-erase-warning');
  });

  it('names the threads and messages that will be erased once the choice is on, on the warning and on the button', () => {
    const en = render({ erase: true, counts: { threads: 12, messages: 340 } }, 'en');
    expect(en).toContain('12 conversations with 340 messages of this channel will be erased for good');
    expect(en).toContain('This cannot be undone');
    expect(en).toContain('Disconnect and erase 12 conversations, 340 messages');
    const one = render({ erase: true, counts: { threads: 1, messages: 1 } }, 'en');
    expect(one).toContain('1 conversation with 1 message of this channel');
    const vi = render({ erase: true, counts: { threads: 12, messages: 340 } }, 'vi');
    expect(vi).toContain('12 cuộc trò chuyện với 340 tin nhắn của kênh này sẽ bị xóa vĩnh viễn');
    expect(vi).toContain('Không khôi phục được');
    expect(vi).toContain('Ngắt kết nối và xóa 12 cuộc trò chuyện, 340 tin nhắn');
  });

  it('holds the button until the counts are known, and does not offer to erase what it cannot count', () => {
    for (const locale of ['en', 'vi'] as const) {
      const counting = render({ erase: true }, locale);
      expect(confirmDisabled(counting)).toBe(true);
      expect(counting).toContain('channel-erase-warning');
      const failed = render({ erase: true, countsFailed: true }, locale);
      expect(confirmDisabled(failed)).toBe(true);
    }
    expect(render({ erase: true, countsFailed: true }, 'en')).toContain('could not be counted');
    expect(render({ erase: true, countsFailed: true }, 'vi')).toContain('Không đếm được');
  });

  it('shows the second factor prompt and an error under the choice, and keeps the plain disconnect enabled with the choice off', () => {
    const html = render({ stepUp: <p data-testid="step-up">code please</p>, error: 'Không ngắt kết nối được' }, 'en');
    expect(html).toContain('code please');
    expect(html).toContain('Không ngắt kết nối được');
    expect(confirmDisabled(html)).toBe(false);
    expect(confirmDisabled(render({ pending: true }, 'en'))).toBe(true);
  });
});
