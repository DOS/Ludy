// SPDX-License-Identifier: AGPL-3.0-only
// TC2 enterprise tax-code lookup proposal card and shared form hook (#4989, docs/plan/crm.md 10.1).
// Shows looked-up company name, address, operating status chip, and fetched date as a proposal the person accepts
// per empty field; non-empty fields show their existing value beside the looked-up value and are never overwritten.
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode, vietnamToday, type PartyTaxLookupResult } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

export const PARTY_NAME_MAX = 300;
export const PARTY_ADDRESS_MAX = 500;

export type TaxLookupStatusKind = 'active' | 'inactive' | 'unknown';

const STATUS_VARIANTS: Record<TaxLookupStatusKind, 'success' | 'destructive' | 'outline'> = {
  active: 'success',
  inactive: 'destructive',
  unknown: 'outline',
};

const INACTIVE_STATUS_RE =
  /\b(?:ngung hoat dong|tam ngung|nghi kinh doanh|giai the|cham dut|dong ma so thue|dong mst|khoa mst|khong hoat dong|inactive|closed|dissolved|suspended|ceased)\b/;
const ACTIVE_STATUS_RE = /\b(?:dang hoat dong|hoat dong|active|operating)\b/;

function foldAsciiLower(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns true when deployment public config enables party tax-code lookup (TC1). */
export function isPartyTaxLookupDeployed(): boolean {
  try {
    return getConfig().partyTaxLookup === true;
  } catch {
    return false;
  }
}

/**
 * Normalizes 10-digit enterprise or 13-digit (10-3) branch tax codes eligible for lookup.
 * Returns null for empty, invalid, or 12-digit personal citizen IDs.
 */
export function enterpriseTaxCode(raw: string | null | undefined): string | null {
  const normalized = normalizeTaxCode(raw);
  if (!normalized) return null;
  return /^\d{10}(?:-\d{3})?$/.test(normalized) ? normalized : null;
}

/** Maps a provider operating-status string to one of the three canonical status chip kinds. */
export function classifyTaxLookupStatus(statusText: string | null | undefined): TaxLookupStatusKind {
  if (!statusText) return 'unknown';
  const folded = foldAsciiLower(statusText);
  if (!folded) return 'unknown';
  if (INACTIVE_STATUS_RE.test(folded)) return 'inactive';
  if (ACTIVE_STATUS_RE.test(folded)) return 'active';
  return 'unknown';
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim() === '';
}

function isInformationalLookupError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'TAX_LOOKUP_ORG_DISABLED' || code === 'TAX_LOOKUP_DISABLED';
}

export interface TaxLookupSnapshot {
  taxCode: string;
  result: PartyTaxLookupResult;
  fetchedDate: string;
}

export interface UsePartyTaxLookupResult {
  deployed: boolean;
  canLookup: boolean;
  normalizedCode: string | null;
  isPending: boolean;
  snapshot: TaxLookupSnapshot | null;
  error: unknown;
  lookUpNow: () => void;
  triggerOnBlur: (rawTaxCode: string) => void;
  reset: () => void;
}

