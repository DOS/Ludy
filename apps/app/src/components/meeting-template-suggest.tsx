// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý mẫu biên bản" (#4772): for the recorder of a meeting with a transcript that is still on the general summary, code suggests one of the other four minutes templates from the meeting itself (its series, a
// linked deal, words in its title, the number of people) with the reason in plain words, and one click "Dùng mẫu này" takes it by the existing set-template command: nothing changes before it. When code cannot tell,
// and only when this system lets Vy work, a button has the recorder's own Vy read the transcript and suggest one with a one-line reason and the time of the line it rests on; that answer lives only in this component's
// state. Absent for a person who is not the recorder, for a meeting with no transcript or already on a template, and when code cannot tell and Vy is off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { SuggestableTemplate, TemplateReason, TemplateVyAnswer } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'TEMPLATE_SUGGEST_TIMEOUT', 'TEMPLATE_SUGGEST_FAILED', 'TEMPLATE_SUGGEST_TOO_LONG', 'TEMPLATE_SUGGEST_NO_TRANSCRIPT', 'TEMPLATE_SUGGEST_BUSY'] as const;
export const templateSuggestRunCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

export function MeetingTemplateSuggest({ meetingId, isRecorder, hasTranscript, template, onJump }: { meetingId: string; isRecorder: boolean; hasTranscript: boolean; template: string; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.templateSuggest');
  const eligible = isRecorder && hasTranscript && template === 'general';
  const code = useQuery({ ...orpc.meetings.templateSuggest.suggest.queryOptions({ input: { meetingId } }), enabled: eligible });
  const status = useQuery({ ...orpc.meetings.templateSuggest.status.queryOptions({ input: { meetingId } }), enabled: eligible && code.data?.state === 'unknown' });
  const ask = useMutation({ mutationFn: () => orpc.meetings.templateSuggest.vy.call({ meetingId }) });
  const take = useMutation({
    mutationFn: (summaryTemplate: SuggestableTemplate) => orpc.meetings.setTemplate.call({ meetingId, summaryTemplate }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.get.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.templateSuggest.key() });
      // The card is gone with the "general" type: the focus goes to the picker that now shows the new type.
      requestAnimationFrame(() => document.getElementById('minutes-template')?.focus());
    },
  });
  if (!eligible || !code.data || code.data.state === 'not_applicable') return null;
  const vy = ask.data;
  // Code could not tell: Vy's button only where this system lets Vy work, otherwise nothing and no word about it.
  if (code.data.state === 'unknown' && !status.data?.enabled) return null;
  const suggested: { template: SuggestableTemplate; reasons: TemplateReason[]; vy: TemplateVyAnswer | null } | null =
    code.data.state === 'suggested' && code.data.template !== null ? { template: code.data.template, reasons: code.data.reasons, vy: null } : null;
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-border bg-card p-3" data-testid="template-suggest">
      <p className="text-sm font-semibold">{t('title')}</p>
      {suggested && <CodeSuggestion template={suggested.template} reasons={suggested.reasons} taking={take.isPending} onTake={() => take.mutate(suggested.template)} />}
      {code.data.state === 'unknown' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" loading={ask.isPending} disabled={ask.isPending} onClick={() => ask.mutate()} data-testid="template-suggest-vy">
              {vy ? t('again') : t('askVy')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('unknown')}</span>
          </div>
          {/* One live region that is always in the page and holds the answer too, so the running word and the result are announced. */}
          <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
            {ask.isPending && <p className="text-xs">{t('running')}</p>}
            {vy && !ask.isPending && <VyResult answer={vy} taking={take.isPending} onTake={(next) => take.mutate(next)} onJump={onJump} />}
          </div>
          {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
        </div>
      )}
      {take.error && <ErrorText>{errorMessage(take.error)}</ErrorText>}
    </div>
  );
}

// Code's suggestion: the template's name, the reasons in plain words and the one click that takes it.
export function CodeSuggestion({ template, reasons, taking, onTake }: { template: SuggestableTemplate; reasons: readonly TemplateReason[]; taking: boolean; onTake: () => void }) {
  const t = useTranslations('meetings.templateSuggest');
  const tm = useTranslations('meetings');
  const name = tm(`templates.names.${template}`);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="template-suggest-code">
      <span id="template-suggest-name" className="text-sm font-medium">{name}</span>
      <span className="text-xs text-muted-foreground">{t('because', { reasons: reasons.map((reason) => t(`reasons.${reason}`)).join('; ') })}</span>
      <Button size="sm" aria-describedby="template-suggest-name" loading={taking} disabled={taking} onClick={onTake} data-testid="template-suggest-take">
        {t('take')}
      </Button>
    </div>
  );
}

// Vy's answer: the template, its one-line reason as plain text with the time of the line it rests on, and the one click; or "no template fits clearly", or the fixed words of a failure.
export function VyResult({ answer, taking, onTake, onJump }: { answer: TemplateVyAnswer; taking: boolean; onTake: (template: SuggestableTemplate) => void; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.templateSuggest');
  const tm = useTranslations('meetings');
  if (answer.state === 'none') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="template-suggest-none">
        {t('none')}
      </p>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="template-suggest-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${templateSuggestRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  if (answer.template === null || answer.reason === null || answer.seconds === null) return null;
  const template = answer.template;
  const seconds = answer.seconds;
  return (
    <div className="space-y-1" data-testid="template-suggest-vy-answer">
      <div className="flex flex-wrap items-center gap-2">
        <span id="template-suggest-vy-name" className="text-sm font-medium">{tm(`templates.names.${template}`)}</span>
        <Button size="sm" aria-describedby="template-suggest-vy-name" loading={taking} disabled={taking} onClick={() => onTake(template)} data-testid="template-suggest-vy-take">
          {t('take')}
        </Button>
      </div>
      <p className="flex flex-wrap items-baseline gap-2 text-sm">
        {/* Plain text: the reason is the model's words, never markup. */}
        <span>{answer.reason}</span>
        <button
          type="button"
          className="inline-flex min-h-6 items-center font-mono text-xs text-link underline max-md:min-h-11"
          title={t('open', { time: clock(seconds) })}
          aria-label={t('open', { time: clock(seconds) })}
          onClick={() => onJump(seconds)}
          data-testid="template-suggest-jump"
        >
          {clock(seconds)}
        </button>
      </p>
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}
