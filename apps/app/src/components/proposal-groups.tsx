// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's groups of clean purchase proposals (issue #2379): one card per vendor and learned rule, with the rule, how
// often people corrected it, each invoice and its reason, and one button that approves the group through the bulk approval.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { CategorizationRule } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { RULE_OFTEN_CORRECTED, type GroupableItem, type ProposalGroup } from '../lib/proposal-groups.ts';
import { proposalName } from '../lib/review.ts';

export interface GroupedItem extends GroupableItem {
  revision: number;
  issueDate: string | null;
  title: string;
  buyerName: string | null;
}

export function ProposalGroups<T extends GroupedItem>({
  groups,
  rules,
  slug,
  sending,
  onApprove,
}: {
  groups: ProposalGroup<T>[];
  rules: readonly CategorizationRule[];
  slug: string;
  sending: boolean;
  onApprove: (items: T[]) => void;
}) {
  const t = useTranslations('inbox');
  const f = useFormat();
  const byId = new Map(rules.map((r) => [r.id, r]));
  // Why the accounts of an invoice are what they are, in a few words: by a rule people taught, or proposed automatically.
  const reasonOf = (item: GroupedItem): string => {
    const learned = (item.learnedRuleIds ?? []).length > 0;
    const other = item.otherRuleLines ?? 0;
    if (learned && other === 0) return t('groups.reasonRule');
    if (learned) return t('groups.reasonRuleAndOther', { count: other });
    return t('groups.reasonOther', { count: other });
  };
  if (groups.length === 0) return null;
  return (
    <section className="mb-4 space-y-3" aria-label={t('groups.title')} data-testid="proposal-groups">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('groups.title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('groups.hint')}</p>
      </div>
      {groups.map((group) => (
        <Card key={group.key} className="block space-y-2 p-4" data-testid="proposal-group">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words font-medium text-foreground">{group.vendor}</p>
              <p className="text-sm text-muted-foreground">{t('groups.summary', { count: group.items.length, total: f.money(group.total) })}</p>
            </div>
            <Button size="lg" loading={sending} disabled={sending} aria-label={t('groups.approveOf', { vendor: group.vendor })} onClick={() => onApprove(group.items)}>
              {t('groups.approve', { count: group.items.length })}
            </Button>
          </div>
          <ul className="space-y-1 text-sm">
            {group.ruleIds.map((id) => {
              const rule = byId.get(id);
              return (
                <li key={id} className="flex flex-wrap items-center gap-2" data-testid="group-rule">
                  <span className="text-foreground">
                    {rule ? t('groups.rule', { rule: rule.label?.trim() || rule.matchText }) : t('groups.ruleUnlisted')}
                  </span>
                  {rule && (
                    <Badge variant={rule.corrections >= RULE_OFTEN_CORRECTED ? 'warning' : 'secondary'} data-testid="group-rule-corrections">
                      {rule.corrections === 0 ? t('groups.correctionsNone') : t('groups.corrections', { count: rule.corrections })}
                    </Badge>
                  )}
                </li>
              );
            })}
            {group.otherLines > 0 && <li className="text-muted-foreground">{t('groups.plainLines', { count: group.otherLines })}</li>}
          </ul>
          <ul className="divide-y text-sm">
            {group.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5" data-testid="group-item">
                <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.id }} className="text-link hover:underline">
                  {proposalName(item)}
                </Link>
                <span className="text-xs text-subtle-foreground">{reasonOf(item)}</span>
                <span className="ml-auto text-foreground tabular-nums">{item.total === null ? '' : f.money(item.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </section>
  );
}
