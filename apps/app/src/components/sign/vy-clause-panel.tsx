// SPDX-License-Identifier: AGPL-3.0-only
// Vy AI contract review panel with budget meter, clause risk jump links, proposal controls, and AI-off parity (#3325).
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@crove/ui/components/card';
import type { SignAiAnalysis, SignProposedField } from '../../lib/sign-api.ts';
import { AiMeter } from '../ai-meter.tsx';

export interface VyClausePanelProps {
  aiAnalysis: SignAiAnalysis | null | undefined;
  pendingProposals: readonly SignProposedField[];
  editable: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  onJumpToPage: (pageNumber: number) => void;
  onApplyAllProposals: () => void;
}

const RISK_VARIANT = {
  low: 'secondary',
  medium: 'warning',
  high: 'destructive',
} as const;

export function VyClausePanel({
  aiAnalysis,
  pendingProposals,
  editable,
  analyzing,
  onAnalyze,
  onJumpToPage,
  onApplyAllProposals,
}: VyClausePanelProps) {
  const t = useTranslations('sign.vy');

  const isOffOrExhausted = aiAnalysis?.status === 'disabled' || aiAnalysis?.status === 'budget_exhausted';
  const isFailed = aiAnalysis?.status === 'failed';
  const clauses = aiAnalysis?.riskClauses ?? [];

  return (
    <Card data-testid="vy-clause-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{t('title')}</CardTitle>
          {aiAnalysis?.riskLevel ? (
            <Badge variant={RISK_VARIANT[aiAnalysis.riskLevel]}>{t(`riskLevel.${aiAnalysis.riskLevel}`)}</Badge>
          ) : null}
        </div>
        <AiMeter module="sign" />
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {isOffOrExhausted ? (
          <p className="rounded-md border bg-muted/40 p-2.5 text-muted-foreground" data-testid="vy-ai-off-notice">
            {t('aiOffNotice')}
          </p>
        ) : null}

        {isFailed ? (
          <p className="rounded-md border bg-muted/40 p-2.5 text-muted-foreground" data-testid="vy-ai-failed-notice">
            {t(aiAnalysis?.errorMessage === 'no_text' ? 'noTextNotice' : 'failedNotice')}
          </p>
        ) : null}

        {editable && !isOffOrExhausted ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="w-full" loading={analyzing} onClick={onAnalyze}>
              {analyzing ? t('analyzing') : t('analyzeButton')}
            </Button>
          </div>
        ) : null}

        {editable && pendingProposals.length > 0 ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-proposal bg-proposal/10 p-2">
            <span className="font-medium text-proposal">{t('proposedFieldsCount', { count: String(pendingProposals.length) })}</span>
            <Button type="button" size="sm" variant="secondary" onClick={onApplyAllProposals}>
              {t('applyAll', { count: String(pendingProposals.length) })}
            </Button>
          </div>
        ) : null}

        {aiAnalysis?.summaryText ? (
          <div className="space-y-1">
            <p className="font-medium text-foreground">{t('summaryHeading')}</p>
            <p className="leading-relaxed text-muted-foreground">{aiAnalysis.summaryText}</p>
          </div>
        ) : !isOffOrExhausted && !isFailed && clauses.length === 0 && pendingProposals.length === 0 ? (
          <p className="text-muted-foreground">{t('emptyProposals')}</p>
        ) : null}

        {clauses.length > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-foreground">{t('clauseRiskHeading')}</p>
            <ul className="space-y-2" data-testid="vy-risk-clause-list">
              {clauses.map((clause) => (
                <li key={clause.clauseId} className="space-y-1.5 rounded-md border bg-card p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Badge variant={RISK_VARIANT[clause.severity]}>{t(`riskLevel.${clause.severity}`)}</Badge>
                      {clause.title ? <span className="truncate font-medium text-foreground">{clause.title}</span> : null}
                    </div>
                    {clause.pageNumber !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 px-2 text-xs text-link"
                        onClick={() => onJumpToPage(clause.pageNumber!)}
                      >
                        {t('jumpToPage', { page: String(clause.pageNumber) })}
                      </Button>
                    ) : null}
                  </div>
                  <p className="italic text-muted-foreground">&ldquo;{clause.quote}&rdquo;</p>
                  <p className="text-foreground">{clause.explanation}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : aiAnalysis?.status === 'completed' ? (
          <p className="text-muted-foreground">{t('noRisks')}</p>
        ) : null}

        <p className="border-t pt-2 text-[11px] text-muted-foreground">{t('humanGateNote')}</p>
      </CardContent>
    </Card>
  );
}
