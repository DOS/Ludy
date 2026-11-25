// SPDX-License-Identifier: AGPL-3.0-only
// Contract Vault deterministic search & metered Vy Q&A bar for /o/$slug/sign/envelopes (#4439, Slice 5a).
// Works 100% deterministically with AI off (signApi.searchVault) and optionally requests a cited Vy answer
// (signApi.askVault, tainted proposedByAi: true) with clickable links directly to each permitted envelope.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card, CardContent } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { Empty, ErrorText } from '../ui.tsx';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage } from '../../lib/api.ts';
import {
  signApi,
  type SignVaultAskResult,
  type SignVaultMatchItem,
} from '../../lib/sign-api.ts';

const STATUS_BADGE_VARIANT = {
  draft: 'secondary',
  sent: 'warning',
  in_progress: 'warning',
  completed: 'success',
  declined: 'destructive',
  voided: 'destructive',
  expired: 'outline',
} as const;

export interface ContractVaultBarResultState {
  mode: 'search' | 'ask';
  ai: SignVaultAskResult['ai'] | null;
  items: readonly SignVaultMatchItem[];
  summary: SignVaultAskResult['summary'];
}

export interface ContractVaultBarProps {
  slug: string;
  canAskVy?: boolean;
  initialQuestion?: string;
  initialResult?: ContractVaultBarResultState | null;
  pendingEnvelopeIds?: ReadonlySet<string> | undefined;
  onOpenPendingEnvelope?: ((envelopeId: string) => void) | undefined;
}