/** Shared lookup state, blur deduplication, and stale-response protection for party create/edit forms. */
export function usePartyTaxLookup(rawTaxCode: string, enabled = true): UsePartyTaxLookupResult {
  const deployed = enabled && isPartyTaxLookupDeployed();
  const normalizedCode = deployed ? enterpriseTaxCode(rawTaxCode) : null;
  const canLookup = normalizedCode !== null;

  const [snapshot, setSnapshot] = useState<TaxLookupSnapshot | null>(null);
  const [errorState, setErrorState] = useState<{ taxCode: string; error: unknown } | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const currentCodeRef = useRef<string | null>(normalizedCode);
  currentCodeRef.current = normalizedCode;
  const inFlightCodeRef = useRef<string | null>(null);
  const autoBlurredCodeRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (autoBlurredCodeRef.current !== null && autoBlurredCodeRef.current !== normalizedCode) {
      autoBlurredCodeRef.current = null;
    }
  }, [normalizedCode]);

  const { mutateAsync } = useMutation(orpc.parties.taxLookup.mutationOptions());

  const runLookup = (targetCode: string) => {
    if (!deployed) return;
    if (inFlightCodeRef.current === targetCode) return;
    const seq = ++requestSeqRef.current;
    inFlightCodeRef.current = targetCode;
    setPendingCode(targetCode);
    setErrorState(null);
    void mutateAsync({ taxCode: targetCode })
      .then((result) => {
        if (!aliveRef.current || requestSeqRef.current !== seq || currentCodeRef.current !== targetCode) return;
        setSnapshot({ taxCode: targetCode, result, fetchedDate: vietnamToday() });
      })
      .catch((error: unknown) => {
        if (!aliveRef.current || requestSeqRef.current !== seq || currentCodeRef.current !== targetCode) return;
        setSnapshot(null);
        setErrorState({ taxCode: targetCode, error });
      })
      .finally(() => {
        if (requestSeqRef.current === seq) {
          inFlightCodeRef.current = null;
          if (aliveRef.current) setPendingCode(null);
        }
      });
  };

  const visibleSnapshot = normalizedCode !== null && snapshot?.taxCode === normalizedCode ? snapshot : null;
  const visibleError = normalizedCode !== null && errorState?.taxCode === normalizedCode ? errorState.error : null;
  const isPending = normalizedCode !== null && pendingCode === normalizedCode;

  const lookUpNow = () => {
    if (!normalizedCode) return;
    autoBlurredCodeRef.current = normalizedCode;
    runLookup(normalizedCode);
  };

  const triggerOnBlur = (raw: string) => {
    if (!deployed) return;
    const code = enterpriseTaxCode(raw);
    if (!code) return;
    if (autoBlurredCodeRef.current === code || inFlightCodeRef.current === code) return;
    if (snapshot?.taxCode === code) return;
    autoBlurredCodeRef.current = code;
    runLookup(code);
  };

  const reset = () => {
    requestSeqRef.current += 1;
    inFlightCodeRef.current = null;
    autoBlurredCodeRef.current = null;
    setPendingCode(null);
    setSnapshot(null);
    setErrorState(null);
  };

  return {
    deployed,
    canLookup,
    normalizedCode,
    isPending,
    snapshot: visibleSnapshot,
    error: visibleError,
    lookUpNow,
    triggerOnBlur,
    reset,
  };
}

export function TaxLookupButton({ isPending, onClick }: { isPending: boolean; onClick: () => void }) {
  const t = useTranslations('contacts.taxLookup');
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 max-md:min-h-11"
      loading={isPending}
      onClick={onClick}
      data-testid="tax-lookup-trigger"
    >
      {t('trigger')}
    </Button>
  );
}

/** Places the lookup button beside the tax-code input when lookup is available for a 10- or 13-digit code. */
export function TaxCodeFieldRow({
  lookup,
  children,
}: {
  lookup: UsePartyTaxLookupResult;
  children: (inputClassName: string | undefined) => ReactNode;
}) {
  if (!lookup.deployed || !lookup.canLookup) return <>{children(undefined)}</>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children('min-w-36 flex-1 font-mono')}
      <TaxLookupButton isPending={lookup.isPending} onClick={lookup.lookUpNow} />
    </div>
  );
}

interface LookupFieldRowProps {
  label: string;
  lookedUp: string | null;
  currentValue: string;
  onFill?: (() => void) | undefined;
  testId: string;
  fillTestId: string;
}

