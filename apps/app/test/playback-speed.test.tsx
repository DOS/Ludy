// SPDX-License-Identifier: AGPL-3.0-only
// The speed control of a meeting's recording player (#4816): four buttons, the speed in use pressed, worded in Vietnamese and English. Rendered on the server, with no network.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { PlaybackSpeed } from '../src/components/playback-speed.tsx';
import type { PlaybackRate } from '../src/lib/playback.ts';

const render = (rate: PlaybackRate, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <PlaybackSpeed rate={rate} onChange={() => undefined} />
    </IntlProvider>,
  );

describe('PlaybackSpeed', () => {
  it('offers the four speeds in a labelled group, with the speed in use pressed', () => {
    for (const rate of [1, 1.25, 1.5, 2] as const) {
      const html = render(rate);
      expect(html).toContain(`aria-label="${en.meetings.detail.playbackSpeed}"`);
      for (const r of [1, 1.25, 1.5, 2]) expect(html).toContain(`data-testid="playback-rate-${r}"`);
      const buttons = [...html.matchAll(/<button[^>]*>.*?<\/button>/g)].map((m) => m[0]);
      expect(buttons).toHaveLength(4);
      const on = buttons.filter((b) => b.includes('aria-pressed="true"'));
      expect(on).toHaveLength(1);
      expect(on[0]).toContain(`playback-rate-${rate}"`);
    }
  });

  it('writes each speed as on the button and has Vietnamese words', () => {
    const html = render(1.5);
    for (const label of ['1x', '1.25x', '1.5x', '2x']) expect(html).toContain(`>${label}</button>`);
    const vi = render(1.5, 'vi');
    expect(vi).toContain(`aria-label="${viMessages.meetings.detail.playbackSpeed}"`);
    expect(viMessages.meetings.transcript.seekTo).toContain('{time}');
    expect(en.meetings.transcript.seekTo).toContain('{time}');
  });
});
