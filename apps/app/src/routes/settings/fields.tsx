// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { PROFILE_OBLIGATIONS, type TaxProfile } from '@ludy/kernel-contract';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { StepUpPrompt } from '../../components/two-factor.tsx';
import { ErrorText, Spinner } from '../../components/ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../../lib/api.ts';

// Owner only. One idempotency key per confirmation, so a retried request never rotates twice. R3 (#113): without a
// second factor in the last 5 minutes the server answers STEP_UP_REQUIRED and the step-up prompt asks for one; the
// key is kept until a rotation succeeds, so the retry after the code can still rotate at most once.
export function RotateInboundAddress() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [confirming, setConfirming] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [rotated, setRotated] = useState<string | null>(null);
  const rotate = useMutation(
    orpc.org.rotateInbound.mutationOptions({
      onSuccess: (result) => {
        setConfirming(false);
        setRotated(result.inboundAddress);
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries();
      },
    }),
  );
  const rotateNow = () => rotate.mutate({ idempotencyKey });

  if (!confirming) {
    return (
      <div className="mt-4 space-y-2">
        {rotated && (
          <div className="rounded-lg border bg-muted p-3 text-sm" role="status">
            <p className="text-muted-foreground">{t('rotated')}</p>
            <p className="mt-1 break-all font-mono text-foreground">{rotated}</p>
          </div>
        )}
        <Button
          variant="destructive"
          onClick={() => {
            rotate.reset();
            setConfirming(true);
          }}
        >
          {t('rotate')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={t('rotateLabel')}>
      <p className="font-medium text-foreground">{t('rotateTitle')}</p>
      <p className="text-muted-foreground">{t('rotateBody')}</p>
      <p className="text-subtle-foreground">{t('rotateMfa')}</p>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={rotate.isPending} onClick={rotateNow}>
          {t('rotateConfirm')}
        </Button>
        <Button
          variant="ghost"
          disabled={rotate.isPending}
          onClick={() => {
            rotate.reset();
            setConfirming(false);
          }}
        >
          {tc('cancel')}
        </Button>
      </div>
      {rotate.error &&
        (isStepUpRequired(rotate.error) ? (
          <StepUpPrompt action={t('stepUpRotate')} onVerified={rotateNow} />
        ) : (
          <ErrorText>{errorMessage(rotate.error)}</ErrorText>
        ))}
    </div>
  );
}

// The org's own tax code (MST, issue #313): an e-invoice whose seller has it is read as a sale. Owners and admins edit
// it; everyone else sees it.
export function TaxCodeField({ taxCode, canManage }: { taxCode: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(taxCode ?? '');
  const save = useMutation(
    orpc.org.setTaxCode.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
        // The default legal entity has the org's tax code (#1278).
        await queryClient.invalidateQueries({ queryKey: orpc.legalEntities.list.key() });
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ taxCode: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('taxCode')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('taxCode')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={20} placeholder="0101234567" aria-label={t('taxCode')} className="w-48 font-mono" />
          <Button loading={save.isPending} type="submit" size="sm">
            {t('taxCodeSave')}
          </Button>
          <Button type="button" size="sm" variant="outline" 
            onClick={() => {
              setEditing(false);
              setValue(taxCode ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={taxCode ? 'font-mono text-foreground' : 'text-subtle-foreground'}>{taxCode ?? t('taxCodeUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {taxCode ? t('taxCodeChange') : t('taxCodeSet')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('taxCodeHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// How often the org files its VAT return (issue #318), for the deadline on the multi-client home screen. Owners and
// admins choose it; everyone else sees it.
export function VatFilingPeriodField({ period, canManage }: { period: 'month' | 'quarter' | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const id = useId();
  const [editing, setEditing] = useState(false);
  const save = useMutation(
    orpc.org.setVatFilingPeriod.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.me.clients.key() });
      },
    }),
  );
  const label = (value: 'month' | 'quarter' | null) => (value === 'month' ? t('vatFilingMonth') : value === 'quarter' ? t('vatFilingQuarter') : t('vatFilingUnset'));
  return (
    <div>
      <dt className="text-subtle-foreground">
        <label htmlFor={editing ? id : undefined}>{t('vatFilingPeriod')}</label>
      </dt>
      {editing ? (
        <dd className="mt-1 flex flex-wrap items-center gap-2">
          <NativeSelect
            id={id}
            size="sm"
            value={period ?? ''}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ vatFilingPeriod: e.target.value === 'month' || e.target.value === 'quarter' ? e.target.value : null })}
          >
            <NativeSelectOption value="">{t('vatFilingUnset')}</NativeSelectOption>
            <NativeSelectOption value="month">{t('vatFilingMonth')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('vatFilingQuarter')}</NativeSelectOption>
          </NativeSelect>
          {save.isPending && <Spinner />}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </dd>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={period ? 'text-foreground' : 'text-subtle-foreground'}>{label(period)}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" aria-label={`${t('edit')}: ${t('vatFilingPeriod')}`} onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('vatFilingHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The tax calendar (issue #921): which recurring obligations apply to the org besides the VAT return, its PIT
// withholding frequency and the last month of its fiscal year, for the home screen's list of what is due. Owners and
// admins choose; everyone else sees the setting.
export function TaxCalendarField({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const tt = useTranslations('taxCalendar');
  const profile = useQuery(orpc.org.taxProfile.queryOptions());
  const [draft, setDraft] = useState<TaxProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const save = useMutation(
    orpc.org.setTaxProfile.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.taxProfile.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.me.clients.key() });
      },
    }),
  );
  const pitId = useId();
  const fyId = useId();
  // The stored calendar is not shown as empty while it loads.
  if (profile.isLoading) {
    return (
      <div>
        <dt className="text-subtle-foreground">{t('taxCalendar')}</dt>
        <dd className="mt-1">
          <Spinner />
        </dd>
      </div>
    );
  }
  const stored: TaxProfile = profile.data
    ? { obligations: profile.data.obligations, pitFilingPeriod: profile.data.pitFilingPeriod, fiscalYearEndMonth: profile.data.fiscalYearEndMonth }
    : { obligations: [], pitFilingPeriod: null, fiscalYearEndMonth: 12 };
  const current = editing ? (draft ?? stored) : stored;
  const toggle = (o: TaxProfile['obligations'][number], on: boolean) =>
    setDraft({ ...current, obligations: on ? [...current.obligations, o] : current.obligations.filter((x) => x !== o) });
  const periodLabel = (value: 'month' | 'quarter' | null) => (value === 'month' ? t('vatFilingMonth') : value === 'quarter' ? t('vatFilingQuarter') : t('vatFilingUnset'));
  return (
    <div>
      <dt className="text-subtle-foreground">{t('taxCalendar')}</dt>
      {editing ? (
        <dd className="mt-1 space-y-2">
          <ul className="space-y-1">
            {PROFILE_OBLIGATIONS.map((o) => (
              <li key={o} className="flex items-center gap-2">
                <label className="flex items-center gap-2">
                  <Checkbox checked={current.obligations.includes(o)} disabled={save.isPending} onCheckedChange={(checked) => toggle(o, checked)} />
                  <span>{tt(`obligations.${o}`)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {current.obligations.includes('pit_withholding') && (
              <span className="flex items-center gap-2">
                <label htmlFor={pitId} className="text-muted-foreground">
                  {t('pitFilingPeriod')}
                </label>
                <NativeSelect
                  id={pitId}
                  size="sm"
                  value={current.pitFilingPeriod ?? ''}
                  disabled={save.isPending}
                  onChange={(e) => setDraft({ ...current, pitFilingPeriod: e.target.value === 'month' || e.target.value === 'quarter' ? e.target.value : null })}
                >
                  <NativeSelectOption value="">{t('vatFilingUnset')}</NativeSelectOption>
                  <NativeSelectOption value="month">{t('vatFilingMonth')}</NativeSelectOption>
                  <NativeSelectOption value="quarter">{t('vatFilingQuarter')}</NativeSelectOption>
                </NativeSelect>
              </span>
            )}
            <span className="flex items-center gap-2">
              <label htmlFor={fyId} className="text-muted-foreground">
                {t('fiscalYearEnd')}
              </label>
              <NativeSelect
                id={fyId}
                size="sm"
                value={String(current.fiscalYearEndMonth)}
                disabled={save.isPending}
                onChange={(e) => setDraft({ ...current, fiscalYearEndMonth: Number(e.target.value) })}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <NativeSelectOption key={m} value={String(m)}>
                    {t('fiscalYearEndMonth', { month: String(m) })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={save.isPending} size="sm" disabled={!draft} onClick={() => save.mutate(current)}>
              {t('taxCalendarSave')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setDraft(null);
                save.reset();
              }}
            >
              {tc('cancel')}
            </Button>
          </div>
        </dd>
      ) : (
        <dd className="flex flex-wrap items-start gap-2">
          <span className={stored.obligations.length > 0 ? 'text-foreground' : 'text-subtle-foreground'}>
            {stored.obligations.length > 0 ? stored.obligations.map((o) => tt(`obligations.${o}`)).join(', ') : t('taxCalendarNone')}
            {stored.obligations.includes('pit_withholding') && ` (${t('pitFilingPeriod')}: ${periodLabel(stored.pitFilingPeriod)})`}
            {` · ${t('fiscalYearEnd')} ${t('fiscalYearEndMonth', { month: String(stored.fiscalYearEndMonth) })}`}
          </span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" aria-label={`${t('edit')}: ${t('taxCalendar')}`} onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('taxCalendarHint')}</dd>
      {profile.error && <ErrorText>{errorMessage(profile.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// Approval reminders (issue #676): after how many days a pending proposal reminds the people who may approve it, and
// after how many its owners are told. Expiry (#876): after how many days a proposal still pending expires; it needs the
// owners' escalation and comes after it, so only longer choices are offered. Owners and admins choose; everyone else
// sees the setting.
const REMIND_DAYS = [1, 2, 3, 5, 7] as const;
const ESCALATE_DAYS = [2, 3, 5, 7, 14] as const;
const EXPIRE_DAYS = [7, 14, 30, 60, 90] as const;
type PolicyField = 'remindAfterDays' | 'escalateAfterDays' | 'expireAfterDays';

export function ProposalRemindersField({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const remindId = useId();
  const escalateId = useId();
  const expireId = useId();
  // Set when a change of the escalation turned expiry off with it, so the user is told.
  const [expiryTurnedOff, setExpiryTurnedOff] = useState(false);
  const [editing, setEditing] = useState(false);
  const policy = useQuery(orpc.org.proposalPolicy.queryOptions());
  const save = useMutation(
    orpc.org.setProposalPolicy.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.org.proposalPolicy.key() });
      },
    }),
  );
  const current = save.isPending && save.variables ? save.variables : (policy.data ?? { remindAfterDays: null, escalateAfterDays: null, expireAfterDays: null });
  const off = (field: PolicyField) => (field === 'expireAfterDays' ? t('expireOff') : t('reminderOff'));
  const label = (field: PolicyField, days: number | null) => (days === null ? off(field) : t('reminderDays', { days: String(days) }));
  const choose = (field: PolicyField, raw: string) => {
    const next = { ...current, [field]: raw === '' ? null : Number(raw) };
    // Expiry comes after the escalation: turning the escalation off, or past the expiry, turns expiry off with it.
    const turnsOff = next.expireAfterDays !== null && (next.escalateAfterDays === null || next.expireAfterDays <= next.escalateAfterDays);
    if (turnsOff) next.expireAfterDays = null;
    setExpiryTurnedOff(turnsOff);
    save.mutate(next);
  };
  const escalation = current.escalateAfterDays;
  const expireOptions = escalation === null ? [] : EXPIRE_DAYS.filter((d) => d > escalation);
  const select = (id: string, field: PolicyField, options: readonly number[]) => (
    <NativeSelect
      id={id}
      size="sm"
      value={current[field] === null ? '' : String(current[field])}
      disabled={save.isPending || policy.isLoading || (field === 'expireAfterDays' && escalation === null)}
      onChange={(e) => choose(field, e.target.value)}
    >
      <NativeSelectOption value="">{off(field)}</NativeSelectOption>
      {options.map((d) => (
        <NativeSelectOption key={d} value={String(d)}>
          {t('reminderDays', { days: String(d) })}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
  const fields = [
    { id: remindId, field: 'remindAfterDays', text: t('remindAfter'), options: REMIND_DAYS },
    { id: escalateId, field: 'escalateAfterDays', text: t('escalateAfter'), options: ESCALATE_DAYS },
    { id: expireId, field: 'expireAfterDays', text: t('expireAfter'), options: expireOptions },
  ] as const satisfies readonly { id: string; field: PolicyField; text: string; options: readonly number[] }[];
  return (
    <div>
      <dt className="text-subtle-foreground">{t('proposalReminders')}</dt>
      {editing ? (
        <dd className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
          {fields.map((f) => (
            <span key={f.field} className="flex items-center gap-2">
              <label htmlFor={f.id} className="text-muted-foreground">
                {f.text}
              </label>
              {select(f.id, f.field, f.options)}
            </span>
          ))}
          {save.isPending && <Spinner />}
          <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={() => setEditing(false)}>
            {t('done')}
          </Button>
        </dd>
      ) : (
        <dd className="flex flex-wrap items-start gap-2">
          <span className="space-y-0.5">
            {fields.map((f) => (
              <span key={f.field} className="block">
                <span className="text-muted-foreground">{f.text}: </span>
                <span className={current[f.field] === null ? 'text-subtle-foreground' : 'text-foreground'}>{label(f.field, current[f.field])}</span>
              </span>
            ))}
          </span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" aria-label={`${t('edit')}: ${t('proposalReminders')}`} onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('proposalRemindersHint')}</dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{t('proposalExpiryHint')}</dd>
      {expiryTurnedOff && (
        <dd className="mt-1 text-xs text-warning" role="status">
          {t('expiryTurnedOff')}
        </dd>
      )}
      {policy.error && <ErrorText>{errorMessage(policy.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The org's address as the tax registry records it (issue #324). Owners and admins edit it; everyone else sees it.
export function AddressField({ address, canManage }: { address: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(address ?? '');
  const save = useMutation(
    orpc.org.setAddress.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ address: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('address')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('address')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} aria-label={t('address')} className="min-w-64 flex-1" />
          <Button loading={save.isPending} type="submit" size="sm">
            {t('addressSave')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setValue(address ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={address ? 'text-foreground' : 'text-subtle-foreground'}>{address ?? t('addressUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {address ? t('addressChange') : t('addressSet')}
            </Button>
          )}
        </dd>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The org's contact email (issue #669): where Crove sends the requests for missing purchase invoices. Owners and admins
// edit it; everyone else sees it.
export function ContactEmailField({ email, canManage }: { email: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email ?? '');
  const save = useMutation(
    orpc.org.setContactEmail.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        // The reconciliation screen's request card reads the contact email from its own query.
        await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.org.get.key() }), queryClient.invalidateQueries({ queryKey: orpc.missingInvoices.status.key() })]);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ email: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('contactEmail')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('contactEmail')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input type="email" value={value} onChange={(e) => setValue(e.target.value)} maxLength={320} aria-label={t('contactEmail')} className="min-w-64 flex-1" />
          <Button loading={save.isPending} type="submit" size="sm">
            {t('contactEmailSave')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setValue(email ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={email ? 'break-all text-foreground' : 'text-subtle-foreground'}>{email ?? t('contactEmailUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {email ? t('contactEmailChange') : t('contactEmailSet')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('contactEmailHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}
