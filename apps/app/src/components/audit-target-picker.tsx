// SPDX-License-Identifier: AGPL-3.0-only
// The activity log's object filter (#3595): the owner types a customer's or vendor's name, a document number or a journal
// entry's words and picks what the log should show the rows of; no id to paste (a pasted id still works, for a link from
// somewhere else). The words go to the org search the command palette uses; nothing is written.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Input } from '@crove/ui/components/input';
import { client } from '../lib/api.ts';
import { auditTargetChoices, type AuditTargetChoice } from '../lib/audit.ts';
import { searchTerm } from '../lib/palette.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A short pause after the last key, so one search runs for a word and not one per letter.
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function AuditTargetPicker({ onPick }: { onPick: (choice: { id: string; label: string | null }) => void }) {
  const t = useTranslations('audit.target');
  const [text, setText] = useState('');
  // The result list closes on Escape or when focus leaves the field and the list; typing opens it again.
  const [open, setOpen] = useState(true);
  const typed = searchTerm(text);
  const term = useSettled(typed, 250);
  const found = useQuery({
    queryKey: ['audit', 'target-search', term],
    queryFn: () => client.search.query({ q: term ?? '' }),
    enabled: term !== null && term === typed,
    staleTime: 30_000,
  });
  const choices = term !== null && term === typed && found.data ? auditTargetChoices(found.data) : [];
  const change = (value: string) => {
    setText(value);
    setOpen(true);
    // An id pasted whole is used as it is.
    const pasted = value.trim();
    if (UUID.test(pasted)) onPick({ id: pasted.toLowerCase(), label: null });
  };
  const pick = (choice: AuditTargetChoice) => {
    onPick({ id: choice.id, label: choice.hint ? `${choice.label} · ${choice.hint}` : choice.label });
    setText('');
  };
  return (
    <div
      className="relative"
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <Input value={text} onChange={(e) => change(e.target.value)} placeholder={t('hint')} className="mt-1 w-72" aria-label={t('label')} />
      {typed !== null && open && (
        <div className="absolute z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-1 text-sm shadow-sm" role="status">
          {found.isError ? (
            <p className="px-2 py-1.5 text-xs text-warning">{t('failed')}</p>
          ) : term !== typed || found.isFetching ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('searching')}</p>
          ) : choices.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('none')}</p>
          ) : (
            <ul>
              {choices.map((c) => (
                <li key={c.key}>
                  <button type="button" className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none" onClick={() => pick(c)}>
                    <span className="text-foreground">
                      <span className="mr-2 text-xs text-subtle-foreground">{t(`kinds.${c.kind}`)}</span>
                      {c.label}
                    </span>
                    {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