function LookupFieldRow({ label, lookedUp, currentValue, onFill, testId, fillTestId }: LookupFieldRowProps) {
  const t = useTranslations('contacts.taxLookup');
  const hasCurrent = !isBlank(currentValue);

  if (hasCurrent) {
    return (
      <div className="space-y-1" data-testid={testId}>
        <span className="block text-xs text-subtle-foreground">{label}</span>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5">
            <span className="block text-xs text-subtle-foreground">{t('currentValue')}</span>
            <span className="block break-words text-foreground" data-testid={`${testId}-current`}>
              {currentValue.trim()}
            </span>
          </div>
          <div className="min-w-0 rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5">
            <span className="block text-xs text-subtle-foreground">{t('lookedUpValue')}</span>
            <span className="block break-words text-foreground" data-testid={`${testId}-looked-up`}>
              {lookedUp ?? t('emptyValue')}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <span className="block text-xs text-subtle-foreground">{label}</span>
        {lookedUp ? (
          <span className="block break-words font-medium text-foreground" data-testid={`${testId}-looked-up`}>
            {lookedUp}
          </span>
        ) : (
          <span className="block text-xs text-muted-foreground" data-testid={`${testId}-looked-up`}>
            {t('emptyValue')}
          </span>
        )}
      </div>
      {lookedUp && onFill && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 max-md:min-h-11"
          aria-label={t('fillField', { field: label })}
          onClick={onFill}
          data-testid={fillTestId}
        >
          {t('fill')}
        </Button>
      )}
    </div>
  );
}

export interface TaxLookupCardProps {
  lookup: UsePartyTaxLookupResult;
  currentName: string;
  currentAddress: string;
  onFillName: (name: string) => void;
  onFillAddress: (address: string) => void;
  className?: string | undefined;
}

export function TaxLookupCard({ lookup, currentName, currentAddress, onFillName, onFillAddress, className }: TaxLookupCardProps) {
  const t = useTranslations('contacts.taxLookup');
  const f = useFormat();
  const headingId = useId();

  if (!lookup.deployed) return null;

  const { isPending, error, snapshot } = lookup;
  const hasFoundCard = Boolean(snapshot && snapshot.result.found && snapshot.result.name);
  const hasNotFound = Boolean(snapshot && (!snapshot.result.found || !snapshot.result.name));
  const hasContent = isPending || Boolean(error) || hasFoundCard || hasNotFound;
  const statusKind = classifyTaxLookupStatus(snapshot?.result.statusText);

  return (
    <div aria-live="polite" className={hasContent ? className : 'sr-only'} data-testid="tax-lookup-region">
      {isPending ? (
        <p role="status" className="text-xs text-muted-foreground" data-testid="tax-lookup-loading">
          {t('loading')}
        </p>
      ) : error ? (
        <p
          role="status"
          className={isInformationalLookupError(error) ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
          data-testid="tax-lookup-error"
        >
          {errorMessage(error)}
        </p>
      ) : hasNotFound ? (
        <p role="status" className="text-xs text-muted-foreground" data-testid="tax-lookup-not-found">
          {t('notFound')}
        </p>
      ) : hasFoundCard && snapshot ? (
        <section
          aria-labelledby={headingId}
          className="min-w-0 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3 text-sm"
          data-testid="tax-lookup-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={headingId} className="text-xs font-medium text-foreground">
              {t('title')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANTS[statusKind]} data-testid="tax-lookup-status">
                <span className="sr-only">{t('statusPrefix')}: </span>
                {t(`status.${statusKind}`)}
              </Badge>
              <time dateTime={snapshot.fetchedDate} className="text-xs text-muted-foreground tabular-nums" data-testid="tax-lookup-date">
                {t('fetchedOn', { date: f.date(snapshot.fetchedDate) })}
              </time>
            </div>
          </div>
          <div className="space-y-2 border-t border-border/70 pt-2">
            <LookupFieldRow
              label={t('fields.name')}
              lookedUp={snapshot.result.name}
              currentValue={currentName}
              onFill={
                snapshot.result.name
                  ? () => {
                      if (isBlank(currentName)) onFillName(snapshot.result.name!.slice(0, PARTY_NAME_MAX).trim());
                    }
                  : undefined
              }
              testId="tax-lookup-field-name"
              fillTestId="tax-lookup-fill-name"
            />
            <LookupFieldRow
              label={t('fields.address')}
              lookedUp={snapshot.result.address}
              currentValue={currentAddress}
              onFill={
                snapshot.result.address
                  ? () => {
                      if (isBlank(currentAddress)) onFillAddress(snapshot.result.address!.slice(0, PARTY_ADDRESS_MAX).trim());
                    }
                  : undefined
              }
              testId="tax-lookup-field-address"
              fillTestId="tax-lookup-fill-address"
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
