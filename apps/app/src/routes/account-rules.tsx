// Learned account rules in Settings (issue #1399, #1452): what purchase and sales approvals taught (a vendor's or
// customer's item and the account it was approved to) and the keyword rules owners and admins added, each with its
// provenance. Owners and admins remove any rule and add purchase or sales keyword rules; every role reads them. The
// server enforces every rule; the screen only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { isRevenueAccount, type CategorizationRule, type DocumentDirection, type Party } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { DuplicateHint } from '../components/form-panel.tsx';
import { ErrorText, Field, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { ACCOUNT_RULE_EVERY_VENDOR, filterPartyChoices, filterRulesByDirection, filterRulesByVendor, ruleVendorOptions } from '../lib/account-rules.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { duplicateKeywordRule } from '../lib/duplicates.ts';
import { fold } from '../lib/palette.ts';
import { useDebounced } from '../lib/use-debounced.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.accountRules.list.key() });
const SERVER_PARTY_LIST_CAP = 500;

type SelectedVendor = Pick<Party, 'id' | 'name' | 'taxCode'>;

type VendorOption = { kind: 'all'; id: string; label: string } | { kind: 'party'; id: string; party: Party };

function VendorPicker({
  direction,
  selected,
  query,
  error,
  inputRef,
  onSelect,
  onQueryChange,
}: {
  direction: DocumentDirection;
  selected: SelectedVendor | null;
  query: string;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onSelect: (party: SelectedVendor | null) => void;
  onQueryChange: (query: string) => void;
}) {
  const t = useTranslations('accountRules');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ignoreNextFocusRef = useRef(false);
  const listId = useId();
  const copy =
    direction === 'sale'
      ? {
          label: t('customer'),
          hint: t('customerHint'),
          all: t('allCustomers'),
          clearAria: t('clearCustomerAria'),
          results: t('customerResults'),
          loading: t('customerLoading'),
          noMatch: t('customerNoMatch'),
        }
      : {
          label: t('vendor'),
          hint: t('vendorHint'),
          all: t('allVendors'),
          clearAria: t('clearVendorAria'),
          results: t('vendorResults'),
          loading: t('vendorLoading'),
          noMatch: t('vendorNoMatch'),
        };
  // All org parties (every role reads; AddKeywordRuleDialog only mounts for owners/admins). When >= 500 exist, also query server q search.
  const initialParties = useQuery(orpc.parties.list.queryOptions({ input: { all: true } }));
  const serverCapped = (initialParties.data?.length ?? 0) >= SERVER_PARTY_LIST_CAP;
  const searchText = selected ? '' : query;
  const trimmedSearch = searchText.trim().slice(0, 100);
  const debouncedSearch = useDebounced(trimmedSearch, 250);
  const searchedParties = useQuery({
    ...orpc.parties.list.queryOptions({ input: { q: debouncedSearch, all: true } }),
    enabled: serverCapped && debouncedSearch !== '',
  });
  const searchSettling = serverCapped && trimmedSearch !== '' && debouncedSearch !== trimmedSearch;
  const partySource = (() => {
    const initial = initialParties.data ?? [];
    const extra = serverCapped && debouncedSearch !== '' ? (searchedParties.data ?? []) : [];
    if (extra.length === 0) return initial;
    const seen = new Set(extra.map((p) => p.id));
    return [...extra, ...initial.filter((p) => !seen.has(p.id))];
  })();
  const partiesPending = initialParties.isPending || searchSettling || (serverCapped && debouncedSearch !== '' && searchedParties.isPending);
  const partiesError = initialParties.error ?? (serverCapped && debouncedSearch !== '' ? searchedParties.error : null);
  const matched = filterPartyChoices(partySource, searchText);
  const showEveryVendorOption = searchText.trim() === '' || fold(copy.all).includes(fold(searchText.trim()));
  const options: VendorOption[] = [
    ...(showEveryVendorOption ? [{ kind: 'all' as const, id: `${listId}-all`, label: copy.all }] : []),
    ...matched.items.map((party) => ({ kind: 'party' as const, id: `${listId}-p-${party.id}`, party })),
  ];
  const clampedActive = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const activeOption = clampedActive >= 0 ? options[clampedActive] : undefined;
  const listboxMounted = open && !partiesError && options.length > 0;

  const pickOption = (option: VendorOption) => {
    if (option.kind === 'all') onSelect(null);
    else onSelect({ id: option.party.id, name: option.party.name, taxCode: option.party.taxCode });
    onQueryChange('');
    setOpen(false);
    setActiveIndex(0);
  };

  const resetToAll = () => {
    onSelect(null);
    onQueryChange('');
    setOpen(false);
    setActiveIndex(0);
    if (document.activeElement !== inputRef.current) {
      ignoreNextFocusRef.current = true;
      inputRef.current?.focus();
      window.setTimeout(() => {
        ignoreNextFocusRef.current = false;
      }, 0);
    }
  };

  const moveActive = (delta: number) => {
    if (!open) {
      setOpen(true);
      setActiveIndex(delta > 0 ? 0 : Math.max(0, options.length - 1));
      return;
    }
    if (options.length === 0) return;
    const next = (clampedActive + delta + options.length) % options.length;
    setActiveIndex(next);
    const id = options[next]?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' && open && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (activeOption) pickOption(activeOption);
    } else if (event.key === 'Escape' && open) {
      // Stop Escape from bubbling to FormDialog while closing the suggestion listbox.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopPropagation();
      setOpen(false);
    }
  };

  const hint = selected
    ? selected.taxCode
      ? t('vendorSelectedWithTaxCode', { name: selected.name, taxCode: selected.taxCode })
      : t('vendorSelected', { name: selected.name })
    : copy.hint;

  return (
    <Field label={copy.label} hint={hint} error={error ?? undefined}>
      {(control) => (
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
          }}
        >
          <div className="flex items-center gap-1.5">
            <Input
              {...control}
              ref={inputRef}
              type="text"
              role="combobox"
              maxLength={100}
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listboxMounted ? listId : undefined}
              aria-activedescendant={listboxMounted && activeOption ? activeOption.id : undefined}
              placeholder={t('vendorPlaceholder')}
              value={selected ? selected.name : query}
              data-testid="account-rule-vendor-input"
              onFocus={() => {
                if (ignoreNextFocusRef.current) {
                  ignoreNextFocusRef.current = false;
                  return;
                }
                setOpen(true);
              }}
              onClick={() => setOpen(true)}
              onChange={(event) => {
                onSelect(null);
                onQueryChange(event.target.value);
                setOpen(true);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
            />
            {(selected !== null || query !== '') && (
              <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-label={copy.clearAria} data-testid="account-rule-vendor-clear" onClick={resetToAll}>
                {t('clearVendor')}
              </Button>
            )}
          </div>
          {open && (
            <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm">
              {partiesError ? (
                <ErrorText>{errorMessage(partiesError)}</ErrorText>
              ) : (
                <>
                  {options.length > 0 ? (
                    <ul id={listId} role="listbox" aria-label={copy.results}>
                      {options.map((option, index) => {
                        const isActive = index === clampedActive;
                        return (
                          <li
                            key={option.id}
                            id={option.id}
                            role="option"
                            aria-selected={isActive}
                            className={cn(
                              'flex cursor-pointer items-center justify-between gap-2 rounded px-2.5 py-1.5 max-md:min-h-11',
                              isActive ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
                            )}
                            onMouseEnter={() => setActiveIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pickOption(option)}
                          >
                            {option.kind === 'all' ? (
                              <span className="truncate font-medium">{option.label}</span>
                            ) : (
                              <>
                                <span className="min-w-0 truncate">{option.party.name}</span>
                                {option.party.taxCode && <span className="shrink-0 font-mono text-xs text-muted-foreground">{option.party.taxCode}</span>}
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : !partiesPending ? (
                    <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{copy.noMatch}</p>
                  ) : null}
                  {partiesPending && (
                    <p className="px-2.5 py-1.5 text-xs text-muted-foreground" role="status">
                      {copy.loading}
                    </p>
                  )}
                  {matched.total > matched.items.length && (
                    <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('vendorMoreHint', { shown: matched.items.length })}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

export function AddKeywordRuleDialog({
  rules,
  onCreated,
  onClose,
}: {
  rules: readonly CategorizationRule[];
  onCreated?: (vendorPartyId: string | null, direction: DocumentDirection) => void;
  onClose: () => void;
}) {
  const t = useTranslations('accountRules');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [direction, setDirection] = useState<DocumentDirection>('purchase');
  const [keyword, setKeyword] = useState('');
  const [selectedVendor, setSelectedVendor] = useState<SelectedVendor | null>(null);
  const [vendorQuery, setVendorQuery] = useState('');
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [accountCode, setAccountCode] = useState('');
  const vendorInputRef = useRef<HTMLInputElement>(null);
  // A keyword rule is learned for the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const create = useMutation(
    orpc.accountRules.create.mutationOptions({
      onSuccess: (_data, variables) => {
        refresh();
        onCreated?.(variables.vendorPartyId ?? null, variables.direction ?? 'purchase');
        onClose();
      },
    }),
  );
  const vendorPartyId = selectedVendor?.id ?? null;
  // The same keyword already listed for the chosen direction and scope (the list is the chosen entity's), flagged while typed.
  const repeated = duplicateKeywordRule(rules, keyword, vendorPartyId, direction);
  const incomplete = !entity.ready || !keyword.trim() || !accountCode;
  function handleDirectionChange(next: DocumentDirection) {
    setDirection(next);
    if (accountCode && isRevenueAccount(accountCode) !== (next === 'sale')) {
      setAccountCode('');
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete || repeated) return;
    if (selectedVendor === null && vendorQuery.trim() !== '') {
      if (direction === 'sale') setVendorError(t('customerPickRequired'));
      else setVendorError(t('vendorPickRequired'));
      vendorInputRef.current?.focus();
      return;
    }
    create.mutate({
      keyword: keyword.trim(),
      accountCode,
      direction,
      ...(vendorPartyId ? { vendorPartyId } : {}),
      legalEntityId: entity.legalEntityId,
    });
  }
  return (
    <FormDialog
      title={t('addTitle')}
      description={t('addHint')}
      busy={create.isPending}
      dirty={direction !== 'purchase' || keyword.trim() !== '' || accountCode !== '' || selectedVendor !== null || vendorQuery.trim() !== ''}
      submitLabel={t('add')}
      submitDisabled={incomplete || repeated !== null}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={t('ruleDirection')}>
        {(control) => (
          <NativeSelect
            {...control}
            className="max-md:min-h-11"
            data-testid="account-rule-direction-select"
            value={direction}
            onChange={(e) => handleDirectionChange(e.target.value as DocumentDirection)}
          >
            <NativeSelectOption value="purchase">{t('directionPurchase')}</NativeSelectOption>
            <NativeSelectOption value="sale">{t('directionSale')}</NativeSelectOption>
          </NativeSelect>
        )}
      </Field>
      <Field label={t('keyword')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={500}
            placeholder={direction === 'sale' ? t('keywordPlaceholderSale') : t('keywordPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        )}
      </Field>
      <VendorPicker
        direction={direction}
        selected={selectedVendor}
        query={vendorQuery}
        error={vendorError}
        inputRef={vendorInputRef}
        onSelect={(party) => {
          setSelectedVendor(party);
          setVendorError(null);
        }}
        onQueryChange={(next) => {
          setVendorQuery(next);
          setVendorError(null);
        }}
      />
      <DuplicateHint testId="keyword-rule-duplicate">
        {repeated
          ? selectedVendor
            ? t('duplicateForVendor', { keyword: repeated.matchText, vendor: selectedVendor.name, code: repeated.accountCode })
            : t('duplicate', { keyword: repeated.matchText, code: repeated.accountCode })
          : null}
      </DuplicateHint>
      <Field label={t('account')}>
        {(control) => (
          <NativeSelect {...control} required className="max-md:min-h-11" value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
            <NativeSelectOption value="">{t('pickAccount')}</NativeSelectOption>
            {/* Purchase rules allow expense/asset/inventory accounts; sales rules allow revenue accounts (#430, #1452). */}
            {pickableAccounts(accounts.data ?? [], null, direction).map((a) => (
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
  const partyLabel = rule.vendor ? rule.vendor.name : rule.direction === 'sale' ? t('allCustomers') : t('allVendors');
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-foreground">{text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
            <Badge variant={rule.direction === 'sale' ? 'secondary' : 'outline'} data-testid="rule-direction">
              {rule.direction === 'sale' ? t('directionSale') : t('directionPurchase')}
            </Badge>
            <Badge variant="secondary">{rule.matchKind === 'description' ? t('kindDescription') : t('kindKeyword')}</Badge>
            <span data-testid="rule-vendor">{partyLabel}</span>
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
  const [directionFilter, setDirectionFilter] = useState<'' | DocumentDirection>('');
  const [vendorFilter, setVendorFilter] = useState('');
  const directionFilterId = useId();
  const filterId = useId();
  const filterRef = useRef<HTMLSelectElement>(null);

  const allRules = rules.data ?? [];
  const hasPurchase = allRules.some((r) => r.direction !== 'sale');
  const hasSale = allRules.some((r) => r.direction === 'sale');
  const directionFiltered = filterRulesByDirection(allRules, directionFilter);
  const { hasEveryVendor, vendors } = ruleVendorOptions(directionFiltered);
  const validFilter =
    vendorFilter === '' ||
    (vendorFilter === ACCOUNT_RULE_EVERY_VENDOR && hasEveryVendor) ||
    vendors.some((v) => v.partyId === vendorFilter)
      ? vendorFilter
      : '';
  const filteredRules = filterRulesByVendor(directionFiltered, validFilter);

  const partyScope =
    directionFilter === 'sale' || (!hasPurchase && hasSale)
      ? { filterLabel: t('filterCustomer'), sharedLabel: t('allCustomers'), emptyText: t('filteredEmptyCustomer') }
      : directionFilter === '' && hasPurchase && hasSale
        ? { filterLabel: t('filterParty'), sharedLabel: t('allParties'), emptyText: t('filteredEmptyParty') }
        : { filterLabel: t('filterVendor'), sharedLabel: t('allVendors'), emptyText: t('filteredEmpty') };

  // Clear stale filter state when switching entities or after deleting a party's last rule so it never reactivates later.
  useEffect(() => {
    setDirectionFilter('');
    setVendorFilter('');
  }, [entity.legalEntityId]);

  useEffect(() => {
    if (!rules.isPending && validFilter !== vendorFilter) setVendorFilter(validFilter);
  }, [rules.isPending, validFilter, vendorFilter]);

  const clearFilter = () => {
    setDirectionFilter('');
    setVendorFilter('');
    filterRef.current?.focus();
  };

  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {rules.isPending ? (
        <RowsSkeleton />
      ) : rules.error ? (
        <ErrorText>{errorMessage(rules.error)}</ErrorText>
      ) : allRules.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Label htmlFor={directionFilterId} className="text-xs font-normal text-subtle-foreground">
              {t('filterDirection')}
            </Label>
            <NativeSelect
              id={directionFilterId}
              className="w-full max-md:min-h-11 sm:w-auto sm:max-w-xs"
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value as '' | DocumentDirection)}
              data-testid="account-rules-direction-filter"
            >
              <NativeSelectOption value="">{t('directionAll')}</NativeSelectOption>
              <NativeSelectOption value="purchase">{t('directionPurchase')}</NativeSelectOption>
              <NativeSelectOption value="sale">{t('directionSale')}</NativeSelectOption>
            </NativeSelect>
            <Label htmlFor={filterId} className="text-xs font-normal text-subtle-foreground">
              {partyScope.filterLabel}
            </Label>
            <NativeSelect
              ref={filterRef}
              id={filterId}
              className="w-full max-md:min-h-11 sm:w-auto sm:max-w-xs"
              value={validFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              data-testid="account-rules-vendor-filter"
            >
              <NativeSelectOption value="">{t('filterAll')}</NativeSelectOption>
              {hasEveryVendor && <NativeSelectOption value={ACCOUNT_RULE_EVERY_VENDOR}>{partyScope.sharedLabel}</NativeSelectOption>}
              {vendors.map((v) => (
                <NativeSelectOption key={v.partyId} value={v.partyId}>
                  {v.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {(validFilter !== '' || directionFilter !== '') && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilter} data-testid="account-rules-vendor-filter-clear">
                {t('clearFilter')}
              </Button>
            )}
          </div>
          {filteredRules.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{partyScope.emptyText}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {filteredRules.map((r) => (
                <RuleRow key={r.id} rule={r} canManage={canManage} />
              ))}
            </ul>
          )}
        </>
      )}
      {canManage && (
        <div className="mt-4">
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('addTitle')}
          </Button>
        </div>
      )}
      {adding && (
        <AddKeywordRuleDialog
          rules={allRules}
          onCreated={(createdVendorPartyId, createdDirection) => {
            if (directionFilter !== '' && directionFilter !== createdDirection) setDirectionFilter('');
            if (validFilter === '') return;
            const matchesCurrentFilter = validFilter === ACCOUNT_RULE_EVERY_VENDOR ? createdVendorPartyId === null : createdVendorPartyId === validFilter;
            if (!matchesCurrentFilter) setVendorFilter('');
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}
