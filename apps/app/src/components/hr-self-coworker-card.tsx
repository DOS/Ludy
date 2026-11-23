// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6A self-service request drafting and cited HR policy Q&A panel on /hr/my (#4526).
// Keeps 100% deterministic parity when AI is off, marks every draft as tainted [AI Draft],
// never submits requests without explicit user confirmation, and links only verified Notes citations.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type {
  HrLeaveRequestKind,
  HrOvertimeDayType,
  HrSelfPolicyQaResult,
  HrSelfRequestDraftResult,
} from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ErrorText } from './ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, errorMessage, getCurrentOrg } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const PHONE_INPUT_TARGET = 'max-md:min-h-11';

export interface HrSelfLeavePrefill {
  startOn: string;
  endOn: string;
  kind: HrLeaveRequestKind;
  days: string;
  reason: string;
}

export interface HrSelfOvertimePrefill {
  workDate: string;
  hours: string;
  dayType: HrOvertimeDayType;
  isNight: boolean;
  reason: string;
}

export interface HrSelfCoworkerCardProps {
  linked: boolean;
  onApplyLeave: (draft: HrSelfLeavePrefill) => void;
  onApplyOvertime: (draft: HrSelfOvertimePrefill) => void;
  initialDraftResult?: HrSelfRequestDraftResult | null;
  initialQaResult?: HrSelfPolicyQaResult | null;
}

