// SPDX-License-Identifier: AGPL-3.0-only
// Accessible document tabs shared by multi-document Prepare and Ceremony screens (#4722, Slice 6c).
import { useId, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { cn } from '@ludy/ui/lib/utils';

export interface SignPacketTabItem {
  key: string;
  documentId: string | null;
  docIndex: number;
  title: string;
  pageCount: number | null;
  inspectStatus?: 'pending' | 'passed' | 'failed';
  badgeCount?: number | null;
  remainingRequiredCount?: number | null;
  totalRequiredCount?: number | null;
}

export interface SignPacketTabsProps {
  items: readonly SignPacketTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  ariaLabel?: string;
  idPrefix?: string | undefined;
  panelId?: string | undefined;
}

export function SignPacketTabs({
  items,
  activeKey,
  onSelect,
  ariaLabel,
  idPrefix,
  panelId,
}: SignPacketTabsProps) {
  const t = useTranslations('sign.packet');
  const fallbackPrefix = useId();
  const resolvedPrefix = idPrefix ?? fallbackPrefix;

  if (items.length <= 1) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    const nextItem = items[nextIndex];
    if (nextItem) {
      onSelect(nextItem.key);
      const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
        `[data-tab-index="${nextIndex}"]`,
      );
      target?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel ?? t('tabsAriaLabel')}
      className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/30 p-1.5"
      data-testid="sign-packet-tabs"
    >
      {items.map((item, idx) => {
        const active = item.key === activeKey;
        const missing = item.remainingRequiredCount ?? null;
        const totalReq = item.totalRequiredCount ?? null;
        return (
          <button
            key={item.key}
            id={`${resolvedPrefix}-tab-${item.key}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            data-tab-index={idx}
            data-testid={`sign-packet-tab-${item.docIndex}`}
            onClick={() => onSelect(item.key)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              'flex min-h-11 max-w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'border-primary bg-background text-foreground shadow-sm'
                : 'border-transparent bg-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground',
            )}
          >
            <span className="max-w-[200px] truncate">
              {t('docTabLabel', { index: String(item.docIndex), title: item.title })}
            </span>
            {item.pageCount !== null ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t('pagesCount', { count: String(item.pageCount) })}
              </span>
            ) : null}
            {item.inspectStatus === 'pending' ? (
              <Badge variant="outline" className="shrink-0">
                {t('inspectPending')}
              </Badge>
            ) : item.inspectStatus === 'failed' ? (
              <Badge variant="destructive" className="shrink-0">
                {t('inspectFailed')}
              </Badge>
            ) : null}
            {typeof item.badgeCount === 'number' && item.badgeCount > 0 ? (
              <Badge variant="secondary" className="shrink-0">
                {item.badgeCount}
              </Badge>
            ) : null}
            {missing !== null ? (
              missing > 0 ? (
                <Badge variant="warning" className="shrink-0">
                  {t('missingFieldsBadge', { count: String(missing) })}
                </Badge>
              ) : totalReq !== null && totalReq > 0 ? (
                <Badge variant="success" className="shrink-0">
                  {t('allFieldsDoneBadge')}
                </Badge>
              ) : null
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
