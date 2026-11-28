// SPDX-License-Identifier: AGPL-3.0-only
// The card "Chế độ kế toán" in Settings > Kế toán (issue #1403, slice B2): which regime an entity's books follow (Circular 133 or Circular 99), why a switch is not offered when it is not, and the two actions the kernel
// keeps for it (finance.books.set_regime: an owner, R3 fresh second factor, after saying the tax authority was told; finance.books.cancel_regime: an owner or an admin, R3, while no entry falls under the choice).
// Every member reads it. The kernel decides every rule again; this offers what can succeed and shows its reason otherwise. No model text: a switch of books is a legal act decided by a person.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { useTranslations } from 'use-intl';
import type { BooksRegimeEntity } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { blockerWording, booksRegimeActions, waitingProposalIds } from '../lib/books-regime.ts';

// What a person can do on one entity: a form with its own confirm button opens under the entity, then the step-up prompt when the kernel asks for a fresh second factor.
type Mode = 'choose' | 'takeBack';

// The form of a choice: what the switch means, the one checkbox that says the tax authority was told, and a confirm button that stays off until it is ticked (the kernel refuses without it).
// The step-up prompt and the server's reason are its children.
export function ChooseForm({
  formRef,
  date,
  notified,
  pending,
  onNotified,
  onConfirm,
  onClose,
  children,
}: {
  formRef?: Ref<HTMLDivElement>;
  date: string;
  notified: boolean;
  pending: boolean;
  onNotified: (on: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations('booksRegime');
  return (
    <div ref={formRef} className="mt-3 space-y-3 rounded-lg border border-border p-3" role="group" aria-label={t('chooseTitle', { date })}>
      <p className="text-sm font-medium text-foreground">{t('chooseTitle', { date })}</p>
      <p className="text-sm text-muted-foreground">{t('chooseWarning')}</p>
      <label className="flex min-h-6 items-start gap-2 text-sm max-md:min-h-11 pointer-coarse:min-h-11">
        <Checkbox className="mt-0.5" checked={notified} disabled={pending} onCheckedChange={(on) => onNotified(on === true)} />
        <span className="text-foreground">{t('ack')}</span>
      </label>
      <p className="text-xs text-subtle-foreground">{t('ackHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!notified || pending} className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={onConfirm}>
          {t('confirmChoose', { date })}
        </Button>
        <Button type="button" variant="ghost" className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
      {children}
    </div>
  );
}

function EntityBooks({ entity, role, named }: { entity: BooksRegimeEntity; role: string | null | undefined; named: boolean }) {
  const t = useTranslations('booksRegime');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const actions = booksRegimeActions(role, entity);
  const [mode, setMode] = useState<Mode | null>(null);
  const [notified, setNotified] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // One key per action: a retry after the step-up is the same request; a new one follows each success.
  const [setKey, setSetKey] = useState(() => crypto.randomUUID());
  const [cancelKey, setCancelKey] = useState(() => crypto.randomUUID());
  const opener = useRef<HTMLElement | null>(null);
  const form = useRef<HTMLDivElement>(null);

  // The books change what every screen that posts or reads postings shows, so every query is refreshed.
  const set = useMutation(
    orpc.booksRegime.set.mutationOptions({
      onSuccess: (result) => {
        setSetKey(crypto.randomUUID());
        setMode(null);
        setNotified(false);
        setDone(t('doneChoose', { date: f.date(result.effectiveFrom) }));
        void queryClient.invalidateQueries();
      },
      // A refusal can mean the state moved since it was read (a date no longer valid, a choice locked meanwhile): read it again.
      onError: () => void queryClient.invalidateQueries({ queryKey: orpc.booksRegime.state.key() }),
    }),
  );
  const cancel = useMutation(
    orpc.booksRegime.cancel.mutationOptions({
      onSuccess: () => {
        setCancelKey(crypto.randomUUID());
        setMode(null);
        setDone(t('doneTakeBack'));
        void queryClient.invalidateQueries();
      },
      onError: () => void queryClient.invalidateQueries({ queryKey: orpc.booksRegime.state.key() }),
    }),
  );

  // The focus moves into the form when it opens: onto the checkbox of a choice, onto "Đóng" of a take back (never onto the button that changes the books, so Enter right away does nothing).
  // The buttons that open a form stay on the page, so Close gives the focus back to the one that opened it.
  useEffect(() => {
    if (mode) form.current?.querySelector<HTMLElement>('[role="checkbox"], [data-initial-focus]')?.focus();
  }, [mode]);
  const open = (next: Mode, button: HTMLElement) => {
    opener.current = button;
    setDone(null);
    set.reset();
    cancel.reset();
    setMode(next);
  };
  const close = () => {
    setMode(null);
    setNotified(false);
    set.reset();
    cancel.reset();
    opener.current?.focus();
  };

  const offered = entity.nextSwitchDate;
  const scheduled = entity.scheduled;
  const waiting = waitingProposalIds(entity.blockers);
  const stepUpSet = isStepUpRequired(set.error);
  const stepUpCancel = isStepUpRequired(cancel.error);

  return (
    <section aria-label={entity.name} className="pt-4 first:pt-0" data-testid="books-regime-entity" data-regime={entity.regime}>
      {named && <h3 className="text-sm font-semibold text-foreground">{entity.name}</h3>}
      <p className="text-sm text-foreground">{entity.regime === 'tt99' ? t('current99', { date: f.date(entity.since) }) : t('current133')}</p>
      {scheduled && <p className="mt-1 text-sm text-muted-foreground">{t(scheduled.cancellable ? 'scheduledOpen' : 'scheduledLocked', { date: f.date(scheduled.effectiveFrom) })}</p>}
      {offered && !scheduled && <p className="mt-1 text-sm text-muted-foreground">{t('offered', { date: f.date(offered) })}</p>}
      {entity.blockers.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-foreground">{offered && !scheduled ? t('blockersTitle') : t('notOffered')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {entity.blockers.map((blocker) => {
              const wording = blockerWording(blocker);
              return (
                <li key={blocker.code} data-testid={`books-blocker-${blocker.code}`}>
                  {t(`blockers.${wording.key}`, { date: f.date(wording.date), count: wording.count })}
                </li>
              );
            })}
          </ul>
          {waiting.length > 0 && slug && (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {waiting.map((id, i) => (
                <li key={id}>
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id }} className="inline-flex min-h-6 items-center text-link hover:underline max-md:min-h-11 pointer-coarse:min-h-11">
                    {t('openProposal', { n: String(i + 1) })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Only where a choice could be made: not once Circular 99 is in force or chosen. */}
      {role !== 'owner' && entity.regime === 'tt133' && !scheduled && <p className="mt-2 text-xs text-subtle-foreground">{t('ownerOnly')}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {actions.canChoose && offered && (
          <Button type="button" variant="outline" aria-expanded={mode === 'choose'} className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={(e) => open('choose', e.currentTarget)}>
            {t('choose', { date: f.date(offered) })}
          </Button>
        )}
        {actions.canTakeBack && scheduled && (
          <Button type="button" variant="ghost" aria-expanded={mode === 'takeBack'} className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={(e) => open('takeBack', e.currentTarget)}>
            {t('takeBack', { date: f.date(scheduled.effectiveFrom) })}
          </Button>
        )}
      </div>

      {mode === 'choose' && offered && (
        <ChooseForm
          formRef={form}
          date={f.date(offered)}
          notified={notified}
          pending={set.isPending}
          onNotified={setNotified}
          onConfirm={() => set.mutate({ legalEntityId: entity.legalEntityId, effectiveFrom: offered, taxAuthorityNotified: true, idempotencyKey: setKey })}
          onClose={close}>
          {stepUpSet && (
            <StepUpPrompt action={t('stepUpChoose', { date: f.date(offered) })} onVerified={() => set.variables && set.mutate(set.variables)} onCancel={() => set.reset()} />
          )}
          {set.error && !stepUpSet && <ErrorText>{errorMessage(set.error)}</ErrorText>}
        </ChooseForm>
      )}

      {mode === 'takeBack' && scheduled && (
        <div ref={form} className="mt-3 space-y-3 rounded-lg border border-border p-3" role="group" aria-label={t('takeBack', { date: f.date(scheduled.effectiveFrom) })}>
          <p className="text-sm font-medium text-foreground">{t('takeBack', { date: f.date(scheduled.effectiveFrom) })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={cancel.isPending}
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              onClick={() => cancel.mutate({ legalEntityId: entity.legalEntityId, effectiveFrom: scheduled.effectiveFrom, idempotencyKey: cancelKey })}>
              {t('confirmTakeBack')}
            </Button>
            <Button type="button" variant="ghost" data-initial-focus className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={close}>
              {t('cancel')}
            </Button>
          </div>
          {stepUpCancel && (
            <StepUpPrompt
              action={t('stepUpTakeBack', { date: f.date(scheduled.effectiveFrom) })}
              onVerified={() => cancel.variables && cancel.mutate(cancel.variables)}
              onCancel={() => cancel.reset()}
            />
          )}
          {cancel.error && !stepUpCancel && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
        </div>
      )}

      {/* Always on the page, so a screen reader announces the text when it is filled in. */}
      <p className={done ? 'mt-3 text-sm text-foreground' : 'sr-only'} role="status" data-testid="books-regime-done">
        {done}
      </p>
    </section>
  );
}

// The card: one block per entity, with the entity's name only when there are several (one person, the defaults, nothing to set up).
export function BooksRegimeCard({ role }: { role: string | null | undefined }) {
  const t = useTranslations('booksRegime');
  const state = useQuery(orpc.booksRegime.state.queryOptions());
  const entities = state.data?.entities ?? [];
  return (
    <Card className="block p-4" data-testid="books-regime-card">
      <h2 className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
      {state.error && <ErrorText>{errorMessage(state.error)}</ErrorText>}
      {!state.data && !state.error && <RowsSkeleton rows={2} />}
      {entities.length > 0 && (
        <div className="mt-4 space-y-4 divide-y divide-border">
          {entities.map((entity) => (
            <EntityBooks key={entity.legalEntityId} entity={entity} role={role} named={entities.length > 1} />
          ))}
        </div>
      )}
    </Card>
  );
}
