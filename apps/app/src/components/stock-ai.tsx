// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on the Hàng hóa screen (#2514): which item an unassigned invoice line is about, and the items running low with a reorder message to the supplier. The screen works
// the same with AI off: the low-stock list and the template message need no model, and a suggestion only fills in the item a person then confirms by assigning the line (which also
// teaches the name). Nothing here assigns a line, orders anything or sends a mail: the message is a draft to read, edit, copy or open in the person's own mail.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { STOCK_REORDER_HINT_MAX, STOCK_REORDER_ITEMS_MAX, STOCK_SUGGEST_LINES_MAX, type StockAiState, type StockItem, type StockLowItem, type StockUnassignedLine } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, ErrorText } from './ui.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

export const lineKey = (line: { documentId: string; lineNo: number }) => `${line.documentId}:${line.lineNo}`;

export interface Suggestion {
  itemId: string;
  reason: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Suggested items for the unassigned lines
// ---------------------------------------------------------------------------------------------------------------------

/** The coworker's suggestions for the unassigned lines, asked ten lines of one entity at a time and only when a person clicks (each ask is a paid model call). A line it was asked
 * about and gave nothing for is remembered as asked; an ask that came back busy, over budget or failed leaves its lines to be asked again. */
export function useLineSuggestions(lines: readonly StockUnassignedLine[]) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const [found, setFound] = useState<ReadonlyMap<string, Suggestion>>(new Map());
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<'usedNone' | 'usedSome' | Exclude<StockAiState, 'used'> | null>(null);
  const todo = lines.filter((l) => !asked.has(lineKey(l)));
  const first = todo[0];
  const next = first ? todo.filter((l) => l.legalEntityId === first.legalEntityId).slice(0, STOCK_SUGGEST_LINES_MAX) : [];
  // The lines asked about travel with the call, so what is marked as asked is exactly what was sent.
  const ask = useMutation({
    mutationFn: (asking: readonly StockUnassignedLine[]) =>
      client.stock.suggest({ legalEntityId: asking[0]?.legalEntityId as string, lines: asking.map((l) => ({ documentId: l.documentId, lineNo: l.lineNo })), lang }),
    onSuccess: (answer, asking) => {
      if (answer.ai !== 'used') {
        setState(answer.ai);
        return;
      }
      setAsked((was) => new Set([...was, ...asking.map(lineKey)]));
      setFound((was) => new Map([...was, ...answer.suggestions.map((s): [string, Suggestion] => [lineKey(s), { itemId: s.itemId, reason: s.reason }])]));
      setState(answer.suggestions.length > 0 ? 'usedSome' : 'usedNone');
    },
  });
  return { found, asked, state, pending: ask.isPending, error: ask.error, send: () => ask.mutate(next), canAsk: next.length > 0, remaining: todo.length };
}

