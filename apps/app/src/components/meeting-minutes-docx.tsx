// SPDX-License-Identifier: AGPL-3.0-only
// "Tải về Word (.docx)" on the biên bản page (#4774): the published minutes as a Word file, for the office that prints, stamps or files them from Word. The file is built on the server from the PUBLISHED
// rows only and under the reader's own row security (meetings.minutes_docx.download, a sensitive read that leaves an audit row), so this button only asks and saves what comes back; it is shown when
// something is published, and the server refuses (MINUTES_NOT_PUBLISHED) otherwise. The place is the one typed on the page, not stored. No AI.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MinutesDocx } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

/** The bytes of a base64 string. */
export function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Saves the answer as a file through the browser: a link to a Blob, clicked once and let go. */
export function saveDocx(file: MinutesDocx): void {
  const url = URL.createObjectURL(new Blob([bytesOfBase64(file.contentBase64)], { type: file.mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Let go of the address a moment later: some browsers have not started the save when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function MinutesDocxButton({ meetingId, place }: { meetingId: string; place: string }) {
  const t = useTranslations('meetings.minutes');
  const [failure, setFailure] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: () => orpc.meetings.minutesDocx.download.call({ meetingId, place: place.trim() }),
    onSuccess: (file) => {
      setFailure(null);
      saveDocx(file);
    },
    onError: (error) => setFailure(errorMessage(error)),
  });
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" loading={download.isPending} onClick={() => download.mutate()} data-testid="minutes-docx">
        {t('docx')}
      </Button>
      {failure && <ErrorText>{failure}</ErrorText>}
    </div>
  );
}
