// SPDX-License-Identifier: AGPL-3.0-only
// The visible "Ghi âm đã dừng" on a meeting (Meetings A1, #3159): shown for a recording that ended by itself, with the time and the
// reason in plain words, and nothing for one the recorder stopped. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { RECORDING_STOP_REASONS } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { RecordingStoppedNote } from '../src/components/recording-stopped.tsx';

const render = (props: Parameters<typeof RecordingStoppedNote>[0]['meeting'], locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <RecordingStoppedNote meeting={props} />
    </IntlProvider>,
  );

describe('RecordingStoppedNote', () => {
  it('says nothing for a recording the recorder stopped', () => {
    expect(render({ recordingStopReason: null, endedAt: null })).toBe('');
  });

  it('says when it stopped and why, in Vietnamese and English', () => {
    const html = render({ recordingStopReason: 'tab_closed', endedAt: '2026-11-14T05:44:00.000Z' });
    expect(html).toContain('Recording stopped at');
    expect(html).toContain(en.meetings.stopReason.tab_closed);
    expect(render({ recordingStopReason: 'mic_lost', endedAt: '2026-11-14T05:44:00.000Z' }, 'vi')).toContain('Ghi âm đã dừng lúc');
  });

  it('has plain words for every code, in both languages', () => {
    for (const code of RECORDING_STOP_REASONS) {
      expect(en.meetings.stopReason[code].length).toBeGreaterThan(5);
      expect(vi.meetings.stopReason[code].length).toBeGreaterThan(5);
    }
    expect(Object.keys(en.meetings.stopReason).sort()).toEqual([...RECORDING_STOP_REASONS].sort());
  });
});