export function HrSelfCoworkerCard({
  linked,
  onApplyLeave,
  onApplyOvertime,
  initialDraftResult = null,
  initialQaResult = null,
}: HrSelfCoworkerCardProps) {
  const t = useTranslations('hrMy.coworker');
  const tLeave = useTranslations('hrMy.leave');
  const tOt = useTranslations('hrMy.overtime');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const params = useParams({ strict: false }) as { slug?: string } | undefined;
  const slug = params?.slug || getCurrentOrg() || '';

  const [draftText, setDraftText] = useState('');
  const [draftResult, setDraftResult] = useState<HrSelfRequestDraftResult | null>(initialDraftResult);
  const [appliedHint, setAppliedHint] = useState(false);

  const [questionText, setQuestionText] = useState('');
  const [qaResult, setQaResult] = useState<HrSelfPolicyQaResult | null>(initialQaResult);

  const draftMut = useMutation({
    mutationFn: (text: string) =>
      client.hr.self.requestDraft({
        text,
        lang: locale,
      }),
    onSuccess: (res) => {
      setDraftResult(res);
      setAppliedHint(false);
    },
  });

  const qaMut = useMutation({
    mutationFn: (question: string) =>
      client.hr.self.policyQa({
        question,
        lang: locale,
        limit: 5,
      }),
    onSuccess: (res) => {
      setQaResult(res);
    },
  });

  const handleDraftSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const cleaned = draftText.trim();
    if (!cleaned || draftMut.isPending) return;
    draftMut.mutate(cleaned);
  };

  const handleQaSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const cleaned = questionText.trim();
    if (!cleaned || qaMut.isPending) return;
    qaMut.mutate(cleaned);
  };

  const shownCitations =
    qaResult && qaResult.citations.length > 0 ? qaResult.citations : qaResult?.matches ?? [];

  return (
    <Card className="mb-6 block space-y-4 p-4" data-testid="hr-my-ly-card">
      <div>
        <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      </div>

      <div className={linked ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'}>
        {linked && (
          <section
            className="space-y-3 rounded-lg border p-3"
            aria-label={t('draft.heading')}
            data-testid="hr-my-ly-draft-section"
          >
            <h3 className="text-sm font-medium text-foreground">{t('draft.heading')}</h3>
            <form onSubmit={handleDraftSubmit} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="hr-my-ly-draft-input">{t('draft.inputLabel')}</Label>
                <Input
                  id="hr-my-ly-draft-input"
                  className={PHONE_INPUT_TARGET}
                  maxLength={1000}
                  placeholder={t('draft.inputPlaceholder')}
                  value={draftText}
                  onChange={(ev) => setDraftText(ev.target.value)}
                  data-testid="hr-my-ly-draft-input"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  className={PHONE_TARGET}
                  loading={draftMut.isPending}
                  disabled={!draftText.trim() || draftMut.isPending}
                  data-testid="hr-my-ly-draft-btn"
                >
                  {draftMut.isPending ? t('draft.submitting') : t('draft.submit')}
                </Button>
                {(draftResult !== null || draftText.length > 0) && (
                  <Button
                    type="button"
                    variant="ghost"
                    className={PHONE_TARGET}
                    disabled={draftMut.isPending}
                    onClick={() => {
                      setDraftText('');
                      setDraftResult(null);
                      setAppliedHint(false);
                    }}
                    data-testid="hr-my-ly-draft-clear"
                  >
                    {t('draft.clear')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-subtle-foreground">{t('draft.safetyNote')}</p>
            </form>

            {draftMut.error && <ErrorText>{errorMessage(draftMut.error)}</ErrorText>}

            {draftResult && (
              <div
                className="space-y-2.5 rounded-md border border-proposal/40 bg-proposal/5 p-3 text-sm"
                aria-live="polite"
                data-testid="hr-my-ly-draft-preview"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="proposal" data-testid="hr-my-ly-draft-badge">
                    {t('draft.aiDraftBadge')}
                  </Badge>
                  {draftResult.source === 'deterministic' && (
                    <span className="text-xs text-muted-foreground" data-testid="hr-my-ly-draft-ai-off">
                      {t('draft.deterministicNotice')}
                    </span>
                  )}
                </div>

                {draftResult.draft.kind === 'leave' && (() => {
                  const d = draftResult.draft;
                  return (
                    <div className="space-y-2">
                      <p className="font-medium text-foreground">{t('draft.previewLeaveTitle')}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                        <span>
                          {t('draft.previewDates', {
                            start: f.date(d.startOn),
                            end: f.date(d.endOn),
                            days: d.days,
                          })}
                        </span>
                        <Badge variant="outline">{tLeave(`kinds.${d.leaveKind}`)}</Badge>
                      </div>
                      {d.reason && (
                        <p className="text-xs text-subtle-foreground">
                          {t('draft.reasonLabel', { reason: d.reason })}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        className={PHONE_TARGET}
                        onClick={() => {
                          onApplyLeave({
                            startOn: d.startOn,
                            endOn: d.endOn,
                            kind: d.leaveKind,
                            days: d.days,
                            reason: d.reason,
                          });
                          setAppliedHint(true);
                        }}
                        data-testid="hr-my-ly-apply-leave"
                      >
                        {t('draft.applyLeave')}
                      </Button>
                    </div>
                  );
                })()}

                {draftResult.draft.kind === 'overtime' && (() => {
                  const d = draftResult.draft;
                  return (
                    <div className="space-y-2">
                      <p className="font-medium text-foreground">{t('draft.previewOvertimeTitle')}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                        <span>
                          {t('draft.previewOvertimeMeta', {
                            date: f.date(d.workDate),
                            hours: d.hours,
                            dayType: tOt(`dayTypes.${d.dayType}`),
                          })}
                        </span>
                        {d.isNight && <Badge variant="secondary">{t('draft.nightShiftChip')}</Badge>}
                      </div>
                      {d.reason && (
                        <p className="text-xs text-subtle-foreground">
                          {t('draft.reasonLabel', { reason: d.reason })}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        className={PHONE_TARGET}
                        onClick={() => {
                          onApplyOvertime({
                            workDate: d.workDate,
                            hours: d.hours,
                            dayType: d.dayType,
                            isNight: d.isNight,
                            reason: d.reason,
                          });
                          setAppliedHint(true);
                        }}
                        data-testid="hr-my-ly-apply-ot"
                      >
                        {t('draft.applyOvertime')}
                      </Button>
                    </div>
                  );
                })()}

                {draftResult.draft.kind === 'business_trip_unsupported' && (
                  <div className="space-y-1 text-xs" data-testid="hr-my-ly-draft-trip-hint">
                    <p className="font-medium text-foreground">{draftResult.draft.hint}</p>
                    {draftResult.draft.destination && (
                      <p className="text-subtle-foreground">
                        {t('draft.tripDestination', { destination: draftResult.draft.destination })}
                      </p>
                    )}
                    {draftResult.draft.startOn && draftResult.draft.endOn && (
                      <p className="text-subtle-foreground">
                        {t('draft.tripDates', {
                          start: f.date(draftResult.draft.startOn),
                          end: f.date(draftResult.draft.endOn),
                        })}
                      </p>
                    )}
                  </div>
                )}

                {draftResult.draft.kind === 'unknown' && (
                  <p className="text-xs text-muted-foreground" data-testid="hr-my-ly-draft-unknown-hint">
                    {draftResult.draft.hint}
                  </p>
                )}

                {appliedHint && (
                  <p className="text-xs font-medium text-foreground" data-testid="hr-my-ly-draft-applied">
                    {t('draft.appliedToast')}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <section
          className="space-y-3 rounded-lg border p-3"
          aria-label={t('qa.heading')}
          data-testid="hr-my-ly-qa-section"
        >
          <h3 className="text-sm font-medium text-foreground">{t('qa.heading')}</h3>
          <form onSubmit={handleQaSubmit} className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="hr-my-ly-qa-input">{t('qa.inputLabel')}</Label>
              <Input
                id="hr-my-ly-qa-input"
                className={PHONE_INPUT_TARGET}
                maxLength={500}
                placeholder={t('qa.inputPlaceholder')}
                value={questionText}
                onChange={(ev) => setQuestionText(ev.target.value)}
                data-testid="hr-my-ly-qa-input"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="outline"
                className={PHONE_TARGET}
                loading={qaMut.isPending}
                disabled={!questionText.trim() || qaMut.isPending}
                data-testid="hr-my-ly-qa-btn"
              >
                {qaMut.isPending ? t('qa.submitting') : t('qa.submit')}
              </Button>
              {(qaResult !== null || questionText.length > 0) && (
                <Button
                  type="button"
                  variant="ghost"
                  className={PHONE_TARGET}
                  disabled={qaMut.isPending}
                  onClick={() => {
                    setQuestionText('');
                    setQaResult(null);
                  }}
                  data-testid="hr-my-ly-qa-clear"
                >
                  {t('qa.clear')}
                </Button>
              )}
            </div>
          </form>

          {qaMut.error && <ErrorText>{errorMessage(qaMut.error)}</ErrorText>}

          {qaResult && (
            <div className="space-y-2.5" aria-live="polite" data-testid="hr-my-ly-qa-result">
              {!qaResult.notesAvailable ? (
                <Alert data-testid="hr-my-ly-qa-notes-off">
                  <AlertDescription>{t('qa.notesOffNotice')}</AlertDescription>
                </Alert>
              ) : qaResult.matches.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="hr-my-ly-qa-empty">
                  {t('qa.noMatchesNotice')}
                </p>
              ) : (
                <>
                  {qaResult.answer !== null ? (
                    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                      <Badge variant="proposal" data-testid="hr-my-ly-qa-badge">
                        {t('qa.aiAnswerBadge')}
                      </Badge>
                      <p className="text-sm text-foreground" data-testid="hr-my-ly-qa-answer">
                        {qaResult.answer}
                      </p>
                      <p className="text-xs text-subtle-foreground" data-testid="hr-my-ly-qa-disclaimer">
                        {t('qa.aiDisclaimer')}
                      </p>
                    </div>
                  ) : (
                    <Alert data-testid="hr-my-ly-qa-ai-off-notice">
                      <AlertDescription>
                        {qaResult.aiStatus === 'refused' ? t('qa.refusedNotice') : t('qa.aiOffNotice')}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="space-y-1.5" data-testid="hr-my-ly-qa-citations">
                    <p className="text-xs font-medium text-muted-foreground">
                      {qaResult.answer !== null
                        ? t('qa.citationsTitle', { count: String(shownCitations.length) })
                        : t('qa.matchesTitle', { count: String(shownCitations.length) })}
                    </p>
                    {shownCitations.map((cite, idx) => (
                      <div
                        key={`${cite.noteId}-${idx}`}
                        className="flex flex-col gap-1.5 rounded-md border bg-background p-2.5 sm:flex-row sm:items-start sm:justify-between"
                        data-testid="hr-my-ly-citation-row"
                      >
                        <div className="min-w-0 space-y-1">
                          <Link
                            to="/o/$slug/notes"
                            params={{ slug }}
                            search={{ note: cite.noteId }}
                            className={`${PHONE_TARGET} inline-flex items-center rounded-sm text-xs font-semibold text-link underline underline-offset-4 hover:opacity-80`}
                            data-testid={`hr-my-ly-citation-link-${cite.noteId}`}
                          >
                            {cite.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">{cite.excerpt}</p>
                        </div>
                        <Link
                          to="/o/$slug/notes"
                          params={{ slug }}
                          search={{ note: cite.noteId }}
                          className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} shrink-0 max-md:min-h-11`}
                          data-testid={`hr-my-ly-citation-open-${cite.noteId}`}
                        >
                          {t('qa.openNote')}
                        </Link>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
