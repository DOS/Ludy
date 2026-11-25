// SPDX-License-Identifier: AGPL-3.0-only
// Universal quick-create `+` menu for the Global Top Bar, PhoneHeader, and mobile NavDrawer (#4926).
// Only module-enabled, role-permitted creation actions are shown; viewers see nothing.
import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@ludy/ui/components/dropdown-menu';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { cn } from '@ludy/ui/lib/utils';
import type { QuickCreateItem } from '../lib/quick-create.ts';

export function QuickCreateMenu({
  slug,
  items,
  onOpenQuickCapture,
  onNavigate,
  variant = 'topbar',
  testId = 'shell-quick-capture-btn',
}: {
  slug: string;
  items: readonly QuickCreateItem[];
  onOpenQuickCapture?: (() => void) | undefined;
  onNavigate?: (() => void) | undefined;
  variant?: 'topbar' | 'phone' | 'drawer';
  testId?: string;
}) {
  const t = useTranslations('nav.quickCreate');
  const host = useRef<HTMLDivElement>(null);

  const visibleItems = items.filter((item) => item.kind !== 'action' || Boolean(onOpenQuickCapture));
  if (visibleItems.length === 0) return null;

  const triggerClass =
    variant === 'phone'
      ? 'size-11 shrink-0 bg-background text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
      : variant === 'drawer'
        ? 'min-h-11 min-w-11 shrink-0 md:size-8 md:min-h-0 md:min-w-0'
        : 'size-8 shrink-0 bg-background text-muted-foreground hover:bg-sidebar-accent hover:text-foreground';

  return (
    <div ref={host} className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t('trigger')}
              title={t('trigger')}
              data-testid={testId}
              className={cn(triggerClass)}
            />
          }
        >
          <ProjectIcon name="plus" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent container={host} align="end" side="bottom" sideOffset={6} aria-label={t('menuLabel')} className="w-60">
          {visibleItems.map((item) => {
            if (item.kind === 'action') {
              return (
                <DropdownMenuItem
                  key={item.id}
                  data-testid={`quick-create-${item.id}`}
                  onClick={() => {
                    onNavigate?.();
                    onOpenQuickCapture?.();
                  }}
                >
                  <NavIcon name={item.icon} />
                  <span className="min-w-0 flex-1 truncate">{t(item.id)}</span>
                  <kbd className="shrink-0 rounded-sm border bg-muted/50 px-1 font-mono text-[10px] leading-tight text-muted-foreground">
                    {item.shortcut}
                  </kbd>
                </DropdownMenuItem>
              );
            }
            return (
              <DropdownMenuLinkItem
                key={item.id}
                data-testid={`quick-create-${item.id}`}
                render={
                  <Link
                    to={item.to}
                    params={{ slug }}
                    {...(item.search ? { search: item.search as never } : {})}
                    onClick={onNavigate}
                  />
                }
              >
                <NavIcon name={item.icon} />
                <span className="min-w-0 flex-1 truncate">{t(item.id)}</span>
              </DropdownMenuLinkItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
