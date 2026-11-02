// SPDX-License-Identifier: AGPL-3.0-only
// The deal board (#2226, docs/plan/crm.md step K2): a column per pipeline stage, a card per deal. A member drags a card
// to another column or another place in its column (native drag events, as the Social board); every card also has a
// stage menu, so the board works with a keyboard and on a phone, where the columns scroll sideways. A move is a command:
// the card moves at once and goes back, with the reason, when the server refuses (a stale version, a removed stage).
// Dropping on a lost stage asks for an optional reason first. Won and Lost show the deals closed in the last 30 days.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { BOARD_CLOSED_DAYS, DEAL_LOST_REASON_MAX, type Board, type BoardColumn, type Deal, type FilterAst } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { DealForm, refreshDeals, type Member } from './deal-form.tsx';
import { Empty, ErrorText, Field } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { moveCard, type Drop } from '../lib/deal-board.ts';
import { formatMoney } from '../lib/format.ts';

interface MoveInput {
  dealId: string;
  version: number;
  stageId: string;
  beforeDealId?: string | null | undefined;
  lostReason?: string | null | undefined;
}

function Card({
  deal,
  columns,
  canEdit,
  onDragStart,
  onDragEnd,
  onDragOver,
  onMove,
  onEdit,
  dragging,
  dropBefore,
}: {
  deal: Deal;
  columns: readonly BoardColumn[];
  canEdit: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onMove: (stageId: string) => void;
  onEdit: () => void;
  dragging: boolean;
  dropBefore: boolean;
}) {
  const t = useTranslations('deals');
  const { locale } = useLocaleSetting();
  const overdue = deal.stageKind === 'open' && deal.expectedClose !== null && deal.expectedClose < new Date().toISOString().slice(0, 10);
  return (
    <li
      data-testid="deal-card"
      data-deal-id={deal.id}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className={`rounded-lg border border-border bg-card p-3 text-sm ${dragging ? 'opacity-40' : ''} ${dropBefore ? 'border-t-2 border-t-primary' : ''}`}
    >
      <p className="font-medium text-foreground">{deal.title}</p>
      <p className="text-xs text-muted-foreground">{deal.partyName}</p>
      <p className="mt-1 tabular-nums">{formatMoney(deal.amount, locale, deal.currency)}</p>
      {deal.expectedClose && <p className={`text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}>{t('board.closeOn', { date: deal.expectedClose })}</p>}
      {deal.lostReason && <p className="text-xs text-muted-foreground">{t('lostReason', { reason: deal.lostReason })}</p>}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <NativeSelect size="sm" aria-label={t('stageOf', { title: deal.title })} value={deal.stageId} onChange={(e) => onMove(e.target.value)}>
            {columns.map((c) => (
              <option key={c.stage.id} value={c.stage.id}>
                {c.stage.name}
              </option>
            ))}
          </NativeSelect>
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            {t('edit')}
          </Button>
        </div>
      )}
    </li>
  );
}

// How close to an edge of the board a drag starts to scroll it, and how far each dragover scrolls.
const EDGE = 80;
const SCROLL_STEP = 24;

export function DealBoard({ members, canEdit, filters }: { members: readonly Member[]; canEdit: boolean; filters?: FilterAst | undefined }) {
  const t = useTranslations('deals');
  const { locale } = useLocaleSetting();
  // A saved view's filter (K3): the board shows the deals the list shows for it, and its cache entry is the view's own.
  const boardInput = filters ? { filters } : {};
  const boardKey = orpc.crm.deals.board.queryKey({ input: boardInput });
  const board = useQuery(orpc.crm.deals.board.queryOptions({ input: boardInput }));
  const [dragging, setDragging] = useState<Deal | null>(null);
  const [over, setOver] = useState<Drop | null>(null);
  const [editing, setEditing] = useState<Deal | null>(null);
  // A move into a lost stage waits for its reason.
  const [losing, setLosing] = useState<{ deal: Deal; drop: Drop } | null>(null);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  // Near either edge of the board the columns scroll by themselves, so a card can be dragged to a column out of sight. The
  // snap points are off while dragging, or they would pull the scroll back.
  const scroller = useRef<HTMLDivElement>(null);
  const scrollNearEdge = (clientX: number) => {
    const el = scroller.current;
    if (!el || !dragging) return;
    const box = el.getBoundingClientRect();
    if (clientX > box.right - EDGE) el.scrollLeft += SCROLL_STEP;
    else if (clientX < box.left + EDGE) el.scrollLeft -= SCROLL_STEP;
  };
  const move = useMutation(
    orpc.crm.deals.move.mutationOptions({
      onMutate: async (input: MoveInput) => {
        await queryClient.cancelQueries({ queryKey: boardKey });
        const previous = queryClient.getQueryData<Board>(boardKey);
        const deal = previous?.columns.flatMap((c) => c.cards).find((c) => c.id === input.dealId);
        if (previous && deal) queryClient.setQueryData<Board>(boardKey, moveCard(previous, deal, { stageId: input.stageId, beforeDealId: input.beforeDealId ?? null }));
        setFailure(null);
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous) queryClient.setQueryData(boardKey, context.previous);
        setFailure(error);
      },
      onSettled: refreshDeals,
    }),
  );

  const columns = board.data?.columns ?? [];
  const send = (deal: Deal, drop: Drop, lostReason?: string | null) => {
    const input: MoveInput = { dealId: deal.id, version: deal.version, stageId: drop.stageId, ...(drop.beforeDealId ? { beforeDealId: drop.beforeDealId } : {}), ...(lostReason ? { lostReason } : {}) };
    move.mutate(input);
  };
  const place = (deal: Deal, drop: Drop) => {
    const column = columns.find((c) => c.stage.id === drop.stageId);
    if (!column || drop.beforeDealId === deal.id) return;
    // Dropped where it already is: nothing to send.
    const cards = column.cards.filter((c) => c.id !== deal.id);
    const index = drop.beforeDealId ? cards.findIndex((c) => c.id === drop.beforeDealId) : cards.length;
    const current = column.cards.findIndex((c) => c.id === deal.id);
    if (deal.stageId === drop.stageId && current === index) return;
    if (column.stage.kind === 'lost' && deal.stageId !== column.stage.id) {
      setLosing({ deal, drop });
      return;
    }
    send(deal, drop);
  };
  const onDragOverCard = (e: DragEvent<HTMLElement>, stageId: string, cards: readonly Deal[], card: Deal) => {
    e.preventDefault();
    e.stopPropagation();
    scrollNearEdge(e.clientX);
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    const next = after ? cards[cards.findIndex((c) => c.id === card.id) + 1] : card;
    setOver({ stageId, beforeDealId: next?.id ?? null });
  };

  if (board.error) return <ErrorText>{errorMessage(board.error)}</ErrorText>;
  if (board.isPending) return <p className="text-sm text-muted-foreground">{t('board.loading')}</p>;
  if (columns.length === 0) return <Empty title={t('empty')} hint={canEdit ? t('emptyHint') : undefined} />;

  return (
    <div className="space-y-3">
      {editing && <DealForm key={editing.version} deal={editing} members={members} onDone={() => setEditing(null)} />}
      {losing && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(losing.deal, losing.drop, reason.trim() || null);
            setLosing(null);
            setReason('');
          }}
        >
          <Field label={t('board.lostFor', { title: losing.deal.title })} className="min-w-64">
            {(c) => <Input {...c} autoFocus maxLength={DEAL_LOST_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Button type="submit" size="sm">
            {t('markLost')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setLosing(null);
              setReason('');
            }}
          >
            {t('form.cancel')}
          </Button>
        </form>
      )}
      {failure !== null && <ErrorText>{errorMessage(failure)}</ErrorText>}
      <div ref={scroller} className={`flex gap-3 overflow-x-auto pb-3 ${dragging ? '' : 'snap-x'}`} data-testid="deal-board" onDragOver={(e) => scrollNearEdge(e.clientX)}>
        {columns.map((column) => (
          <section
            key={column.stage.id}
            aria-label={column.stage.name}
            data-testid="deal-column"
            data-stage-id={column.stage.id}
            className={`w-72 shrink-0 snap-start rounded-lg bg-muted/40 p-2 ${over?.stageId === column.stage.id && over.beforeDealId === null ? 'ring-2 ring-primary/50' : ''}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver({ stageId: column.stage.id, beforeDealId: null });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const target = over;
              const deal = dragging;
              setDragging(null);
              setOver(null);
              if (deal && target) place(deal, target.stageId === column.stage.id ? target : { stageId: column.stage.id, beforeDealId: null });
            }}
          >
            <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
              <h3 className="text-sm font-semibold text-foreground">{column.stage.name}</h3>
              <Badge variant="outline">{column.count}</Badge>
            </header>
            <p className="mb-2 px-1 text-xs tabular-nums text-muted-foreground">{formatMoney(column.total, locale)}</p>
            {column.stage.kind !== 'open' && <p className="mb-2 px-1 text-xs text-muted-foreground">{t('board.lastDays', { days: String(BOARD_CLOSED_DAYS) })}</p>}
            <ul className="space-y-2" aria-label={column.stage.name}>
              {column.cards.map((deal) => (
                <Card
                  key={deal.id}
                  deal={deal}
                  columns={columns}
                  canEdit={canEdit}
                  dragging={dragging?.id === deal.id}
                  dropBefore={over?.stageId === column.stage.id && over.beforeDealId === deal.id && dragging?.id !== deal.id}
                  onDragStart={() => setDragging(deal)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => (dragging ? onDragOverCard(e, column.stage.id, column.cards, deal) : undefined)}
                  onMove={(stageId) => place(deal, { stageId, beforeDealId: null })}
                  onEdit={() => setEditing(deal)}
                />
              ))}
            </ul>
            {column.truncated && <p className="mt-2 px-1 text-xs text-muted-foreground">{t('board.truncated')}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
