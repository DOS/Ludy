import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FixedAsset } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AmountInput } from '../components/amount-input.tsx';
import { DateInput } from '../components/date-input.tsx';
import { DuplicateHint, FormPanel } from '../components/form-panel.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, FieldError, fieldControl, fieldErrorId, focusFirstInvalid, PageHeader, TableSkeleton, useFieldErrors } from '../components/ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { groupAmount } from '../lib/amount-input.ts';
import { apiFetch, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { exportQuery } from '../lib/legal-entity-choice.ts';
import {
  defaultAccounts,
  findDuplicateAsset,
  FIXED_ASSET_FORM_FIELDS,
  fixedAssetFieldProblem,
  fixedAssetInput,
  monthLabel,
  previousMonth,
  recentMonths,
  type FixedAssetForm,
  type FixedAssetFormProblem,
  type FixedAssetKind,
} from '../lib/fixed-assets.ts';
import { localToday } from '../lib/reversal.ts';
import { canEnterVoucher } from '../lib/vouchers.ts';

// The register of fixed assets and prepaid costs (#919): every entry with what it posted and what is left. Owners,
// admins and members add an entry and stop one early, and ask for a month's depreciation, which the kernel builds
// from the register as a general journal voucher that an owner or admin approves in the Inbox (R3, four-eyes, fresh
// MFA).

function AssetFormPanel({ onClose }: { onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const { locale } = useLocaleSetting();
  const [form, setForm] = useState<FixedAssetForm>(() => ({
    kind: 'fixed_asset',
    name: '',
    cost: '',
    ...defaultAccounts('fixed_asset'),
    startMonth: localToday().slice(0, 7),
    months: '36',
  }));
  // One key per form: a retry of the same entry returns the first result.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.fixedAssets.create.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  // Entered in the register of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  // The register as it is, read for the duplicate hint (the screen reads the same list, so this is one request).
  const register = useQuery({ ...orpc.fixedAssets.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  // The accounts (the usual ones for the kind are filled in) open on request: most entries never change them.
  const [details, setDetails] = useState(false);
  const set = (patch: Partial<FixedAssetForm>) => setForm((f) => ({ ...f, ...patch }));
  // Each problem sits under its field, checked on leaving it and on submit (DESIGN.md §4.2, #2004); the accounts' sits
  // under the last account field and names all three. The kernel checks again.
  const ids = useId();
  const idOf = (field: FixedAssetFormProblem) => `${ids}-${field}`;
  const fields = useFieldErrors<FixedAssetFormProblem>((field) => (fixedAssetFieldProblem(form, field) ? t(`formProblems.${field}`) : null));
  const control = (field: FixedAssetFormProblem) => fieldControl(idOf(field), { error: Boolean(fields.of(field)) });
  const edited = (field: FixedAssetFormProblem, patch: Partial<FixedAssetForm>) => {
    set(patch);
    fields.edit(field);
  };
  const accountsInvalid = Boolean(fields.of('accounts'));
  const detailsOpen = details || accountsInvalid;
  const duplicate = findDuplicateAsset(register.data ?? [], form.name, form.cost);
  const account = { 'aria-invalid': accountsInvalid || undefined, 'aria-describedby': accountsInvalid ? fieldErrorId(idOf('accounts')) : undefined };
  const accountInput = (key: 'assetAccount' | 'accumulatedAccount' | 'expenseAccount') => (
    <Input
      {...account}
      className="mt-1 font-mono"
      value={form[key]}
      onChange={(e) => edited('accounts', { [key]: e.target.value })}
      onBlur={(e) => fields.blur('accounts', e.target.value)}
    />
  );

  if (create.data) {
    return (
      <FormPanel
        title={t('newTitle')}
        onClose={onClose}
        footer={
          <Button type="button" onClick={onClose}>
            {root('common.close')}
          </Button>
        }
      >
        <Alert>
          <AlertDescription>{t('created')}</AlertDescription>
        </Alert>
      </FormPanel>
    );
  }

  return (
    <FormPanel
      title={t('newTitle')}
      description={t('newIntro')}
      busy={create.isPending}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (!fields.checkAll(FIXED_ASSET_FORM_FIELDS)) {
          focusFirstInvalid(event.currentTarget);
          return;
        }
        if (!entity.ready) return;
        create.mutate({ ...fixedAssetInput(form), legalEntityId: entity.legalEntityId, idempotencyKey });
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            {root('common.cancel')}
          </Button>
          <Button loading={create.isPending} type="submit">
            {t('add')}
          </Button>
        </>
      }
    >
      <div className="text-xs">
        <label className="block">
          <span className="text-subtle-foreground">{t('name')}</span>
          <Input
            {...control('name')}
            className="mt-1"
            value={form.name}
            maxLength={500}
            onChange={(e) => edited('name', { name: e.target.value })}
            onBlur={(e) => fields.blur('name', e.target.value)}
            placeholder={t('namePlaceholder')}
          />
        </label>
        <FieldError id={idOf('name')} className="mt-1">
          {fields.of('name')}
        </FieldError>
      </div>
      <div className="text-xs">
        <label className="block">
          <span className="text-subtle-foreground">{t('cost')}</span>
          <AmountInput
            {...control('cost')}
            className="mt-1 text-right tabular-nums"
            value={form.cost}
            onChange={(cost) => edited('cost', { cost })}
            onBlur={(e) => fields.blur('cost', e.target.value)}
            placeholder={groupAmount('36000000', locale)}
          />
        </label>
        <FieldError id={idOf('cost')} className="mt-1">
          {fields.of('cost')}
        </FieldError>
      </div>
      <DuplicateHint testId="asset-duplicate">{duplicate && t('duplicate', { name: duplicate.name })}</DuplicateHint>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('kind')}</span>
        <NativeSelect
          className="mt-1 w-full"
          value={form.kind}
          onChange={(e) => {
            const kind = e.target.value as FixedAssetKind;
            edited('accounts', { kind, ...defaultAccounts(kind) });
          }}
        >
          <NativeSelectOption value="fixed_asset">{t('kinds.fixed_asset')}</NativeSelectOption>
          <NativeSelectOption value="prepaid_cost">{t('kinds.prepaid_cost')}</NativeSelectOption>
        </NativeSelect>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="text-xs">
          <label className="block">
            <span className="text-subtle-foreground">{t('startMonth')}</span>
            <DateInput
              kind="month"
              {...control('startMonth')}
              className="mt-1 w-full"
              value={form.startMonth}
              onChange={(startMonth) => edited('startMonth', { startMonth })}
            />
          </label>
          <FieldError id={idOf('startMonth')} className="mt-1">
            {fields.of('startMonth')}
          </FieldError>
        </div>
        <div className="text-xs">
          <label className="block">
            <span className="text-subtle-foreground">{t('months')}</span>
            <Input
              {...control('months')}
              className="mt-1"
              inputMode="numeric"
              value={form.months}
              onChange={(e) => edited('months', { months: e.target.value })}
              onBlur={(e) => fields.blur('months', e.target.value)}
            />
          </label>
          <FieldError id={idOf('months')} className="mt-1">
            {fields.of('months')}
          </FieldError>
        </div>
      </div>
      {detailsOpen ? (
        <div className="space-y-4">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('assetAccount')}</span>
            {accountInput('assetAccount')}
          </label>
          {form.kind === 'fixed_asset' && (
            <label className="block text-xs">
              <span className="text-subtle-foreground">{t('accumulatedAccount')}</span>
              {accountInput('accumulatedAccount')}
            </label>
          )}
          <div className="text-xs">
            <label className="block">
              <span className="text-subtle-foreground">{t('expenseAccount')}</span>
              {accountInput('expenseAccount')}
            </label>
            <FieldError id={idOf('accounts')} className="mt-1">
              {fields.of('accounts')}
            </FieldError>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDetails(true)}>
            {t('moreDetails')}
          </Button>
        </div>
      )}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </FormPanel>
  );
}

function DepreciationPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const months = recentMonths(previousMonth(localToday()));
  const [month, setMonth] = useState(months[0] ?? '');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));
  // The register of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();

  if (request.data) {
    return (
      <FormPanel
        title={t('depreciationTitle')}
        onClose={onClose}
        footer={
          <Button type="button" onClick={onClose}>
            {root('common.close')}
          </Button>
        }
      >
        <Alert>
          <AlertDescription>
            {t('depreciationCreated', { month: monthLabel(month) })}{' '}
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
              {t('viewProposal')}
            </Link>
          </AlertDescription>
        </Alert>
      </FormPanel>
    );
  }

  return (
    <FormPanel
      title={t('depreciationTitle')}
      description={t('depreciationIntro')}
      busy={request.isPending}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        request.mutate({ command: 'finance.depreciation.record', idempotencyKey, input: { month, legalEntityId: entity.legalEntityId } });
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
            {root('common.cancel')}
          </Button>
          <Button loading={request.isPending} type="submit" disabled={request.isPending || !entity.ready}>
            {t('depreciationSubmit')}
          </Button>
        </>
      }
    >
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('month')}</span>
        <NativeSelect className="mt-1 w-full" value={month} onChange={(e) => setMonth(e.target.value)} disabled={request.isPending}>
          {months.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {monthLabel(m)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
    </FormPanel>
  );
}

