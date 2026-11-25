// SPDX-License-Identifier: AGPL-3.0-only
// Vy AI contract review panel and right-hand Sheet drawer with budget meter, clause risk jump links, proposal controls,
// and AI-off parity (#3325, #4643).
import type { RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@ludy/ui/components/sheet';
import type { SignAiAnalysis, SignProposedField } from '../../lib/sign-api.ts';
import { AiMeter } from '../ai-meter.tsx';
import { CoworkerAttribution, ProposalSurface } from '../proposal-surface.tsx';

export interface VyClausePanelProps {
  aiAnalysis: SignAiAnalysis | null | undefined;
  pendingProposals: readonly SignProposedField[];
  editable: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  onJumpToPage: (pageNumber: number) => void;
  onApplyAllProposals: () => void;
  inSheet?: boolean | undefined;
}

const RISK_VARIANT = {
  low: 'secondary',
  medium: 'warning',
  high: 'destructive',
} as const;

export function VyClauseTrigger({
  open,
  onToggle,
  buttonRef,
  proposalCount = 0,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  proposalCount?: number | undefined;
}) {
  const t = useTranslations('sign.vy');
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      className="gap-1.5 max-md:min-h-11"
      aria-expanded={open}
      onClick={onToggle}
      data-testid="vy-clause-trigger"
    >
      <NavIcon name="appAi" className="text-proposal" />
      <span>{t('openDrawer')}</span>
      {proposalCount > 0 ? (
        <Badge variant="proposal" data-testid="vy-clause-trigger-count">
          {proposalCount}
        </Badge>
      ) : null}
    </Button>
  );
}

export function VyClauseSheet({
  open,
  onClose,
  triggerRef,
  ...panelProps
}: VyClausePanelProps & {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('sign.vy');
  const tp = useTranslations('proposalSurface');
  const common = useTranslations('common');
  const clauses = panelProps.aiAnalysis?.riskClauses ?? [];
  const hasAiSurface =
    panelProps.pendingProposals.length > 0 ||
    Boolean(panelProps.aiAnalysis?.summaryText) ||
    clauses.length > 0;

  const handleClose = () => {
    onClose();
    window.setTimeout(() => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    }, 0);
  };

  if (!open) return null;

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <SheetContent closeLabel={t('closeDrawer')} className="sm:max-w-xl" data-testid="vy-clause-sheet">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <CoworkerAttribution
            coworker="gm"
            badgeLabel={hasAiSurface ? tp('proposedBadge') : undefined}
            tag={hasAiSurface ? 'ai' : null}
            aside={
              panelProps.aiAnalysis?.riskLevel ? (
                <Badge variant={RISK_VARIANT[panelProps.aiAnalysis.riskLevel]}>
                  {t(`riskLevel.${panelProps.aiAnalysis.riskLevel}`)}
                </Badge>
              ) : undefined
            }
          />
          <SheetDescription>{t('drawerDescription')}</SheetDescription>
          <AiMeter module="sign" />
        </SheetHeader>
        <SheetBody>
          <VyClausePanel {...panelProps} inSheet />
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:min-h-11"
            aria-label={t('closeDrawer')}
            onClick={handleClose}
            data-testid="vy-clause-close-btn"
          >
            {common('close')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function VyClausePanel({
  aiAnalysis,
  pendingProposals,
  editable,
  analyzing,
  onAnalyze,
  onJumpToPage,
  onApplyAllProposals,
  inSheet = false,
}: VyClausePanelProps) {
  const t = useTranslations('sign.vy');
  const tp = useTranslations('proposalSurface');

  const isOffOrExhausted = aiAnalysis?.status === 'disabled' || aiAnalysis?.status === 'budget_exhausted';
  const isFailed = aiAnalysis?.status === 'failed';
  const clauses = aiAnalysis?.riskClauses ?? [];
  const hasAiOutput = pendingProposals.length > 0 || Boolean(aiAnalysis?.summaryText) || clauses.length > 0;

  const body = (
    <div className="space-y-3 text-xs">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full max-md:min-h-11"
            loading={analyzing}
            onClick={onAnalyze}
          >
            {analyzing ? t('analyzing') : t('analyzeButton')}
          </Button>
        </div>
      ) : null}

      {editable && pendingProposals.length > 0 ? (
        <ProposalSurface proposed={inSheet} className="flex flex-wrap items-center justify-between gap-2 rounded-lg p-2.5">
          <span className="font-medium text-proposal">{t('proposedFieldsCount', { count: String(pendingProposals.length) })}</span>
          <Button type="button" size="sm" variant="secondary" className="max-md:min-h-11" onClick={onApplyAllProposals}>
            {t('applyAll', { count: String(pendingProposals.length) })}
          </Button>
        </ProposalSurface>
      ) : null}

      {aiAnalysis?.summaryText || clauses.length > 0 ? (
        <ProposalSurface proposed={inSheet} className="space-y-3 rounded-lg p-3">
          {aiAnalysis?.summaryText ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">{t('summaryHeading')}</p>
              <p className="leading-relaxed text-muted-foreground">{aiAnalysis.summaryText}</p>
            </div>
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
                          className="h-6 shrink-0 px-2 text-xs text-link max-md:min-h-11"
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
          ) : null}
        </ProposalSurface>
      ) : !isOffOrExhausted && !isFailed && pendingProposals.length === 0 ? (
        aiAnalysis?.status === 'completed' ? (
          <p className="text-muted-foreground">{t('noRisks')}</p>
        ) : (
          <p className="text-muted-foreground">{t('emptyProposals')}</p>
        )
      ) : null}

      {clauses.length === 0 && aiAnalysis?.status === 'completed' && Boolean(aiAnalysis?.summaryText) ? (
        <p className="text-muted-foreground">{t('noRisks')}</p>
      ) : null}

      <p className="border-t pt-2 text-[11px] text-muted-foreground">{t('humanGateNote')}</p>
    </div>
  );

  if (inSheet) {
    return (
      <div data-testid="vy-clause-panel" className="space-y-3">
        {body}
      </div>
    );
  }

  return (
    <ProposalSurface proposed={hasAiOutput} className="space-y-3" data-testid="vy-clause-panel">
      <CoworkerAttribution
        coworker="gm"
        title={t('title')}
        titleAs="h2"
        badgeLabel={hasAiOutput ? tp('proposedBadge') : undefined}
        tag={hasAiOutput ? 'ai' : null}
        aside={
          aiAnalysis?.riskLevel ? (
            <Badge variant={RISK_VARIANT[aiAnalysis.riskLevel]}>{t(`riskLevel.${aiAnalysis.riskLevel}`)}</Badge>
          ) : undefined
        }
      />
      <AiMeter module="sign" />
      {body}
    </ProposalSurface>
  );
}
