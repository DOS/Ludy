// SPDX-License-Identifier: AGPL-3.0-only
// The glossary an organization keeps (#4043, step 2): the settings card of an owner or admin. A term is a product name, an acronym or a piece of jargon; the kernel cleans it and keeps at
// most 60. Nobody else reads this list, so the card says in one line that it is no place for people's or customers' names, phone numbers or addresses. A term is shown as the text it is.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { GLOSSARY_TERMS_MAX, GLOSSARY_TERM_MAX, type GlossaryTermView } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.glossary.key() });
};

// Focus a control once React has drawn it: a removed control would otherwise drop the keyboard user back to the top of the page (WCAG 2.4.3).
function focusLater(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function TermRow({ term }: { term: GlossaryTermView }) {
  const t = useTranslations('glossary');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(term.term);
  const update = useMutation({
    mutationFn: () => orpc.meetings.glossary.update.call({ termId: term.id, term: text }),
    onSuccess: () => {
      setEditing(false);
      refresh();
      toast(t('saved'), 'success');
      focusLater(`gl-edit-${term.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => orpc.meetings.glossary.remove.call({ termId: term.id }),
    onSuccess: () => {
      refresh();
      toast(t('removed'), 'success');
      // The row is gone: the focus goes to the field that adds a term.
      focusLater('gl-new');
    },
  });
  return (
    <li className="py-2" data-testid="glossary-term">
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== '') update.mutate();
          }}
        >
          <label htmlFor={`gl-text-${term.id}`} className="sr-only">
            {t('termLabel')}
          </label>
          <Input id={`gl-text-${term.id}`} className="max-w-xs" value={text} maxLength={GLOSSARY_TERM_MAX * 2} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" size="sm" loading={update.isPending} disabled={text.trim() === ''}>
            {t('save')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setText(term.term);
              focusLater(`gl-edit-${term.id}`);
            }}
          >
            {t('cancel')}
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* React renders the term as text: markup typed into it is shown as typed. */}
          <p id={`gl-term-${term.id}`} className="text-sm font-medium">{term.term}</p>
          <div className="flex gap-2">
            <Button
              id={`gl-edit-${term.id}`}
              size="sm"
              variant="outline"
              aria-describedby={`gl-term-${term.id}`}
              onClick={() => {
                setEditing(true);
                focusLater(`gl-text-${term.id}`);
              }}
            >
              {t('edit')}
            </Button>
            <ConfirmDialog
              render={
                <Button size="sm" variant="outline" aria-describedby={`gl-term-${term.id}`}>
                  {t('remove')}
                </Button>
              }
              title={t('removeTitle')}
              description={t('removeDescription')}
              confirm={t('removeConfirm')}
              destructive
              onConfirm={() => remove.mutate()}
            />
          </div>
        </div>
      )}
      {update.error ? <ErrorText>{errorMessage(update.error)}</ErrorText> : null}
      {remove.error ? <ErrorText>{errorMessage(remove.error)}</ErrorText> : null}
    </li>
  );
}

function NewTerm({ count }: { count: number }) {
  const t = useTranslations('glossary');
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => orpc.meetings.glossary.add.call({ term: text }),
    onSuccess: () => {
      setText('');
      refresh();
      toast(t('added'), 'success');
      focusLater('gl-new');
    },
  });
  if (count >= GLOSSARY_TERMS_MAX) return <p className="mt-3 text-xs text-muted-foreground">{t('limit', { max: String(GLOSSARY_TERMS_MAX) })}</p>;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() !== '') add.mutate();
      }}
    >
      <div className="space-y-1">
        <label htmlFor="gl-new" className="text-xs font-medium text-muted-foreground">
          {t('termLabel')}
        </label>
        <Input id="gl-new" className="w-64" value={text} maxLength={GLOSSARY_TERM_MAX * 2} onChange={(e) => setText(e.target.value)} />
      </div>
      <Button type="submit" size="sm" variant="outline" loading={add.isPending} disabled={text.trim() === ''}>
        {t('add')}
      </Button>
      {add.error ? <ErrorText>{errorMessage(add.error)}</ErrorText> : null}
    </form>
  );
}

// Owners and admins only: the commands and the list are theirs (meetings.glossary.add, update, remove, list); a member has no glossary screen. The list sits behind a native disclosure, closed
// at first, so the apps tab of Settings stays under the 1200 px every tab keeps (e2e/tests/settings-tabs.spec.ts).
export function GlossaryCard() {
  const t = useTranslations('glossary');
  const list = useQuery(orpc.meetings.glossary.list.queryOptions({ input: {} }));
  const terms = list.data?.terms ?? [];
  return (
    <Card role="region" aria-labelledby="glossary-title" className="block p-4" data-testid="glossary-card">
      <h2 id="glossary-title" className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer py-1 font-medium">{t('open')}</summary>
        <p className="mt-2 text-muted-foreground">{t('intro')}</p>
        <p className="mt-1 font-medium">{t('noPersonalData')}</p>
        {list.isLoading ? (
          <RowsSkeleton />
        ) : list.error ? (
          <ErrorText>{errorMessage(list.error)}</ErrorText>
        ) : (
          <>
            {terms.length === 0 ? (
              <p className="mt-3 text-muted-foreground">{t('empty')}</p>
            ) : (
              <>
                <p className="mt-3 text-xs text-muted-foreground">{t('count', { count: String(terms.length), max: String(GLOSSARY_TERMS_MAX) })}</p>
                <ul className="mt-1 divide-y">
                  {terms.map((x) => (
                    <TermRow key={x.id} term={x} />
                  ))}
                </ul>
              </>
            )}
            <NewTerm count={terms.length} />
          </>
        )}
      </details>
    </Card>
  );
}
