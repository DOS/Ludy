// SPDX-License-Identifier: AGPL-3.0-only
// Shared surface and coworker attribution header for unapproved AI coworker proposals across Ludy apps (DESIGN.md 1.1,
// 3.1, 4.4, 5.1; #4643). Unapproved proposals take a dashed proposal outline without wide shadows; approved, posted, or
// deterministic fallback outputs render as solid cards so proposed vs committed states stay visually distinct.
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { CoworkerKey } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { useCoworkerNames } from '../lib/coworker-names.ts';
import type { ProposalSourceTag } from '../lib/proposal-source.ts';

export type ProposalCoworkerKey = Exclude<CoworkerKey, 'system'>;

export interface ProposalSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  as?: 'div' | 'section' | 'li' | 'article';
  /** True for unapproved AI proposals/drafts (dashed proposal outline and subtle tint). Defaults to true. */
  proposed?: boolean;
}

export function ProposalSurface({
  as = 'div',
  proposed = true,
  className,
  children,
  ...rest
}: ProposalSurfaceProps) {
  const surfaceClass = cn(
    'rounded-xl border p-4 text-sm text-card-foreground',
    proposed ? 'border-dashed border-proposal/60 bg-proposal/5' : 'border-border bg-card',
    className,
  );

  if (as === 'section') {
    return (
      <section className={surfaceClass} {...(rest as ComponentPropsWithoutRef<'section'>)}>
        {children}
      </section>
    );
  }
  if (as === 'li') {
    return (
      <li className={surfaceClass} {...(rest as ComponentPropsWithoutRef<'li'>)}>
        {children}
      </li>
    );
  }
  if (as === 'article') {
    return (
      <article className={surfaceClass} {...(rest as ComponentPropsWithoutRef<'article'>)}>
        {children}
      </article>
    );
  }
  return (
    <div className={surfaceClass} {...rest}>
      {children}
    </div>
  );
}

export interface CoworkerAttributionProps {
  /** Roster key for a Ludy AI coworker ('gm' for Vy; 'finance', 'sales', 'marketing' for app coworkers). */
  coworker?: ProposalCoworkerKey | null | undefined;
  /** Optional display name override (for external AI agents/apps, or a name the caller already holds). Without it a roster key shows the org's current name for that coworker. */
  name?: string | null | undefined;
  /** Optional explicit role text. Pass null to omit role display. */
  role?: string | null | undefined;
  /** Optional formatted identity label (e.g. "From Vy"). Preserves exact text inside labelTestId. */
  label?: string | null | undefined;
  labelTestId?: string | undefined;
  /** Optional heading rendered alongside the attribution strip. */
  title?: string | undefined;
  titleAs?: 'h2' | 'h3' | 'p' | 'span' | undefined;
  /** Proposal or provenance status badge text. */
  badgeLabel?: string | undefined;
  badgeVariant?: 'proposal' | 'secondary' | 'outline' | undefined;
  badgeTestId?: string | undefined;
  /** Plain-language provenance explanation (e.g. learned rule, bank match, template notice). */
  source?: string | null | undefined;
  /** How it came to be, in one short tag (rule, exact match, same as last time, AI). Only from what the proposal recorded; omit when it recorded none. */
  tag?: ProposalSourceTag | null | undefined;
  sourceTestId?: string | undefined;
  /** Show the AI coworker icon mark. Defaults to true when coworker, name, or badge is shown. */
  showIcon?: boolean | undefined;
  /** Show the coworker role label beside the name. Defaults to true. */
  showRole?: boolean | undefined;
  /** Trailing elements such as risk chips or status pills. */
  aside?: ReactNode | undefined;
  className?: string | undefined;
}

export function CoworkerAttribution({
  coworker,
  name,
  role,
  label,
  labelTestId,
  title,
  titleAs = 'span',
  badgeLabel,
  badgeVariant = 'proposal',
  badgeTestId,
  source,
  tag,
  sourceTestId,
  showIcon,
  showRole = true,
  aside,
  className,
}: CoworkerAttributionProps) {
  const t = useTranslations('proposalSurface');
  const orgNames = useCoworkerNames();
  const displayName = name?.trim() || (coworker ? orgNames[coworker] : null);
  const resolvedRole = role === null ? null : (role ?? (coworker ? t(`roles.${coworker}`) : null));
  const primaryIdentity = label?.trim() || displayName;
  const iconVisible = showIcon ?? Boolean(coworker || name || badgeLabel);

  return (
    <div className={cn('space-y-1', className)} data-testid="coworker-attribution">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {iconVisible && <NavIcon name="appAi" className="size-4 shrink-0 text-proposal" aria-hidden="true" />}
          {title && titleAs === 'h2' && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          {title && titleAs === 'h3' && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
          {title && titleAs === 'p' && <p className="text-sm font-semibold text-foreground">{title}</p>}
          {title && titleAs === 'span' && <span className="text-sm font-semibold text-foreground">{title}</span>}
          {badgeLabel && (
            <Badge variant={badgeVariant} data-testid={badgeTestId}>
              {badgeLabel}
            </Badge>
          )}
          {primaryIdentity && (
            <span className="text-xs font-medium text-foreground" data-testid={labelTestId}>
              {primaryIdentity}
            </span>
          )}
          {showRole && resolvedRole && (
            <span className="text-xs text-subtle-foreground">
              {primaryIdentity ? `(${resolvedRole})` : resolvedRole}
            </span>
          )}
        </div>
        {tag || aside ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {tag ? (
              <Badge variant="outline" data-testid="proposal-source-tag" data-source-tag={tag}>
                {t(`sourceTags.${tag}`)}
              </Badge>
            ) : null}
            {aside}
          </div>
        ) : null}
      </div>
      {source ? (
        <p className="text-xs text-muted-foreground" data-testid={sourceTestId}>
          {source}
        </p>
      ) : null}
    </div>
  );
}