export function SuggestBar({ suggestions }: { suggestions: ReturnType<typeof useLineSuggestions> }) {
  const t = useTranslations('stock.suggest');
  const { pending, error, send, state, canAsk, remaining } = suggestions;
  return (
    <div className="mb-3 space-y-1" data-testid="stock-suggest-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" loading={pending} disabled={!canAsk || pending} onClick={send} data-testid="stock-suggest">
          {t('button')}
        </Button>
        {remaining > 0 && <span className="text-xs text-subtle-foreground">{t('remaining', { count: remaining })}</span>}
      </div>
      {state && (
        <p className="text-xs text-subtle-foreground" role="status" data-testid="stock-suggest-state">
          {t(`state.${state}`)}
        </p>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

/** The suggestion under a line: the item and the coworker's reason, as an AI proposal nobody approved (a dashed outline and the proposal badge). It only fills in the item picker. */
export function SuggestionChip({ suggestion, asked, items, onUse }: { suggestion: Suggestion | undefined; asked: boolean; items: readonly StockItem[]; onUse: () => void }) {
  const t = useTranslations('stock.suggest');
  if (!suggestion) return asked ? <p className="mb-2 text-xs text-subtle-foreground">{t('none')}</p> : null;
  const item = items.find((i) => i.id === suggestion.itemId && i.active);
  if (!item) return null;
  return (
    <div className="mb-2 space-y-1 rounded-lg border border-dashed border-proposal/60 p-2" data-testid="stock-suggestion">
      <Badge variant="proposal">{t('badge')}</Badge>
      <p className="text-sm text-foreground">
        {item.code} {item.name}
      </p>
      <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
      <Button type="button" size="sm" variant="outline" onClick={onUse} data-testid="stock-suggestion-use">
        {t('use')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Items running low, and the reorder message
// ---------------------------------------------------------------------------------------------------------------------

// A quantity the server takes: digits with up to six decimals, and not zero.
const QUANTITY = /^(?=.*[1-9])[0-9]{1,14}(\.[0-9]{1,6})?$/;

interface Group {
  key: string;
  legalEntityId: string;
  supplier: StockLowItem['supplier'];
  items: StockLowItem[];
}

// One group per entity and supplier: a message is for one supplier and one entity's books. A supplier with more items than one message may name (STOCK_REORDER_ITEMS_MAX) gets
// a group for each batch, so every group can be drafted.
function groupsOf(items: readonly StockLowItem[]): Group[] {
  const byParty = new Map<string, StockLowItem[]>();
  for (const item of items) {
    const key = `${item.legalEntityId}:${item.supplier?.partyId ?? ''}`;
    const bucket = byParty.get(key);
    if (bucket) bucket.push(item);
    else byParty.set(key, [item]);
  }
  const groups: Group[] = [];
  for (const [party, bucket] of byParty) {
    for (let from = 0; from < bucket.length; from += STOCK_REORDER_ITEMS_MAX) {
      const first = bucket[from] as StockLowItem;
      groups.push({ key: `${party}:${from}`, legalEntityId: first.legalEntityId, supplier: first.supplier, items: bucket.slice(from, from + STOCK_REORDER_ITEMS_MAX) });
    }
  }
  return groups;
}

function ReorderGroup({ group, canWrite }: { group: Group; canWrite: boolean }) {
  const t = useTranslations('stock.low');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const id = `reorder-${group.key}`;
  // What the person typed per item; an item they have not touched is asked for at the quantity the list suggests.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const quantityOf = (i: StockLowItem) => (typed[i.itemId] ?? i.suggestedQuantity).trim();
  const [hint, setHint] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<StockAiState | null>(null);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const valid = group.items.every((i) => QUANTITY.test(quantityOf(i)));
  const draft = useMutation({
    mutationFn: () =>
      client.stock.reorderDraft({
        legalEntityId: group.legalEntityId,
        ...(group.supplier ? { supplierPartyId: group.supplier.partyId } : {}),
        items: group.items.map((i) => ({ itemId: i.itemId, quantity: quantityOf(i) })),
        ...(hint.trim() ? { hint: hint.trim() } : {}),
        lang,
      }),
    onSuccess: (answer) => {
      setText(answer.text);
      setState(answer.ai);
      setCopied(false);
    },
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '');
      setCopied(true);
    } catch {
      // No clipboard (a plain-HTTP page, or refused): the message is selected for a manual copy.
      textRef.current?.focus();
      textRef.current?.select();
      setCopied(false);
    }
  };
  const email = group.supplier?.email ?? null;
  const asProposal = state === 'used';
  return (
    <Card className="mb-4 block p-4" aria-label={group.supplier?.name ?? t('noSupplier')} data-testid="stock-low-group">
      <div className="mb-2">
        <h3 className="text-sm font-medium text-foreground">{group.supplier?.name ?? t('noSupplier')}</h3>
        {group.supplier ? <p className="text-xs text-subtle-foreground">{email ?? t('noEmail')}</p> : <p className="text-xs text-subtle-foreground">{t('noSupplierHint')}</p>}
      </div>
      <DataTable head={[t('code'), t('name'), t('onHand'), t('cover'), t('daily'), t('orderQuantity')]} numeric={[2, 3, 4]}>
        {group.items.map((i) => (
          <TableRow key={i.itemId} data-testid="stock-low-item">
            <TableCell className="px-4 py-3">{i.code}</TableCell>
            <TableCell className="px-4 py-3">{i.name}</TableCell>
            <TableCell className={NUM}>
              {i.onHand} {i.unit}
            </TableCell>
            <TableCell className={NUM}>{t('coverDays', { count: i.coverDays })}</TableCell>
            <TableCell className={NUM}>{i.dailyOut}</TableCell>
            <TableCell className="px-4 py-3 text-right">
              <Label htmlFor={`${id}-${i.itemId}`} className="sr-only">
                {t('orderQuantityOf', { name: i.name })}
              </Label>
              <Input
                id={`${id}-${i.itemId}`}
                className="ml-auto w-24 text-right"
                value={typed[i.itemId] ?? i.suggestedQuantity}
                inputMode="decimal"
                // Locked while a draft is being written, so the message that comes back is always the one for the quantities on screen.
                disabled={!canWrite || draft.isPending}
                aria-invalid={!QUANTITY.test(quantityOf(i))}
                onChange={(e) => {
                  setTyped((was) => ({ ...was, [i.itemId]: e.target.value }));
                  setText(null);
                  setState(null);
                }}
                data-testid="stock-low-quantity"
              />
              <span className="ml-1 text-xs text-subtle-foreground">{i.unit}</span>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
      {canWrite && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor={`${id}-hint`} className="text-xs text-subtle-foreground">
                {t('hint')}
              </Label>
              <Input id={`${id}-hint`} value={hint} maxLength={STOCK_REORDER_HINT_MAX} placeholder={t('hintExample')} disabled={draft.isPending} onChange={(e) => setHint(e.target.value)} />
            </div>
            <Button loading={draft.isPending} disabled={!valid || draft.isPending} onClick={() => draft.mutate()} data-testid="stock-low-draft">
              {t('draft')}
            </Button>
          </div>
          {!valid && <p className="text-xs text-destructive">{t('quantityInvalid')}</p>}
          {draft.error && <ErrorText>{errorMessage(draft.error)}</ErrorText>}
          {text !== null && (
            // What the model wrote is an AI proposal nobody approved (DESIGN.md §3.1): the proposal badge and a dashed outline. The fixed template is the books' own words.
            <div className={asProposal ? 'space-y-2 rounded-lg border border-dashed border-proposal/60 p-3' : 'space-y-2 rounded-lg border border-border p-3'} data-testid="stock-low-message">
              {asProposal && <Badge variant="proposal">{t('badge')}</Badge>}
              {state && (
                <p className="text-xs text-muted-foreground" role="status" data-testid="stock-low-state">
                  {t(`state.${state}`)}
                </p>
              )}
              <Textarea ref={textRef} rows={9} maxLength={4000} aria-label={t('messageLabel')} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void copy()} data-testid="stock-low-copy">
                  {copied ? t('copied') : t('copy')}
                </Button>
                {email && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      window.location.href = `mailto:${email}?subject=${encodeURIComponent(t('mailSubject'))}&body=${encodeURIComponent(text)}`;
                    }}
                  >
                    {t('openMail')}
                  </Button>
                )}
                <p className="text-xs text-subtle-foreground">{t('sendYourself')}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function LowStock({ legalEntityId, ready, canWrite }: { legalEntityId: string | undefined; ready: boolean; canWrite: boolean }) {
  const t = useTranslations('stock.low');
  const low = useQuery({ ...orpc.stock.low.queryOptions({ input: { legalEntityId } }), enabled: ready });
  if (low.error) return <ErrorText>{errorMessage(low.error)}</ErrorText>;
  const items = low.data ?? [];
  if (items.length === 0) return null;
  return (
    <section className="mb-8" aria-label={t('title')} data-testid="stock-low">
      <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
      <p className="mb-3 text-sm text-subtle-foreground">{t('subtitle')}</p>
      {groupsOf(items).map((group) => (
        <ReorderGroup key={group.key} group={group} canWrite={canWrite} />
      ))}
    </section>
  );
}