export function ContractVaultBar({
  slug,
  canAskVy = true,
  initialQuestion = '',
  initialResult = null,
  pendingEnvelopeIds,
  onOpenPendingEnvelope,
}: ContractVaultBarProps) {
  const t = useTranslations('sign');
  const f = useFormat();

  const renderEnvelopeAction = ({
    envelopeId,
    label,
    className,
    testId,
  }: {
    envelopeId: string;
    label: string;
    className: string;
    testId?: string | undefined;
  }) => {
    if (pendingEnvelopeIds?.has(envelopeId) && onOpenPendingEnvelope) {
      return (
        <button
          type="button"
          onClick={() => onOpenPendingEnvelope(envelopeId)}
          className={`${className} text-left`}
          data-testid={testId}
        >
          {label}
        </button>
      );
    }
    return (
      <Link
        to="/o/$slug/sign/envelopes/$id"
        params={{ slug, id: envelopeId }}
        className={className}
        data-testid={testId}
      >
        {label}
      </Link>
    );
  };
  const [question, setQuestion] = useState(initialQuestion);
  const [result, setResult] = useState<ContractVaultBarResultState | null>(initialResult);
  const [activeError, setActiveError] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: (q: string) => signApi.searchVault({ question: q, limit: 20 }),
    onSuccess: (res) => {
      setActiveError(null);
      setResult({
        mode: 'search',
        ai: null,
        items: res.items,
        summary: null,
      });
    },
    onError: (err) => {
      setActiveError(errorMessage(err));
    },
  });

  const askMutation = useMutation({
    mutationFn: (q: string) => signApi.askVault({ question: q, limit: 12 }),
    onSuccess: (res) => {
      setActiveError(null);
      setResult({
        mode: 'ask',
        ai: res.ai,
        items: res.items,
        summary: res.summary,
      });
    },
    onError: (err) => {
      setActiveError(errorMessage(err));
    },
  });

  const trimmedQuestion = question.trim();
  const isBusy = searchMutation.isPending || askMutation.isPending;

  const handleSubmitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedQuestion || isBusy) return;
    searchMutation.mutate(trimmedQuestion);
  };

  const handleAskVy = () => {
    if (!trimmedQuestion || isBusy) return;
    askMutation.mutate(trimmedQuestion);
  };

  const handleClear = () => {
    setQuestion('');
    setResult(null);
    setActiveError(null);
  };

  const aiNoticeKey =
    result?.mode === 'ask' && result.ai === 'off'
      ? 'vault.aiOffNotice'
      : result?.mode === 'ask' && result.ai === 'budget'
        ? 'vault.aiBudgetNotice'
        : result?.mode === 'ask' && result.ai === 'busy'
          ? 'vault.aiBusyNotice'
          : result?.mode === 'ask' && result.ai === 'empty'
            ? 'vault.aiEmptyNotice'
            : result?.mode === 'ask' && result.ai === 'failed'
              ? 'vault.aiFailedNotice'
              : null;

  return (
    <Card data-testid="sign-contract-vault-card">
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{t('vault.heading')}</h2>
          <p className="text-xs text-muted-foreground">{t('vault.hint')}</p>
        </div>

        <form onSubmit={handleSubmitSearch} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="sign-vault-question-input" className="text-xs font-medium">
              {t('vault.inputLabel')}
            </Label>
            <Input
              id="sign-vault-question-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t('vault.inputPlaceholder')}
              maxLength={500}
              className="max-md:min-h-11"
              data-testid="sign-vault-question-input"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="outline"
              disabled={!trimmedQuestion || isBusy}
              loading={searchMutation.isPending}
              className="max-md:min-h-11"
              data-testid="sign-vault-search-btn"
            >
              {t('vault.searchButton')}
            </Button>
            {canAskVy ? (
              <Button
                type="button"
                disabled={!trimmedQuestion || isBusy}
                loading={askMutation.isPending}
                onClick={handleAskVy}
                className="max-md:min-h-11"
                data-testid="sign-vault-ask-btn"
              >
                {askMutation.isPending ? t('vault.askingVy') : t('vault.askVyButton')}
              </Button>
            ) : null}
            {result !== null || question.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                disabled={isBusy}
                onClick={handleClear}
                className="max-md:min-h-11"
                data-testid="sign-vault-clear-btn"
              >
                {t('vault.clearButton')}
              </Button>
            ) : null}
          </div>
        </form>

        {activeError ? <ErrorText>{activeError}</ErrorText> : null}

        {aiNoticeKey ? (
          <Alert data-testid="sign-vault-ai-notice">
            <AlertDescription>{t(aiNoticeKey)}</AlertDescription>
          </Alert>
        ) : null}

        {result?.summary ? (
          <div
            className="space-y-3 rounded-lg border border-border bg-muted/40 p-3"
            data-testid="sign-vault-vy-summary"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('vault.proposedByVyTitle')}
              </span>
              <Badge variant="outline">{t('vault.proposedByVyBadge')}</Badge>
            </div>
            <p className="text-sm text-foreground" data-testid="sign-vault-vy-answer">
              {result.summary.answer}
            </p>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('vault.citationsHeading', { count: String(result.summary.citations.length) })}
              </p>
              <div className="space-y-1.5">
                {result.summary.citations.map((cite, idx) => (
                  <div
                    key={`${cite.envelopeId}-${cite.pageNumber ?? 'na'}-${idx}`}
                    className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5 sm:flex-row sm:items-start sm:justify-between"
                    data-testid="sign-vault-citation-row"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {renderEnvelopeAction({
                          envelopeId: cite.envelopeId,
                          label: cite.envelopeTitle,
                          className:
                            'inline-flex items-center rounded-sm text-xs font-semibold text-foreground underline underline-offset-4 hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-11',
                          testId: `sign-vault-citation-link-${cite.envelopeId}`,
                        })}
                        {cite.pageNumber !== null ? (
                          <Badge variant="secondary">
                            {t('vault.pageBadge', { page: String(cite.pageNumber) })}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">{cite.quoteExcerpt}</p>
                    </div>
                    {renderEnvelopeAction({
                      envelopeId: cite.envelopeId,
                      label: t('vault.openEnvelopeLink'),
                      className: `${buttonVariants({ variant: 'ghost', size: 'sm' })} shrink-0 max-md:min-h-11`,
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {result !== null ? (
          result.items.length === 0 ? (
            <div data-testid="sign-vault-empty">
              <Empty title={t('vault.noMatchesTitle')} hint={t('vault.noMatchesHint')} />
            </div>
          ) : (
            <div className="space-y-2" data-testid="sign-vault-matches">
              <p className="text-xs font-medium text-muted-foreground">
                {t('vault.matchesHeading', { count: String(result.items.length) })}
              </p>
              <div className="space-y-2">
                {result.items.map((item) => (
                  <div
                    key={item.envelopeId}
                    className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                    data-testid={`sign-vault-match-${item.envelopeId}`}
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {renderEnvelopeAction({
                          envelopeId: item.envelopeId,
                          label: item.title,
                          className:
                            'inline-flex items-center truncate rounded-sm text-sm font-semibold text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-11',
                        })}
                        <Badge variant={STATUS_BADGE_VARIANT[item.status]}>
                          {t(`statuses.${item.status}`)}
                        </Badge>
                        {item.autoRenew ? (
                          <Badge variant="outline">{t('vault.autoRenewChip')}</Badge>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {item.counterpartyName ? (
                          <span>{t('vault.counterpartyChip', { name: item.counterpartyName })}</span>
                        ) : null}
                        {item.expiryDate ? (
                          <span>{t('vault.expiryChip', { date: f.date(item.expiryDate) })}</span>
                        ) : null}
                        {item.contractValue ? (
                          <span className="font-mono tabular-nums text-foreground">
                            {f.money(item.contractValue, item.currency ?? 'VND')}
                          </span>
                        ) : null}
                      </div>

                      {item.snippets.length > 0 ? (
                        <div className="space-y-1">
                          {item.snippets.slice(0, 2).map((snip, idx) => (
                            <div
                              key={`${item.envelopeId}-snip-${idx}`}
                              className="flex flex-wrap items-baseline gap-1.5 text-xs text-muted-foreground"
                            >
                              <Badge variant="outline" className="text-[11px]">
                                {t(`vault.snippetKind.${snip.kind}`)}
                              </Badge>
                              {snip.pageNumber !== null ? (
                                <span className="font-medium text-foreground">
                                  {t('vault.pageBadge', { page: String(snip.pageNumber) })}
                                </span>
                              ) : null}
                              <span>{snip.excerpt}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {renderEnvelopeAction({
                      envelopeId: item.envelopeId,
                      label: t('vault.openEnvelopeLink'),
                      className: `${buttonVariants({ variant: 'outline', size: 'sm' })} shrink-0 max-md:min-h-11`,
                      testId: `sign-vault-open-${item.envelopeId}`,
                    })}
                  </div>
                ))}
              </div>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