// Stops a schedule early (disposed of, written off): the month given is the last that still counts.
function EndPanel({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('fixedAssets');
  const [month, setMonth] = useState(asset.lastPostedMonth ?? previousMonth(localToday()));
  const [reason, setReason] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const end = useMutation(orpc.fixedAssets.end.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  return (
    <FormPanel
      title={t('endTitle', { name: asset.name })}
      busy={end.isPending}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() === '') return;
        end.mutate({ assetId: asset.id, month, reason: reason.trim(), idempotencyKey }, { onSuccess: onClose });
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={end.isPending}>
            {root('common.cancel')}
          </Button>
          <Button loading={end.isPending} type="submit" disabled={end.isPending || reason.trim() === ''}>
            {t('end')}
          </Button>
        </>
      }
    >
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('endMonth')}</span>
        <DateInput kind="month" className="mt-1 w-full" value={month} onChange={setMonth} />
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('endReason')}</span>
        <Input className="mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('endReasonPlaceholder')} />
      </label>
      {end.error && <ErrorText>{errorMessage(end.error)}</ErrorText>}
    </FormPanel>
  );
}

export function FixedAssetsPage() {
  const t = useTranslations('fixedAssets');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  // The register of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const assets = useQuery({ ...orpc.fixedAssets.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const org = useQuery(orpc.org.get.queryOptions());
  const [adding, setAdding] = useState(false);
  const [depreciating, setDepreciating] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const canEnter = canEnterVoucher(org.data?.role);
  const rows = assets.data ?? [];
  const endingAsset = rows.find((a) => a.id === ending) ?? null;

  const exportXlsx = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/fixed-assets.xlsx?${exportQuery({}, entity.legalEntityId)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('exportFile', { org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEnter && (
              <Button size="lg" variant="outline" onClick={() => setAdding(true)}>
                {t('new')}
              </Button>
            )}
            {canEnter && (
              <Button size="lg" variant="outline" onClick={() => setDepreciating(true)} disabled={rows.length === 0} title={rows.length === 0 ? t('needsAsset') : undefined}>
                {t('depreciate')}
              </Button>
            )}
            <Button loading={exportXlsx.isPending} size="lg" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || rows.length === 0} title={rows.length === 0 ? t('needsAsset') : undefined}>
              {t('export')}
            </Button>
          </div>
        }
      />
      {exportXlsx.error && <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>}
      {adding && <AssetFormPanel onClose={() => setAdding(false)} />}
      {depreciating && <DepreciationPanel slug={slug} onClose={() => setDepreciating(false)} />}
      {endingAsset && <EndPanel key={endingAsset.id} asset={endingAsset} onClose={() => setEnding(null)} />}
      {assets.isPending ? (
        <TableSkeleton columns={5} />
      ) : assets.error ? (
        <ErrorText>{errorMessage(assets.error)}</ErrorText>
      ) : rows.length === 0 ? (
        // The two disabled buttons above wait for a first asset (#3602): the empty state says so and offers it.
        <Empty
          title={t('empty')}
          hint={t('emptyHint')}
          action={
            canEnter ? (
              <Button variant="outline" onClick={() => setAdding(true)}>
                {t('new')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable head={[t('columns.name'), t('columns.accounts'), t('columns.schedule'), t('columns.cost'), t('columns.posted'), t('columns.remaining')]} numeric={[3, 4, 5]}>
          {rows.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="px-4 py-3 text-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  {a.name}
                  <Badge variant="outline">{t(`kinds.${a.kind}`)}</Badge>
                  {a.ended && <Badge variant="secondary">{t('ended', { month: monthLabel(a.ended.month) })}</Badge>}
                </div>
                {a.ended && <div className="mt-1 text-xs text-subtle-foreground">{a.ended.reason}</div>}
                {canEnter && !a.ended && (
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEnding(a.id)}>
                    {t('end')}
                  </Button>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {[a.assetAccount, a.accumulatedAccount, a.expenseAccount].filter(Boolean).join(' · ')}
              </TableCell>
              <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                {t('schedule', { start: monthLabel(a.startMonth), last: monthLabel(a.lastMonth), months: String(a.months) })}
                <div>{a.lastPostedMonth ? t('postedThrough', { month: monthLabel(a.lastPostedMonth), count: String(a.postedMonths) }) : t('notPosted')}</div>
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(a.cost)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.money(a.posted)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(a.remaining)}</TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
