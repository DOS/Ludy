// SPDX-License-Identifier: AGPL-3.0-only
// "Tải bản ghi lời về" on a meeting's transcript card (#4817): the lines the reader sees, as plain text or SRT captions. The file is built on the server under the transcript's own reader rule
// (meetings.transcript.download, a sensitive read that leaves an audit row), so a redacted value is not in it; this only asks and saves what comes back. No AI.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { TRANSCRIPT_EXPORT_FORMATS, type TranscriptExportFormat } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { saveBase64File } from '../lib/save-file.ts';

export function TranscriptExport({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.transcript.export');
  const [failure, setFailure] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: (format: TranscriptExportFormat) => orpc.meetings.transcript.download.call({ meetingId, format }),
    onSuccess: (file) => {
      setFailure(null);
      saveBase64File(file);
    },
    onError: (error) => setFailure(errorMessage(error)),
  });
  return (
    <div className="space-y-1" role="group" aria-label={t('label')} data-testid="transcript-export">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('label')}</span>
        {TRANSCRIPT_EXPORT_FORMATS.map((format) => (
          <Button
            key={format}
            type="button"
            size="sm"
            variant="outline"
            loading={download.isPending && download.variables === format}
            disabled={download.isPending}
            onClick={() => download.mutate(format)}
            data-testid={`transcript-export-${format}`}
          >
            {t(format)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('note')}</p>
      {failure && <ErrorText>{failure}</ErrorText>}
    </div>
  );
}
