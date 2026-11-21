// SPDX-License-Identifier: AGPL-3.0-only
// Sender-approved counterparty summary card (/-/sign & /-/sign/d) and editor (/o/$slug/sign/envelopes/$id) (#3822).
// Renders human-reviewed contract terms with clickable page jumps on public routes (zero public LLM calls) and
// lets authorized senders prefill, edit, and explicitly toggle sharing.
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from '../ui.tsx';
import type { SignAiAnalysis, SignSharedKeyTerm, SignSharedSummary } from '../../lib/sign-api.ts';

export interface CounterpartySummaryBannerProps {
  sharedSummary: SignSharedSummary;
  pageCount: number;
  onJumpToPage: (pageNumber: number) => void;
}

export function CounterpartySummaryBanner({
  sharedSummary,
  pageCount,
  onJumpToPage,
}: CounterpartySummaryBannerProps) {
  const t = useTranslations('sign.sharedSummary');
  const [expanded, setExpanded] = useState(true);

  return (
    <Card className="border-border bg-muted/30" data-testid="counterparty-shared-summary-card">
      <CardHeader className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium leading-snug text-foreground">
            {t('publicHeading')}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            data-testid="counterparty-summary-toggle-btn"
          >
            {expanded ? t('collapseButton') : t('expandButton')}
          </Button>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="space-y-3 pt-0 text-sm" data-testid="counterparty-summary-body">
          {sharedSummary.summaryText ? (
            <p className="whitespace-pre-line leading-relaxed text-foreground">{sharedSummary.summaryText}</p>
          ) : null}
          {sharedSummary.keyTerms.length > 0 ? (
            <ul className="space-y-2" data-testid="counterparty-summary-terms">
              {sharedSummary.keyTerms.map((term, idx) => {
                const validPage =
                  term.pageNumber !== null && term.pageNumber >= 1 && term.pageNumber <= Math.max(1, pageCount)
                    ? term.pageNumber
                    : null;
                return (
                  <li
                    key={`${idx}-${term.label}`}
                    className="rounded-md border bg-card px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="font-semibold text-foreground">{term.label}: </span>
                        <span className="text-foreground">{term.value}</span>
                      </div>
                      {validPage !== null ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 shrink-0 px-3 text-xs text-link"
                          onClick={() => onJumpToPage(validPage)}
                          data-testid={`counterparty-summary-jump-page-${validPage}`}
                        >
                          {t('jumpPageButton', { page: String(validPage) })}
                        </Button>
                      ) : null}
                    </div>
                    {term.quoteExcerpt ? (
                      <p className="mt-1 italic text-muted-foreground">&ldquo;{term.quoteExcerpt}&rdquo;</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

interface EditableTermDraft {
  localId: string;
  label: string;
  value: string;
  pageNumberText: string;
  quoteExcerpt: string;
}

function toEditableTerms(terms: readonly SignSharedKeyTerm[] | undefined): EditableTermDraft[] {
  if (!terms || terms.length === 0) return [];
  return terms.map((term, idx) => ({
    localId: `term-${idx}`,
    label: term.label,
    value: term.value,
    pageNumberText: term.pageNumber !== null ? String(term.pageNumber) : '',
    quoteExcerpt: term.quoteExcerpt ?? '',
  }));
}

export interface SenderSharedSummaryEditorProps {
  recordKey: string;
  initialShare: boolean;
  initialSummary: SignSharedSummary | null;
  pageCount: number | null;
  aiAnalysis?: SignAiAnalysis | null;
  editable: boolean;
  saving: boolean;
  onSave: (payload: { shareSummaryWithSigners: boolean; sharedSummary: SignSharedSummary | null }) => void | Promise<unknown>;
}

export function SenderSharedSummaryEditor({
  recordKey,
  initialShare,
  initialSummary,
  pageCount,
  aiAnalysis,
  editable,
  saving,
  onSave,
}: SenderSharedSummaryEditorProps) {
  const t = useTranslations('sign.sharedSummary');
  const [shareChecked, setShareChecked] = useState(initialShare);
  const [summaryText, setSummaryText] = useState(initialSummary?.summaryText ?? '');
  const [terms, setTerms] = useState<EditableTermDraft[]>(() => toEditableTerms(initialSummary?.keyTerms));
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setShareChecked(initialShare);
    setSummaryText(initialSummary?.summaryText ?? '');
    setTerms(toEditableTerms(initialSummary?.keyTerms));
    setDirty(false);
    setLocalError(null);
  }, [recordKey]);

  useEffect(() => {
    if (dirty) return;
    setShareChecked(initialShare);
    setSummaryText(initialSummary?.summaryText ?? '');
    setTerms(toEditableTerms(initialSummary?.keyTerms));
  }, [dirty, initialShare, initialSummary]);

  const canPrefillFromVy = Boolean(
    editable &&
      aiAnalysis &&
      (Boolean(aiAnalysis.summaryText?.trim()) || (aiAnalysis.riskClauses && aiAnalysis.riskClauses.length > 0)),
  );

  const handlePrefillFromVy = () => {
    if (!aiAnalysis) return;
    setLocalError(null);
    setDirty(true);
    if (aiAnalysis.summaryText?.trim()) {
      setSummaryText(aiAnalysis.summaryText.trim());
    }
    if (aiAnalysis.riskClauses.length > 0) {
      setTerms(
        aiAnalysis.riskClauses.slice(0, 10).map((clause, idx) => ({
          localId: `vy-${idx}-${Date.now()}`,
          label: clause.title.trim() || `Điều khoản ${idx + 1}`,
          value: clause.explanation.trim(),
          pageNumberText: clause.pageNumber !== null ? String(clause.pageNumber) : '',
          quoteExcerpt: clause.quote.trim(),
        })),
      );
    }
  };

  const handleAddTerm = () => {
    setLocalError(null);
    setDirty(true);
    setTerms((prev) => [
      ...prev,
      {
        localId: `manual-${Date.now()}-${prev.length}`,
        label: '',
        value: '',
        pageNumberText: '1',
        quoteExcerpt: '',
      },
    ]);
  };

  const handleSave = () => {
    setLocalError(null);
    const cleanSummaryText = summaryText.trim() || null;
    const cleanTerms: SignSharedKeyTerm[] = [];
    for (const item of terms) {
      const label = item.label.trim();
      const value = item.value.trim();
      if (!label && !value) continue;
      if (!label || !value) continue;
      const parsedPage = item.pageNumberText.trim() ? Number(item.pageNumberText.trim()) : null;
      const validPage =
        parsedPage !== null &&
        Number.isInteger(parsedPage) &&
        parsedPage >= 1 &&
        (pageCount === null || parsedPage <= pageCount)
          ? parsedPage
          : null;
      cleanTerms.push({
        label,
        value,
        pageNumber: validPage,
        quoteExcerpt: item.quoteExcerpt.trim() || null,
      });
    }

    const builtSummary: SignSharedSummary | null =
      cleanSummaryText !== null || cleanTerms.length > 0
        ? { summaryText: cleanSummaryText, keyTerms: cleanTerms }
        : null;

    if (shareChecked && builtSummary === null) {
      setLocalError(t('emptyRequiredError'));
      return;
    }

    const maybePromise = onSave({
      shareSummaryWithSigners: shareChecked,
      sharedSummary: builtSummary,
    });
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      void (maybePromise as Promise<unknown>).then(
        () => setDirty(false),
        () => {
          // Keep dirty=true on failed save so background refetches do not overwrite user edits.
        },
      );
    } else {
      setDirty(false);
    }
  };

  return (
    <Card data-testid="sender-shared-summary-editor">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('cardTitle')}</CardTitle>
        <CardDescription className="text-xs">{t('cardHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {localError ? <ErrorText>{localError}</ErrorText> : null}

        {canPrefillFromVy ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full"
            onClick={handlePrefillFromVy}
            data-testid="prefill-shared-summary-from-vy-btn"
          >
            {t('prefillButton')}
          </Button>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor={`shared-summary-text-${recordKey}`} className="text-xs">
            {t('summaryTextLabel')}
          </Label>
          <Textarea
            id={`shared-summary-text-${recordKey}`}
            rows={3}
            disabled={!editable}
            placeholder={t('summaryTextPlaceholder')}
            value={summaryText}
            onChange={(e) => {
              setDirty(true);
              setLocalError(null);
              setSummaryText(e.target.value);
            }}
            data-testid="shared-summary-textarea"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t('keyTermsHeading')}</span>
            {editable ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={terms.length >= 20}
                onClick={handleAddTerm}
                data-testid="shared-summary-add-term-btn"
              >
                {t('addTermButton')}
              </Button>
            ) : null}
          </div>

          {terms.map((term, idx) => (
            <div key={term.localId} className="space-y-2 rounded-md border bg-muted/20 p-2.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor={`shared-term-label-${recordKey}-${idx}`} className="text-xs">
                    {t('termLabelInput')}
                  </Label>
                  <Input
                    id={`shared-term-label-${recordKey}-${idx}`}
                    disabled={!editable}
                    placeholder={t('termLabelPlaceholder')}
                    value={term.label}
                    className="min-h-11"
                    onChange={(e) => {
                      const val = e.target.value;
                      setDirty(true);
                      setTerms((prev) => prev.map((it) => (it.localId === term.localId ? { ...it, label: val } : it)));
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`shared-term-value-${recordKey}-${idx}`} className="text-xs">
                    {t('termValueInput')}
                  </Label>
                  <Input
                    id={`shared-term-value-${recordKey}-${idx}`}
                    disabled={!editable}
                    placeholder={t('termValuePlaceholder')}
                    value={term.value}
                    className="min-h-11"
                    onChange={(e) => {
                      const val = e.target.value;
                      setDirty(true);
                      setTerms((prev) => prev.map((it) => (it.localId === term.localId ? { ...it, value: val } : it)));
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`shared-term-page-${recordKey}-${idx}`} className="text-xs">
                    {t('termPageInput')}
                  </Label>
                  <Input
                    id={`shared-term-page-${recordKey}-${idx}`}
                    type="number"
                    min={1}
                    max={pageCount ?? 200}
                    disabled={!editable}
                    value={term.pageNumberText}
                    className="min-h-11"
                    onChange={(e) => {
                      const val = e.target.value;
                      setDirty(true);
                      setTerms((prev) =>
                        prev.map((it) => (it.localId === term.localId ? { ...it, pageNumberText: val } : it)),
                      );
                    }}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`shared-term-quote-${recordKey}-${idx}`} className="text-xs">
                  {t('termQuoteInput')}
                </Label>
                <Input
                  id={`shared-term-quote-${recordKey}-${idx}`}
                  disabled={!editable}
                  value={term.quoteExcerpt}
                  className="min-h-11"
                  onChange={(e) => {
                    const val = e.target.value;
                    setDirty(true);
                    setTerms((prev) =>
                      prev.map((it) => (it.localId === term.localId ? { ...it, quoteExcerpt: val } : it)),
                    );
                  }}
                />
              </div>
              {editable ? (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-11 text-destructive"
                    onClick={() => {
                      setDirty(true);
                      setTerms((prev) => prev.filter((it) => it.localId !== term.localId));
                    }}
                  >
                    {t('removeTermButton')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <label
          htmlFor={`share-summary-toggle-${recordKey}`}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2"
        >
          <Checkbox
            id={`share-summary-toggle-${recordKey}`}
            checked={shareChecked}
            disabled={!editable}
            onCheckedChange={(checked) => {
              setDirty(true);
              setLocalError(null);
              setShareChecked(Boolean(checked));
            }}
            data-testid="share-summary-with-signers-checkbox"
          />
          <span className="font-medium text-foreground">{t('shareToggleLabel')}</span>
        </label>

        {editable ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full"
            loading={saving}
            onClick={handleSave}
            data-testid="save-shared-summary-btn"
          >
            {t('saveButton')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
