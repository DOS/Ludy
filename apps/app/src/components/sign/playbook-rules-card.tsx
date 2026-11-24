// SPDX-License-Identifier: AGPL-3.0-only
// SME contract review playbook rules card for /o/$slug/sign/settings (Slice 5d, #4442).
// Ships 6 Vietnam SME default rules out of the box with zero setup; owners and admins can add, edit, toggle, delete, or restore defaults.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { ConfirmDialog } from '../confirm-dialog.tsx';
import { Empty, ErrorText, ListSkeleton } from '../ui.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import {
  signApi,
  type SignPlaybookRuleRecord,
  type SignPlaybookSeverityContract,
} from '../../lib/sign-api.ts';
import { toast } from '../../lib/toast.ts';

export interface PlaybookRulesCardProps {
  slug: string | null;
  role: string | null | undefined;
}

function severityBadgeVariant(
  severity: SignPlaybookSeverityContract,
): 'destructive' | 'warning' | 'secondary' {
  if (severity === 'critical') return 'destructive';
  if (severity === 'warn') return 'warning';
  return 'secondary';
}

export function parseKeywordsCsv(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 25) break;
  }
  return out;
}

export function PlaybookRulesCard({ slug, role }: PlaybookRulesCardProps) {
  const t = useTranslations('sign.playbook');
  const [editingRuleId, setEditingRuleId] = useState<string | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [guidance, setGuidance] = useState('');
  const [severity, setSeverity] = useState<SignPlaybookSeverityContract>('warn');
  const [keywordsCsv, setKeywordsCsv] = useState('');
  const [active, setActive] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['sign', 'playbook-rules', slug],
    queryFn: () => signApi.listPlaybookRules(),
  });

  const canManage =
    rulesQuery.data?.canManage ?? (role === 'owner' || role === 'admin');
  const rules = rulesQuery.data?.items ?? [];

  const invalidatePlaybook = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'playbook-rules', slug] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'playbook-check'] });
  };

  const openCreateForm = () => {
    setEditingRuleId('new');
    setTitle('');
    setGuidance('');
    setSeverity('warn');
    setKeywordsCsv('');
    setActive(true);
    setFormError(null);
  };

  const openEditForm = (rule: SignPlaybookRuleRecord) => {
    setEditingRuleId(rule.id);
    setTitle(rule.title);
    setGuidance(rule.guidance);
    setSeverity(rule.severity);
    setKeywordsCsv(rule.matchKeywords.join(', '));
    setActive(rule.active);
    setFormError(null);
  };

  const closeForm = () => {
    setEditingRuleId(null);
    setFormError(null);
  };

  const upsertMutation = useMutation({
    mutationFn: (input: {
      ruleId?: string;
      title: string;
      guidance: string;
      severity: SignPlaybookSeverityContract;
      matchKeywords: string[];
      active: boolean;
    }) => signApi.upsertPlaybookRule(input),
    onSuccess: async () => {
      toast(t('ruleSavedToast'));
      closeForm();
      await invalidatePlaybook();
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: (rule: SignPlaybookRuleRecord) =>
      signApi.upsertPlaybookRule({
        ruleId: rule.id,
        title: rule.title,
        guidance: rule.guidance,
        severity: rule.severity,
        matchKeywords: rule.matchKeywords,
        active: !rule.active,
      }),
    onSuccess: async () => {
      toast(t('ruleSavedToast'));
      await invalidatePlaybook();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => signApi.deletePlaybookRule(ruleId),
    onSuccess: async () => {
      toast(t('ruleDeletedToast'));
      if (editingRuleId && editingRuleId !== 'new') {
        closeForm();
      }
      await invalidatePlaybook();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const seedDefaultsMutation = useMutation({
    mutationFn: () => signApi.seedPlaybookDefaults(),
    onSuccess: async () => {
      toast(t('defaultsRestoredToast'));
      await invalidatePlaybook();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedGuidance = guidance.trim();
    if (!trimmedTitle || !trimmedGuidance) {
      return;
    }
    upsertMutation.mutate({
      ...(editingRuleId && editingRuleId !== 'new' ? { ruleId: editingRuleId } : {}),
      title: trimmedTitle,
      guidance: trimmedGuidance,
      severity,
      matchKeywords: parseKeywordsCsv(keywordsCsv),
      active,
    });
  };

  return (
    <Card data-testid="sign-playbook-rules-card">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">{t('settingsTitle')}</CardTitle>
          <CardDescription>{t('settingsSubtitle')}</CardDescription>
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={seedDefaultsMutation.isPending}
              onClick={() => seedDefaultsMutation.mutate()}
              data-testid="playbook-restore-defaults-btn"
            >
              {t('restoreDefaultsButton')}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              onClick={openCreateForm}
              data-testid="playbook-add-rule-btn"
            >
              {t('addRuleButton')}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!canManage ? (
          <Alert data-testid="playbook-readonly-notice">
            <AlertDescription>{t('readOnlyNotice')}</AlertDescription>
          </Alert>
        ) : null}

        {canManage && editingRuleId !== null ? (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-lg border bg-muted/20 p-4"
            data-testid="playbook-rule-form"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="playbook-rule-title">{t('ruleTitleLabel')}</Label>
                <Input
                  id="playbook-rule-title"
                  className="min-h-11"
                  maxLength={200}
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('ruleTitlePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playbook-rule-severity">{t('severityLabel')}</Label>
                <NativeSelect
                  id="playbook-rule-severity"
                  className="min-h-11 w-full [&_select]:min-h-11"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as SignPlaybookSeverityContract)}
                >
                  <NativeSelectOption value="critical">{t('severity.critical')}</NativeSelectOption>
                  <NativeSelectOption value="warn">{t('severity.warn')}</NativeSelectOption>
                  <NativeSelectOption value="info">{t('severity.info')}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="playbook-rule-guidance">{t('ruleGuidanceLabel')}</Label>
              <Textarea
                id="playbook-rule-guidance"
                rows={3}
                maxLength={2000}
                required
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder={t('ruleGuidancePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="playbook-rule-keywords">{t('ruleKeywordsLabel')}</Label>
              <Input
                id="playbook-rule-keywords"
                className="min-h-11"
                value={keywordsCsv}
                onChange={(e) => setKeywordsCsv(e.target.value)}
                placeholder={t('ruleKeywordsPlaceholder')}
              />
            </div>

            {formError ? <ErrorText>{formError}</ErrorText> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                className="min-h-11"
                disabled={upsertMutation.isPending || !title.trim() || !guidance.trim()}
                data-testid="playbook-save-rule-btn"
              >
                {t('saveRuleButton')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={upsertMutation.isPending}
                onClick={closeForm}
              >
                {t('cancelButton')}
              </Button>
            </div>
          </form>
        ) : null}

        {rulesQuery.isPending ? (
          <ListSkeleton />
        ) : rulesQuery.error ? (
          <ErrorText>{errorMessage(rulesQuery.error)}</ErrorText>
        ) : rules.length === 0 ? (
          <Empty title={t('emptyRulesTitle')} hint={t('emptyRulesHint')} />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="playbook-rules-list">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                data-testid={`playbook-rule-row-${rule.id}`}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{rule.title}</span>
                    <Badge variant={severityBadgeVariant(rule.severity)}>
                      {t(`severity.${rule.severity}`)}
                    </Badge>
                    <Badge variant={rule.active ? 'success' : 'outline'}>
                      {rule.active ? t('activeBadge') : t('inactiveBadge')}
                    </Badge>
                    <Badge variant="outline">
                      {rule.isDefault ? t('defaultRuleBadge') : t('customRuleBadge')}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-pre-line">
                    {rule.guidance}
                  </p>
                  {rule.matchKeywords.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('keywordsPrefix', { keywords: rule.matchKeywords.join(', ') })}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      disabled={toggleMutation.isPending}
                      onClick={() => toggleMutation.mutate(rule)}
                      data-testid={`playbook-toggle-btn-${rule.id}`}
                    >
                      {rule.active ? t('toggleInactiveButton') : t('toggleActiveButton')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => openEditForm(rule)}
                      data-testid={`playbook-edit-btn-${rule.id}`}
                    >
                      {t('editRuleButton')}
                    </Button>
                    <ConfirmDialog
                      title={t('deleteRuleTitle')}
                      description={t('deleteRuleConfirm', { title: rule.title })}
                      confirm={t('deleteRuleButton')}
                      destructive
                      disabled={deleteMutation.isPending}
                      onConfirm={() => deleteMutation.mutate(rule.id)}
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11"
                          data-testid={`playbook-delete-btn-${rule.id}`}
                        />
                      }
                    >
                      {t('deleteRuleButton')}
                    </ConfirmDialog>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
