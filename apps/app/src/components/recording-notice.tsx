// SPDX-License-Identifier: AGPL-3.0-only
// The recording notice kit in the consent step (Meetings A1, #3159): the fixed text, a button that copies it so the recorder
// can paste it in the call's chat, and the other language one click away. The meeting's language is the default. Ludy
// posts nothing into the call. The text lives in @crove/meeting-recorder (notice.ts) and is a draft pending the lawyer (#2585).
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { noticeLanguageFor, noticeToCopy, otherNoticeLanguage, RECORDING_NOTICE, type RecordingNoticeLanguage } from '@crove/meeting-recorder';
import { Button } from '@crove/ui/components/button';

export function RecordingNotice({ meetingLanguage }: { meetingLanguage: string }) {
  const t = useTranslations('meetings');
  // The language the recorder picked by hand; until then the meeting's own language follows the form.
  const [picked, setPicked] = useState<RecordingNoticeLanguage | null>(null);
  const [note, setNote] = useState<'copied' | 'failed' | null>(null);
  const language = picked ?? noticeLanguageFor(meetingLanguage);
  const other = otherNoticeLanguage(language);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(noticeToCopy(language).text);
      setNote('copied');
    } catch {
      setNote('failed');
    }
  };

  return (
    <div className="space-y-2" data-testid="recording-notice">
      <div className="text-xs font-medium text-foreground">{t('form.noticeHeading')}</div>
      <p lang={language} className="rounded bg-muted/60 p-2 text-xs italic text-foreground" data-testid="recording-notice-text">
        {RECORDING_NOTICE.text[language]}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {t('form.noticeCopy')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setPicked(other);
            setNote(null);
          }}
        >
          {t(other === 'en' ? 'form.noticeShowEn' : 'form.noticeShowVi')}
        </Button>
        {note ? (
          <span role="status" className="text-xs text-muted-foreground">
            {t(note === 'copied' ? 'form.noticeCopied' : 'form.noticeCopyFailed')}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('form.noticeDraft')}</p>
    </div>
  );
}
