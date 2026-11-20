// Learned account rules in Settings (issue #1399): what the approvals taught (a vendor's item and the account it was
// approved to) and the keyword rules owners and admins added, each with its provenance. Owners and admins remove any
// rule and add keyword rules; every role reads them. The server enforces every rule; the screen only offers what can
// succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { CategorizationRule } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { DuplicateHint } from '../components/form-panel.tsx';
import { ErrorText, Field, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { duplicateKeywordRule } from '../lib/duplicates.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.accountRules.list.key() });

export function AddKeywordRuleDialog({ rules, onClose }: { rules: readonly CategorizationRule[]; onClose: () => void }) {
  const t = useTranslations('accountRules');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [keyword, setKeyword] = useState('');
  const [accountCode, setAccountCode] = useState('');
  // A keyword rule is learned for the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const create = useMutation(
    orpc.accountRules.create.mutationOptions({
      onSuccess: () => {
        refresh();
        onClose();
      },
    }),
  );
  // The same keyword already listed (the list is the chosen entity's), flagged while it is typed.
  const repeated = duplicateKeywordRule(rules, keyword);
  const incomplete = !entity.ready || !keyword.trim() || !accountCode;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete || repeated) return;
    create.mutate({ keyword: keyword.trim(), accountCode, legalEntityId: entity.legalEntityId });
  }
  return (
    <FormDialog
      title={t('addTitle')}
      description={t('addHint')}
      busy={create.isPending}
      dirty={keyword.trim() !== '' || accountCode !== ''}
      submitLabel={t('add')}
      submitDisabled={incomplete || repeated !== null}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={t('keyword')}>
        {(control) => <Input {...control} required maxLength={500} placeholder={t('keywordPlaceholder')} value={keyword} onChange={(e) => setKeyword(e.target.value)} />}
      </Field>
      <DuplicateHint testId="keyword-rule-duplicate">{repeated ? t('duplicate', { keyword: repeated.matchText, code: repeated.accountCode }) : null}</DuplicateHint>
      <Field label={t('account')}>
        {(control) => (
          <NativeSelect {...control} required value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
            <NativeSelectOption value="">{t('pickAccount')}</NativeSelectOption>
            {/* Accounts a purchase line may go to (#430), in use. */}
            {pickableAccounts(accounts.data ?? [], null, 'purchase').map((a) => (
              <NativeSelectOption key={a.code} value={a.code}>
                {accountLabel(a)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </Field>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </FormDialog>
  );
}

function RuleRow({ rule, canManage }: { rule: CategorizationRule; canManage: boolean }) {
  const t = useTranslations('accountRules');
  const tc = useTranslations('common');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(orpc.accountRules.remove.mutationOptions({ onSuccess: refresh }));
  const text = rule.label?.trim() || rule.matchText;
  const name = rule.confirmedBy ?? t('formerMember');
  const date = f.date(rule.confirmedAt);
  const invoice = rule.sourceDocument ? [rule.sourceDocument.series, rule.sourceDocument.number].filter(Boolean).join('/') : null;
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-foreground">{text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
            <Badge variant="secondary">{rule.matchKind === 'description' ? t('kindDescription') : t('kindKeyword')}</Badge>
            <span>{rule.vendor ? rule.vendor.name : t('allVendors')}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{t('toAccount', { code: rule.accountCode })}</span>
            <span aria-hidden>·</span>
            <span data-testid="rule-corrections">{rule.corrections === 0 ? t('correctionsNone') : t('corrections', { count: rule.corrections })}</span>
          </div>
          <p className="mt-1 text-xs text-subtle-foreground">{invoice ? t('learnedFrom', { name, date, invoice }) : t('addedBy', { name, date })}</p>
        </div>
        {canManage && !confirming && (
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(true)} aria-label={t('removeOf', { rule: text })}>
            {t('remove')}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <span className="text-sm text-foreground">{t('confirmRemove')}</span>
          <Button loading={remove.isPending} variant="destructive" size="sm" onClick={() => remove.mutate({ id: rule.id })}>
            {t('confirm')}
          </Button>
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(false)}>
            {tc('cancel')}
          </Button>
        </div>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </li>
  );
}

export function AccountRulesCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('accountRules');
  // The rules of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const rules = useQuery({ ...orpc.accountRules.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const [adding, setAdding] = useState(false);
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {rules.isPending ? (
        <RowsSkeleton />
      ) : rules.error ? (
        <ErrorText>{errorMessage(rules.error)}</ErrorText>
      ) : (rules.data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-3 divide-y">
          {(rules.data ?? []).map((r) => (
            <RuleRow key={r.id} rule={r} canManage={canManage} />
          ))}
        </ul>
      )}
      {canManage && (
        <div className="mt-4">
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('addTitle')}
          </Button>
        </div>
      )}
      {adding && <AddKeywordRuleDialog rules={rules.data ?? []} onClose={() => setAdding(false)} />}
    </Card>
  );
}
