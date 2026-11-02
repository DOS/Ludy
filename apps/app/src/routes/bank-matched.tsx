// SPDX-License-Identifier: AGPL-3.0-only
// The bank lines a voucher settles, after the fact (#2385): for an account and month, each matched line with its voucher,
// who approved it and how its party was found (the matcher's suggestion with its reason, or the person's own choice).
// Undoing a match is the ordinary reversal: it asks for a reversing entry through a proposal that someone approves, and
// the line opens again once it is posted; a posted voucher is never edited.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type BankMatchedLine } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useMatchText } from '../components/bank-match-text.ts';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

// 'YYYY-MM' of today in Vietnam.
const thisMonth = () => vietnamToday().slice(0, 7);

function Undo({ item, slug }: { item: BankMatchedLine; slug: string }) {
  const t = useTranslations('bank.matched');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  // The reversal is dated today, never before the voucher it undoes.
  const entryDate = vietnamToday() > item.voucher.date ? vietnamToday() : item.voucher.date;

  async function send() {
    setSending(true);
    setError(null);
    try {
      const result = await client.inbox.request({
        command: 'finance.journal.reverse',
        idempotencyKey: crypto.randomUUID(),
        input: { entryId: item.voucher.journalEntryId, entryDate, reason: reason.trim() },
      });
      setAsked(result.proposalId);
      await queryClient.invalidateQueries();
    } catch (failure) {
      setError(failure);
    } finally {
      setSending(false);
    }
  }

  if (asked !== null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="undo-asked">
        {t('undoAsked')}{' '}
        <Link to="/o/$slug/inbox/$id" params={{ slug, id: asked }} className="text-link hover:underline">
          {t('openProposal')}
        </Link>
      </p>
    );
  }
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" aria-label={t('undoFor', { code: item.voucher.code })} onClick={() => setOpen(true)}>
        {t('undo')}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={t('undoReason')} placeholder={t('undoReason')} className="w-56" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button type="button" size="sm" loading={sending} disabled={reason.trim() === ''} onClick={() => void send()}>
        {t('undoSend')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        {t('undoCancel')}
      </Button>
      {error !== null && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

export function BankMatchedPage() {
  const t = useTranslations('bank.matched');
  const say = useMatchText();
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const org = useQuery(orpc.org.get.queryOptions());
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const bankAccounts = (accounts.data ?? []).filter((a) => a.rootCode.startsWith('112') && a.code !== '112');
  const [account, setAccount] = useState('');
  const [month, setMonth] = useState(thisMonth);
  const entity = useChosenEntity();
  const valid = /^\d{4}-\d{2}$/.test(month);
  const matched = useQuery({
    ...orpc.bank.matched.queryOptions({ input: { ...(account ? { bankAccount: account } : {}), period: month, legalEntityId: entity.legalEntityId } }),
    enabled: entity.ready && valid,
  });
  const canUndo = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const items = matched.data?.items ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link to="/o/$slug/bank" params={{ slug }} className="text-sm text-link hover:underline">
            {t('back')}
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('account')}</span>
          <NativeSelect aria-label={t('account')} className="mt-1 w-64" value={account} onChange={(e) => setAccount(e.target.value)}>
            <NativeSelectOption value="">{t('allAccounts')}</NativeSelectOption>
            {bankAccounts.map((a) => (
              <NativeSelectOption key={a.code} value={a.code}>{`${a.code} ${a.name}`}</NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('month')}</span>
          <DateInput kind="month" aria-label={t('month')} className="mt-1 w-44" value={month} onChange={setMonth} />
        </label>
      </div>
      {matched.isLoading ? (
        <TableSkeleton columns={7} />
      ) : matched.error ? (
        <ErrorText>{errorMessage(matched.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <>
          <DataTable
            numeric={[2]}
            head={[t('columns.date'), t('columns.description'), t('columns.amount'), t('columns.voucher'), t('columns.party'), t('columns.approvedBy'), t('columns.how'), t('columns.status')]}
          >
            {items.map((item) => {
              const reversed = item.reversal !== null;
              return (
                <TableRow key={item.voucher.id} data-testid="matched-line">
                  <TableCell className="px-4 py-3 text-muted-foreground">{f.date(item.line.date)}</TableCell>
                  <TableCell className="px-4 py-3 text-foreground">{item.line.description}</TableCell>
                  <TableCell className={NUM}>{f.money(item.line.amount.replace(/^-/, ''))}</TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs">{item.voucher.code}</TableCell>
                  <TableCell className="px-4 py-3">{item.party?.name ?? ''}</TableCell>
                  <TableCell className="px-4 py-3 text-xs">
                    {item.approvedBy?.name ?? t('noApprover')}
                    {item.approvedAt ? <span className="block text-subtle-foreground">{f.date(item.approvedAt.slice(0, 10))}</span> : null}
                    {item.proposalId ? (
                      <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.proposalId }} className="block text-link hover:underline">
                        {t('openProposal')}
                      </Link>
                    ) : null}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs text-muted-foreground" data-testid="matched-how">
                    {say.matchedBy(item.matchedBy)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs">
                    {reversed ? <Badge variant="warning">{t('reversed')}</Badge> : <Badge variant="success">{t('posted')}</Badge>}
                    {!reversed && canUndo ? (
                      <div className="mt-2">
                        <Undo item={item} slug={slug} />
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>
          {matched.data?.more && (
            <Alert className="mt-4">
              <AlertDescription>{t('more')}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </>
  );
}
