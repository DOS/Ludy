// SPDX-License-Identifier: AGPL-3.0-only
// The note that a platform's transcript was cut when it was imported (#3922): for the recorder, while the meeting's flag is set, in Vietnamese and English; nothing for a whole transcript or for a reader.
// Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { TranscriptCutNote } from '../src/components/transcript-cut-note.tsx';

const render = (props: Parameters<typeof TranscriptCutNote>[0]['meeting'], locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <TranscriptCutNote meeting={props} />
    </IntlProvider>,
  );

describe('TranscriptCutNote', () => {
  it('says nothing for a whole transcript, in either language', () => {
    expect(render({ platformTranscriptCut: false, isRecorder: true })).toBe('');
    expect(render({ platformTranscriptCut: false, isRecorder: true }, 'en')).toBe('');
  });

  it('tells the recorder the draft stops early, in Vietnamese and English', () => {
    const vi = render({ platformTranscriptCut: true, isRecorder: true });
    expect(vi).toContain('data-testid="transcript-cut"');
    expect(vi).toContain('chỉ có phần đầu');
    expect(render({ platformTranscriptCut: true, isRecorder: true }, 'en')).toContain('only has the first part');
  });

  it('is for the recorder alone: a reader sees nothing', () => {
    expect(render({ platformTranscriptCut: true, isRecorder: false })).toBe('');
  });
});
